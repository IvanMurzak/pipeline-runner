/**
 * `McpRelay` — the optional durability relay (department-mesh d6,
 * 13-mcp-authorization.md §12.1, T26). Covers the DoD's exact wording:
 * live-forward, spool-when-network-down, drain-replays-in-order-once,
 * the spooled bytes carry NO `Authorization` header (asserted by reading
 * the spool file directly), and an expired token is re-requested — never
 * replayed — at drain time.
 */

import { describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import { MemShipperFs } from '../../tests/_shipper-helpers';
import type { FetchLike } from '../core/department-oauth';
import type { ExecutionTokenResult } from '../core/department-oauth';
import type { ExecutionTokenSource } from './execution-token-manager';
import { McpRelay } from './mcp-relay';

const SPOOL_DIR = 'C:/state/department/relay-spool';
const RESOURCE_URL = 'https://api.ai-pipeline.dev/mcp';

class FakeTokenSource implements Pick<ExecutionTokenSource, 'getToken' | 'resourceUrl'> {
  calls: string[] = [];
  script: ExecutionTokenResult[] = [];
  private counter = 0;
  url: string | null = RESOURCE_URL;

  async getToken(executionId: string): Promise<ExecutionTokenResult> {
    this.calls.push(executionId);
    const scripted = this.script.shift();
    if (scripted !== undefined) return scripted;
    this.counter += 1;
    return { ok: true, token: { accessToken: `tok-${this.counter}`, tokenType: 'Bearer', expiresAt: 1_000_000, scope: 'mesh:execution' } };
  }

  resourceUrl(): string | null {
    return this.url;
  }
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

type ScriptedResponse = 'network_error' | { status: number; body?: string };

function makeScriptedFetch(script: ScriptedResponse[] = []): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queue = [...script];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init! });
    const step = queue.shift() ?? { status: 200, body: '{}' };
    if (step === 'network_error') throw new Error('ECONNREFUSED (fake)');
    return new Response(step.body ?? '{}', { status: step.status });
  }) as FetchLike;
  return { fetchImpl, calls };
}

function makeRelay(overrides: Partial<{ tokenSource: FakeTokenSource; fetchScript: ScriptedResponse[]; logger: CaptureLogger; maxEvents: number }> = {}) {
  const fs = new MemShipperFs();
  const clock = new FakeClock();
  const logger = overrides.logger ?? new CaptureLogger();
  const tokenSource = overrides.tokenSource ?? new FakeTokenSource();
  const { fetchImpl, calls: fetchCalls } = makeScriptedFetch(overrides.fetchScript);
  const relay = new McpRelay({
    tokenSource,
    spoolDir: SPOOL_DIR,
    fs,
    fetchImpl,
    clock,
    logger,
    maxEvents: overrides.maxEvents,
  });
  return { relay, fs, clock, logger, tokenSource, fetchCalls };
}

function readSpoolChunks(fs: MemShipperFs): Array<{ name: string; raw: string; parsed: Record<string, unknown> }> {
  const names = (fs.listDir(SPOOL_DIR) ?? []).filter((e) => !e.isDirectory && e.name.endsWith('.json')).map((e) => e.name).sort();
  return names.map((name) => {
    const raw = fs.readFileText(`${SPOOL_DIR}/${name}`)!;
    return { name, raw, parsed: JSON.parse(raw) as Record<string, unknown> };
  });
}

describe('McpRelay — live forward', () => {
  test('delivers immediately, attaching the current execution token — never the caller-supplied Authorization', async () => {
    const { relay, fetchCalls } = makeRelay({ fetchScript: [{ status: 200, body: '{"ok":true}' }] });
    const result = await relay.forward({
      callId: 'call-1',
      executionId: 'exec-1',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer caller-supplied-do-not-use' },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });

    expect(result).toEqual({ ok: true, delivered: true, status: 200, body: '{"ok":true}' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(RESOURCE_URL);
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-1');
    expect(headers['content-type']).toBe('application/json');
  });

  test('a real HTTP error response (4xx/5xx) is passed through transparently, never spooled', async () => {
    const { relay, fetchCalls } = makeRelay({ fetchScript: [{ status: 500, body: 'server error' }] });
    const result = await relay.forward({ callId: 'c1', executionId: 'exec-1', method: 'POST', headers: {}, body: '{}' });
    expect(result).toEqual({ ok: true, delivered: true, status: 500, body: 'server error' });
    expect(fetchCalls).toHaveLength(1);
    expect(relay.pendingCount).toBe(0);
  });

  test('no execution token available (e.g. invalid_grant) refuses without spooling', async () => {
    const tokenSource = new FakeTokenSource();
    tokenSource.script.push({ ok: false, error: { error: 'invalid_grant' } });
    const { relay } = makeRelay({ tokenSource });
    const result = await relay.forward({ callId: 'c1', executionId: 'exec-1', method: 'POST', headers: {}, body: '{}' });
    expect(result).toEqual({ ok: false, error: 'invalid_grant' });
    expect(relay.pendingCount).toBe(0);
  });
});

describe('McpRelay — spool when the network is down (13 §12.1 / T26)', () => {
  test('a transport-level failure spools instead of failing the call', async () => {
    const { relay, fs } = makeRelay({ fetchScript: ['network_error'] });
    const result = await relay.forward({
      callId: 'call-1',
      executionId: 'exec-1',
      method: 'POST',
      headers: { authorization: 'Bearer caller-token', 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"task.update_progress"}',
    });

    expect(result).toEqual({ ok: true, delivered: false, spooled: true });
    expect(relay.pendingCount).toBe(1);

    const chunks = readSpoolChunks(fs);
    expect(chunks).toHaveLength(1);
  });

  test('the spooled bytes on disk contain NO Authorization header — asserted by reading the spool file (DoD)', async () => {
    const { relay, fs } = makeRelay({ fetchScript: ['network_error'] });
    await relay.forward({
      callId: 'call-1',
      executionId: 'exec-1',
      method: 'POST',
      headers: { Authorization: 'Bearer super-secret-caller-token', 'x-custom': 'kept' },
      body: '{"secret":"nope, just a normal body"}',
    });

    const chunks = readSpoolChunks(fs);
    expect(chunks).toHaveLength(1);
    const raw = chunks[0]!.raw;
    expect(raw.toLowerCase()).not.toContain('authorization');
    expect(raw).not.toContain('super-secret-caller-token');

    const record = (chunks[0]!.parsed.events as Array<{ payload: Record<string, unknown> }>)[0]!.payload;
    expect(record.headers).toEqual({ 'x-custom': 'kept' }); // authorization stripped, other headers kept
    expect(record.body).toBe('{"secret":"nope, just a normal body"}');
  });
});

describe('McpRelay — drain (replay on recovery)', () => {
  test('replays spooled calls in order, removing each from the spool once delivered', async () => {
    const tokenSource = new FakeTokenSource();
    const { relay, fs } = makeRelay({ tokenSource, fetchScript: ['network_error', 'network_error', 'network_error'] });

    await relay.forward({ callId: 'c1', executionId: 'exec-1', method: 'POST', headers: {}, body: 'body-1' });
    await relay.forward({ callId: 'c2', executionId: 'exec-1', method: 'POST', headers: {}, body: 'body-2' });
    await relay.forward({ callId: 'c3', executionId: 'exec-2', method: 'POST', headers: {}, body: 'body-3' });
    expect(relay.pendingCount).toBe(3);

    // Network recovers — drain through a FRESH relay pointed at the same
    // on-disk spool (mirrors a real process: the next drain() call, or a
    // restart, sees a live network and replays what is on disk).
    const drained = await drainWithFetch(fs, tokenSource, [{ status: 200 }, { status: 200 }, { status: 200 }]);
    expect(drained.delivered).toBe(3);
    expect(drained.remaining).toBe(0);
    expect(drained.bodiesInOrder).toEqual(['body-1', 'body-2', 'body-3']);
  });

  test('a token expired during the outage is RE-REQUESTED at drain time, not replayed', async () => {
    const tokenSource = new FakeTokenSource();
    const { relay, fs } = makeRelay({ tokenSource, fetchScript: ['network_error'] });
    await relay.forward({ callId: 'c1', executionId: 'exec-1', method: 'POST', headers: {}, body: 'body-1' });
    const callsAtForwardTime = tokenSource.calls.length;

    // getToken() is the freshness authority (ExecutionTokenManager re-requests
    // transparently on expiry) — McpRelay's obligation is simply to call it
    // AGAIN at drain time rather than caching/replaying anything itself.
    // Script a DIFFERENT ("renewed") token for the drain-time call.
    tokenSource.script.push({ ok: true, token: { accessToken: 'renewed-token', tokenType: 'Bearer', expiresAt: 2_000_000, scope: 'mesh:execution' } });

    const { calls: drainFetchCalls } = await drainAndCapture(fs, tokenSource, [{ status: 200 }]);
    expect(tokenSource.calls.length).toBeGreaterThan(callsAtForwardTime); // a fresh getToken() call happened at drain
    expect(drainFetchCalls).toHaveLength(1);
    const headers = drainFetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer renewed-token');
  });

  test('stops at the first failure, preserving order — no duplicate delivery across two drain() calls', async () => {
    const tokenSource = new FakeTokenSource();
    const first = makeRelay({ tokenSource, fetchScript: ['network_error', 'network_error', 'network_error'] });
    await first.relay.forward({ callId: 'c1', executionId: 'exec-1', method: 'POST', headers: {}, body: 'body-1' });
    await first.relay.forward({ callId: 'c2', executionId: 'exec-1', method: 'POST', headers: {}, body: 'body-2' });
    await first.relay.forward({ callId: 'c3', executionId: 'exec-1', method: 'POST', headers: {}, body: 'body-3' });

    const seen: string[] = [];

    // First drain: call1 succeeds, call2 fails (network), call3 never attempted.
    const drain1 = await drainScripted(first.fs, tokenSource, (body) => {
      seen.push(body);
      return body === 'body-1' ? { status: 200 } : 'network_error';
    });
    expect(drain1.delivered).toBe(1);
    expect(drain1.remaining).toBe(2);
    expect(seen).toEqual(['body-1', 'body-2']); // body-3 never attempted — order preserved

    // Second drain: everything now succeeds.
    seen.length = 0;
    const drain2 = await drainScripted(first.fs, tokenSource, (body) => {
      seen.push(body);
      return { status: 200 };
    });
    expect(drain2.delivered).toBe(2);
    expect(drain2.remaining).toBe(0);
    expect(seen).toEqual(['body-2', 'body-3']); // body-1 NEVER retried — no duplicate delivery
  });

  test('a non-retryable (4xx) rejection is set aside, and draining continues past it', async () => {
    const tokenSource = new FakeTokenSource();
    const first = makeRelay({ tokenSource, fetchScript: ['network_error', 'network_error'] });
    await first.relay.forward({ callId: 'bad', executionId: 'exec-1', method: 'POST', headers: {}, body: 'bad-body' });
    await first.relay.forward({ callId: 'good', executionId: 'exec-1', method: 'POST', headers: {}, body: 'good-body' });

    const seen: string[] = [];
    const result = await drainScripted(first.fs, tokenSource, (body) => {
      seen.push(body);
      return body === 'bad-body' ? { status: 400, body: 'bad request' } : { status: 200 };
    });

    expect(result.delivered).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.remaining).toBe(0);
    expect(seen).toEqual(['bad-body', 'good-body']);

    // The rejected chunk is kept on disk, set aside (never silently dropped).
    const rejectedNames = (first.fs.listDir(SPOOL_DIR) ?? []).filter((e) => e.name.endsWith('.rejected'));
    expect(rejectedNames.length).toBe(1);
  });
});

describe('secrets discipline', () => {
  test('never logs a token or an Authorization header value, across forward + spool + drain', async () => {
    const logger = new CaptureLogger();
    const tokenSource = new FakeTokenSource();
    const SECRET_CALLER_TOKEN = 'Bearer caller-secret-abc';
    const { relay, fs } = makeRelay({ tokenSource, logger, fetchScript: ['network_error'] });

    await relay.forward({ callId: 'c1', executionId: 'exec-1', method: 'POST', headers: { authorization: SECRET_CALLER_TOKEN }, body: 'b' });
    await drainAndCapture(fs, tokenSource, [{ status: 200 }], logger);

    for (const line of logger.lines) {
      expect(line).not.toContain('caller-secret-abc');
      expect(line).not.toContain('tok-1');
      expect(line).not.toContain('Bearer ');
    }
  });
});

// ── Drain helpers — construct a fresh McpRelay pointed at the SAME on-disk
//    spool (same `fs` + `spoolDir`) with a NEW scripted fetch, so a drain's
//    fetch behaviour can be scripted independently of whatever forward()
//    used. Mirrors how a real process restart (or a later drain() call)
//    would reuse the durable spool with a fresh network attempt. ───────────

function relayOnSameSpool(fs: MemShipperFs, tokenSource: FakeTokenSource, fetchImpl: FetchLike, logger?: CaptureLogger): McpRelay {
  return new McpRelay({ tokenSource, spoolDir: SPOOL_DIR, fs, fetchImpl, logger });
}

async function drainAndCapture(fs: MemShipperFs, tokenSource: FakeTokenSource, script: ScriptedResponse[], logger?: CaptureLogger) {
  const { fetchImpl, calls } = makeScriptedFetch(script);
  const relay = relayOnSameSpool(fs, tokenSource, fetchImpl, logger);
  const summary = await relay.drain();
  return { summary, calls };
}

async function drainWithFetch(fs: MemShipperFs, tokenSource: FakeTokenSource, script: ScriptedResponse[]) {
  const { fetchImpl, calls } = makeScriptedFetch(script);
  const relay = relayOnSameSpool(fs, tokenSource, fetchImpl);
  const summary = await relay.drain();
  const bodiesInOrder = calls.map((c) => c.init.body as string);
  return { ...summary, bodiesInOrder };
}

/** Drain with a fetch whose response is computed PER-CALL from the request
 *  body — lets a test express "this specific call fails, that one succeeds"
 *  without pre-knowing call order. */
async function drainScripted(
  fs: MemShipperFs,
  tokenSource: FakeTokenSource,
  respond: (body: string) => ScriptedResponse
): Promise<{ delivered: number; rejected: number; remaining: number }> {
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = (init?.body as string) ?? '';
    const step = respond(body);
    if (step === 'network_error') throw new Error('ECONNREFUSED (fake)');
    return new Response(step.body ?? '{}', { status: step.status });
  }) as FetchLike;
  const relay = relayOnSameSpool(fs, tokenSource, fetchImpl);
  return relay.drain();
}
