/**
 * Upload transport seam — how an ingest batch physically reaches the control
 * plane. INJECTABLE: the shipper depends only on `UploadTransport`; tests use
 * a mock; the wiring task picks the real implementation.
 *
 * ── Transport decision (T1-12, from reading the private api) ────────────────
 * ARCHITECTURE §1 names HTTPS batches the canonical upload path, and the
 * control plane DOES expose `POST /api/v1/ingest` — but that route
 * authenticates PAT/session callers only (`requireOrg`, the T1-04 seam); a
 * RUNNER has no PAT. The only runner-token-authenticated ingest path today is
 * the T1-06 WSS gateway: an `upload` frame on the registered `/agent/v1`
 * connection → `ingestBatch` under the runner's org → `upload_ack`.
 *
 *   ⇒ DEFAULT: `WireUploadTransport` (the WSS `upload` frame).
 *   ⇒ `HttpUploadTransport` is provided behind the same seam for when the
 *     control plane grows runner-token auth on the HTTP ingest route
 *     (server-side gap, flagged in the T1-12 report) — the two speak the SAME
 *     batch/response schema, so swapping is pure wiring.
 *
 * Results are classified for the drain loop:
 *   - ok               — the server confirmed the batch (inserted/skipped).
 *   - retryable        — offline / 5xx / timeout / not-connected: keep the
 *     chunk spooled and retry with backoff.
 *   - non-retryable    — the server REJECTED the batch (WSS NACK `error`,
 *     HTTP 4xx): retrying the same bytes cannot succeed; the chunk is set
 *     aside (never silently dropped).
 *
 * SECURITY: never log the bearer token or batch payloads; error strings carry
 * status/reason only.
 */

import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Dispatcher } from '../core/dispatcher';
import type { WireFrame } from '../core/wire';
import type { IngestBatchRequest, IngestBatchResponse } from './wire-ingest';
import { buildUploadFrame, isUploadAck, parseIngestBatchResponse } from './wire-ingest';

export type UploadResult =
  | { ok: true; ack: IngestBatchResponse }
  | { ok: false; retryable: boolean; error: string };

export interface UploadTransport {
  /** "wire" | "https" (logs only). */
  readonly name: string;
  upload(batch: IngestBatchRequest): Promise<UploadResult>;
}

// ── WSS `upload` frame transport (default) ───────────────────────────────────

/** How long to wait for the `upload_ack` before treating the connection as
 *  flapped (retryable). */
export const DEFAULT_UPLOAD_ACK_TIMEOUT_MS = 30_000;

export interface WireUploadTransportOptions {
  /**
   * Send one frame on the live agent connection; return false when not
   * online. NOTE (wiring gap, flagged): the T1-11 `AgentClient` exposes its
   * `dispatcher` but no public frame-send yet — the wiring task must provide
   * this (e.g. a tiny additive `send()` on `AgentClient`).
   */
  sendFrame(frame: WireFrame): boolean;
  /** The agent connection's dispatcher — `upload_ack` frames arrive here. */
  dispatcher: Pick<Dispatcher, 'on'>;
  clock?: Clock;
  makeId?: () => string;
  ackTimeoutMs?: number;
}

export class WireUploadTransport implements UploadTransport {
  readonly name = 'wire';

  constructor(private readonly options: WireUploadTransportOptions) {}

  upload(batch: IngestBatchRequest): Promise<UploadResult> {
    const clock = this.options.clock ?? systemClock;
    const makeId = this.options.makeId ?? (() => crypto.randomUUID());
    const timeoutMs = this.options.ackTimeoutMs ?? DEFAULT_UPLOAD_ACK_TIMEOUT_MS;

    return new Promise<UploadResult>((resolve) => {
      const id = makeId();
      let settled = false;
      let timer: unknown = null;
      let unsubscribe: () => void = () => {};
      const settle = (result: UploadResult): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clock.clearTimeout(timer);
        unsubscribe();
        resolve(result);
      };

      unsubscribe = this.options.dispatcher.on('upload_ack', (frame) => {
        if (frame.id !== id) return; // another in-flight upload's ack
        if (!isUploadAck(frame)) {
          settle({ ok: false, retryable: true, error: 'malformed upload_ack' });
          return;
        }
        if (frame.error !== undefined) {
          // Documented gateway NACK: nothing stored, not retryable.
          settle({ ok: false, retryable: false, error: `batch rejected: ${frame.error}` });
          return;
        }
        settle({ ok: true, ack: frame.ack });
      });

      if (!this.options.sendFrame(buildUploadFrame(batch, id))) {
        settle({ ok: false, retryable: true, error: 'not connected' });
        return;
      }
      timer = clock.setTimeout(
        () => settle({ ok: false, retryable: true, error: `upload_ack timeout after ${timeoutMs}ms` }),
        timeoutMs
      );
    });
  }
}

// ── HTTPS batch transport (canonical per ARCHITECTURE; server auth gap) ──────

/** The control plane's ingest route (private api `modules/runs/routes.ts`). */
export const HTTP_INGEST_PATH = '/api/v1/ingest';

/** The minimal fetch surface the transport uses (injectable in tests). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpUploadTransportOptions {
  /** Control-plane base URL, e.g. `https://pipeline.example.com`. */
  baseUrl: string;
  /** Bearer credential — SECRET, never logged. ⚠ The route currently accepts
   *  PAT/session only; runner tokens are a flagged server-side gap. */
  token: string;
  fetchImpl?: FetchLike;
  /** Override the ingest route. */
  path?: string;
}

export class HttpUploadTransport implements UploadTransport {
  readonly name = 'https';

  constructor(private readonly options: HttpUploadTransportOptions) {}

  async upload(batch: IngestBatchRequest): Promise<UploadResult> {
    const fetchImpl: FetchLike = this.options.fetchImpl ?? fetch;
    const url = new URL(this.options.baseUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + (this.options.path ?? HTTP_INGEST_PATH);

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(batch),
      });
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: `network error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (response.status >= 200 && response.status < 300) {
      let decoded: unknown = null;
      try {
        decoded = await response.json();
      } catch {
        /* fall through to the shape check */
      }
      const ack = parseIngestBatchResponse(decoded);
      if (ack === null) return { ok: false, retryable: true, error: 'malformed ingest response' };
      return { ok: true, ack };
    }
    // 4xx: the batch (or the credential) is wrong — a retry of the same bytes
    // cannot succeed. 5xx and everything else: server-side, retryable.
    if (response.status >= 400 && response.status < 500) {
      return { ok: false, retryable: false, error: `batch rejected: HTTP ${response.status}` };
    }
    return { ok: false, retryable: true, error: `HTTP ${response.status}` };
  }
}
