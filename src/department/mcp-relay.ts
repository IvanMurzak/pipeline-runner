/**
 * `McpRelay` — the OPTIONAL durability relay (department-mesh task d6;
 * `13-mcp-authorization.md` §12.1, threat T26). A department runtime MAY
 * call `/mcp` directly; it MAY instead be configured to route through this
 * relay, which forwards upstream live and — the property a direct HTTPS
 * call cannot offer — SPOOLS TO DISK when the network is down, replaying in
 * order once it recovers.
 *
 * ── Reuses `../shipper/spool.ts` LITERALLY, not just its design ─────────────
 * `Spool` is generic enough on the wire already: `IngestBatchRequest` is
 * `{ run_id: string, events: [{ seq, payload }] }` with `payload: unknown`
 * (`../shipper/wire-ingest.ts`). One relay call becomes one batch — `run_id`
 * is the `executionId`, the single event's `payload` is a `SpooledRelayCall`
 * — so this module durably queues through the EXACT SAME numbered-chunk,
 * drop-oldest-capped, `.rejected`-set-aside on-disk implementation the
 * shipper already has, in its own directory (never the shipper's), with ZERO
 * modification to `spool.ts` and zero regression risk to its existing tests.
 *
 * ── The load-bearing security property (T26) ─────────────────────────────
 * `forward()` NEVER writes the caller-supplied `Authorization` header to
 * disk — it is stripped before the record is constructed, full stop, whether
 * the call is delivered live or spooled. Both `forward()`'s live path and
 * `drain()`'s replay path pull the CURRENT execution token from
 * `ExecutionTokenSource.getToken()` (an in-memory cache, `./execution-token-manager.ts`)
 * at send time — never from anything persisted. `getToken()` already
 * re-requests transparently when its cached token is expired, so "a token
 * expired during the outage is re-requested, not replayed" falls out of
 * this module doing nothing token-related itself beyond calling it.
 *
 * This is a TRANSPORT PROXY, not a resource server (13 §12.1's closing
 * note): it never validates, decodes, or acts on the MCP payload it
 * carries — `body` is opaque bytes in, opaque bytes out.
 */

import { join } from 'node:path';
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { FetchLike } from '../core/department-oauth';
import type { ShipperFileSystem } from '../shipper/fs';
import { Spool } from '../shipper/spool';
import type { IngestBatchRequest } from '../shipper/wire-ingest';
import type { ExecutionTokenSource } from './execution-token-manager';

/** One queued call, exactly as persisted to disk (the spool chunk's single
 *  event `payload`). `headers` here is ALREADY authorization-stripped by the
 *  time this type is ever constructed — see `stripAuthorization` below. */
export interface SpooledRelayCall {
  callId: string;
  executionId: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  queuedAt: string;
}

export interface RelayCallRequest {
  /** Caller-assigned idempotency identity (e.g. the MCP JSON-RPC request
   *  `id`) — carried through for logging/diagnostics; delivery-once is
   *  enforced structurally (a chunk is removed from the spool only after a
   *  confirmed response), not by this id. */
  callId: string;
  executionId: string;
  /** HTTP method for the upstream call — always `POST` for `/mcp` today,
   *  kept explicit rather than hard-coded. */
  method: string;
  /** As the caller supplied it. Any `authorization`/`Authorization` entry is
   *  IGNORED and stripped — this relay never passes a caller's token
   *  through; it always substitutes the current execution token. */
  headers: Record<string, string>;
  body: string;
}

export type RelayForwardResult =
  | { ok: true; delivered: true; status: number; body: string }
  | { ok: true; delivered: false; spooled: true }
  | { ok: false; error: string };

export interface RelayDrainSummary {
  delivered: number;
  rejected: number;
  remaining: number;
}

export interface McpRelayOptions {
  tokenSource: Pick<ExecutionTokenSource, 'getToken' | 'resourceUrl'>;
  /** Directory the spool's numbered chunks live under — MUST be distinct
   *  from the shipper's own spool dir (`../shipper/shipper.ts`'s wiring);
   *  `./manager.ts` roots this under `<dataDir>/department/relay-spool`. */
  spoolDir: string;
  fs: ShipperFileSystem;
  fetchImpl?: FetchLike;
  clock?: Clock;
  logger?: Logger;
  /** Forwarded to `Spool`'s own cap (`../shipper/spool.ts`'s
   *  `DEFAULT_SPOOL_MAX_EVENTS`) — one relay call counts as one "event". */
  maxEvents?: number;
}

function stripAuthorization(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') continue;
    out[key] = value;
  }
  return out;
}

export class McpRelay {
  private readonly tokenSource: Pick<ExecutionTokenSource, 'getToken' | 'resourceUrl'>;
  private readonly spool: Spool;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private seqCounter = 0;

  constructor(options: McpRelayOptions) {
    this.tokenSource = options.tokenSource;
    this.spool = new Spool(options.fs, options.spoolDir, options.maxEvents);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
  }

  /** Pending (not-yet-delivered) call count — diagnostics/tests. */
  get pendingCount(): number {
    return this.spool.eventCount;
  }

  /**
   * Forward one call. Tries live delivery first; a genuine transport failure
   * (the network is down, not a real HTTP response) spools it — with
   * `Authorization` already stripped — for `drain()` to replay later.
   */
  async forward(request: RelayCallRequest): Promise<RelayForwardResult> {
    const tokenResult = await this.tokenSource.getToken(request.executionId);
    if (!tokenResult.ok) {
      this.logger.warn(
        `mcp-relay: forward for execution ${request.executionId} refused — no execution token (${tokenResult.error.error})`
      );
      return { ok: false, error: tokenResult.error.error };
    }

    const strippedHeaders = stripAuthorization(request.headers);
    const attempt = await this.deliverLive(request.method, strippedHeaders, request.body, tokenResult.token.accessToken);
    if (attempt.kind === 'delivered') {
      return { ok: true, delivered: true, status: attempt.status, body: attempt.body };
    }
    // Network-level failure only — a real HTTP response (even 4xx/5xx) is
    // "delivered" above and passed through verbatim; it is never spooled.
    this.spoolCall({ ...request, headers: strippedHeaders });
    this.logger.warn(`mcp-relay: execution ${request.executionId} call ${request.callId} spooled — network unreachable (${attempt.error})`);
    return { ok: true, delivered: false, spooled: true };
  }

  /**
   * Replay every spooled call, oldest first, re-attaching a CURRENT
   * execution token at send time (never the one — there never was one — on
   * disk). Stops at the first delivery failure so ORDER and NO-DUPLICATE-
   * DELIVERY both hold: everything before the stopping point is confirmed
   * removed from the spool; everything from it onward is untouched and will
   * be retried, in the same order, on the next `drain()` call. A call the
   * server explicitly rejects (4xx) is set aside via `Spool.reject` (kept on
   * disk for forensics, never silently dropped) and draining continues.
   */
  async drain(): Promise<RelayDrainSummary> {
    let delivered = 0;
    let rejected = 0;
    for (;;) {
      const chunk = this.spool.oldest();
      if (chunk === null) break;
      const record = extractRecord(chunk.batch);
      if (record === null) {
        this.logger.warn(`mcp-relay: spool chunk ${chunk.name} is corrupt — discarding`);
        this.spool.remove(chunk.name);
        continue;
      }

      const tokenResult = await this.tokenSource.getToken(record.executionId);
      if (!tokenResult.ok) {
        this.logger.warn(
          `mcp-relay: drain paused at execution ${record.executionId} call ${record.callId} — no execution token (${tokenResult.error.error})`
        );
        break; // preserve order — retry from here on the next drain()
      }

      const attempt = await this.deliverLive(record.method, record.headers, record.body, tokenResult.token.accessToken);
      if (attempt.kind === 'delivered' && attempt.status >= 200 && attempt.status < 300) {
        this.spool.remove(chunk.name);
        delivered += 1;
        continue;
      }
      if (attempt.kind === 'delivered' && attempt.status >= 400 && attempt.status < 500) {
        this.logger.warn(`mcp-relay: execution ${record.executionId} call ${record.callId} rejected (HTTP ${attempt.status}) — set aside`);
        this.spool.reject(chunk.name);
        rejected += 1;
        continue;
      }
      // 5xx or a network-level failure — stop; preserve order for retry.
      this.logger.warn(
        `mcp-relay: drain paused at execution ${record.executionId} call ${record.callId} — ${
          attempt.kind === 'delivered' ? `upstream HTTP ${attempt.status}` : attempt.error
        }`
      );
      break;
    }
    return { delivered, rejected, remaining: this.spool.chunkCount };
  }

  private spoolCall(call: { callId: string; executionId: string; method: string; headers: Record<string, string>; body: string }): void {
    const record: SpooledRelayCall = {
      callId: call.callId,
      executionId: call.executionId,
      method: call.method,
      headers: call.headers, // ALREADY stripped by the caller (forward()) — never re-checked here, single source of truth
      body: call.body,
      queuedAt: new Date(this.clock.now()).toISOString(),
    };
    this.seqCounter += 1;
    const batch: IngestBatchRequest = {
      run_id: call.executionId,
      events: [{ seq: this.seqCounter, payload: record }],
    };
    const { dropped } = this.spool.append(batch);
    for (const drop of dropped) {
      this.logger.error(
        `mcp-relay: spool cap exceeded — dropped ${drop.eventCount} queued call(s) for execution ${drop.runId} (chunk ${drop.name})`
      );
    }
  }

  private async deliverLive(
    method: string,
    headers: Record<string, string>,
    body: string,
    accessToken: string
  ): Promise<{ kind: 'delivered'; status: number; body: string } | { kind: 'network_error'; error: string }> {
    const url = this.tokenSource.resourceUrl();
    if (url === null) return { kind: 'network_error', error: 'no resource url — runner is not registered yet' };
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: { ...headers, authorization: `Bearer ${accessToken}` },
        body,
      });
      const text = await response.text().catch(() => '');
      return { kind: 'delivered', status: response.status, body: text };
    } catch (err) {
      return { kind: 'network_error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function extractRecord(batch: IngestBatchRequest): SpooledRelayCall | null {
  const payload = batch.events[0]?.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const r = payload as Record<string, unknown>;
  if (
    typeof r.callId !== 'string' ||
    typeof r.executionId !== 'string' ||
    typeof r.method !== 'string' ||
    typeof r.body !== 'string' ||
    typeof r.headers !== 'object' ||
    r.headers === null
  ) {
    return null;
  }
  return {
    callId: r.callId,
    executionId: r.executionId,
    method: r.method,
    headers: r.headers as Record<string, string>,
    body: r.body,
    queuedAt: typeof r.queuedAt === 'string' ? r.queuedAt : '',
  };
}

/** Directory helper — `./manager.ts` roots the relay spool alongside the
 *  execution journal, under the DATA dir (never the shipper's own spool
 *  dir, never a tailed project). */
export function defaultRelaySpoolDir(dataDir: string): string {
  return join(dataDir, 'department', 'relay-spool');
}
