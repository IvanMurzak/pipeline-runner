/**
 * Upload transport seam tests: the WSS `upload` frame transport (ack
 * correlation, NACK, timeout, not-connected) against a mock frame sender +
 * real dispatcher, and the HTTPS transport against a mock fetch (auth header,
 * status classification, token hygiene).
 */

import { describe, expect, test } from 'bun:test';
import { Dispatcher } from '../src/core/dispatcher';
import type { WireFrame } from '../src/core/wire';
import { HttpUploadTransport, WireUploadTransport } from '../src/shipper/upload-transport';
import type { IngestBatchRequest } from '../src/shipper/wire-ingest';
import { FakeClock } from './_helpers';

const BATCH: IngestBatchRequest = { run_id: 'run-A', events: [{ seq: 1, payload: { type: 'run.started' } }] };

function makeWire(sendResult = true) {
  const clock = new FakeClock();
  const dispatcher = new Dispatcher();
  const sent: WireFrame[] = [];
  let ids = 0;
  const transport = new WireUploadTransport({
    sendFrame: (frame) => {
      if (sendResult) sent.push(frame);
      return sendResult;
    },
    dispatcher,
    clock,
    makeId: () => `id-${++ids}`,
    ackTimeoutMs: 5000,
  });
  return { transport, dispatcher, sent, clock };
}

describe('WireUploadTransport (WSS upload frame — the default)', () => {
  test('sends the upload frame and resolves ok on the correlated upload_ack', async () => {
    const { transport, dispatcher, sent } = makeWire();
    const pending = transport.upload(BATCH);
    expect(sent).toEqual([{ type: 'upload', id: 'id-1', batch: BATCH }]);

    // A stale ack for some other upload is ignored…
    dispatcher.dispatch({ type: 'upload_ack', id: 'other', ack: { run_id: 'run-A', inserted: 0, skipped: 1 } });
    // …the matching one settles the upload.
    dispatcher.dispatch({ type: 'upload_ack', id: 'id-1', ack: { run_id: 'run-A', inserted: 1, skipped: 0 } });
    const result = await pending;
    expect(result).toEqual({ ok: true, ack: { run_id: 'run-A', inserted: 1, skipped: 0 } });
  });

  test('a NACK (upload_ack with error) is non-retryable', async () => {
    const { transport, dispatcher } = makeWire();
    const pending = transport.upload(BATCH);
    dispatcher.dispatch({
      type: 'upload_ack',
      id: 'id-1',
      ack: { run_id: 'run-A', inserted: 0, skipped: 0 },
      error: 'unknown project_id',
    });
    const result = await pending;
    expect(result).toEqual({ ok: false, retryable: false, error: 'batch rejected: unknown project_id' });
  });

  test('an unanswered upload times out as retryable (WSS flap)', async () => {
    const { transport, clock } = makeWire();
    const pending = transport.upload(BATCH);
    clock.advance(5000);
    const result = await pending;
    expect(result).toEqual({ ok: false, retryable: true, error: 'upload_ack timeout after 5000ms' });
  });

  test('not connected resolves immediately as retryable', async () => {
    const { transport } = makeWire(false);
    const result = await transport.upload(BATCH);
    expect(result).toEqual({ ok: false, retryable: true, error: 'not connected' });
  });

  test('a malformed upload_ack is retryable, and the handler unsubscribes after settling', async () => {
    const { transport, dispatcher, clock } = makeWire();
    const pending = transport.upload(BATCH);
    dispatcher.dispatch({ type: 'upload_ack', id: 'id-1', ack: { run_id: '', inserted: -1 } as never });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(true);
    // After settling, no handler remains: the same frame routes to nobody.
    expect(dispatcher.dispatch({ type: 'upload_ack', id: 'id-1', ack: { run_id: 'r', inserted: 0, skipped: 0 } })).toBe(false);
    expect(clock.pendingCount).toBe(0); // ack timer cleaned up
  });
});

describe('HttpUploadTransport (canonical HTTPS batch; server auth gap flagged)', () => {
  const TOKEN = 'pat-SECRET-token';

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  test('POSTs the batch to /api/v1/ingest with the bearer credential and parses the ack', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const transport = new HttpUploadTransport({
      baseUrl: 'https://pipeline.example.com',
      token: TOKEN,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return jsonResponse(200, { run_id: 'run-A', inserted: 1, skipped: 0 });
      },
    });
    const result = await transport.upload(BATCH);
    expect(result).toEqual({ ok: true, ack: { run_id: 'run-A', inserted: 1, skipped: 0 } });
    expect(calls[0]!.url).toBe('https://pipeline.example.com/api/v1/ingest');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(BATCH);
  });

  test('classifies statuses: 4xx non-retryable, 5xx retryable, network retryable, bad body retryable', async () => {
    const cases: Array<{ response: () => Response | Promise<Response>; retryable: boolean }> = [
      { response: () => jsonResponse(400, { error: 'bad batch' }), retryable: false },
      { response: () => jsonResponse(401, { error: 'unauthorized' }), retryable: false },
      { response: () => jsonResponse(503, { error: 'down' }), retryable: true },
      { response: () => Promise.reject(new Error('ECONNREFUSED')), retryable: true },
      { response: () => new Response('not json', { status: 200 }), retryable: true },
    ];
    for (const { response, retryable } of cases) {
      const transport = new HttpUploadTransport({
        baseUrl: 'https://pipeline.example.com',
        token: TOKEN,
        fetchImpl: async () => response(),
      });
      const result = await transport.upload(BATCH);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.retryable).toBe(retryable);
        // Token hygiene: the classification string never carries the secret.
        expect(result.error).not.toContain(TOKEN);
      }
    }
  });
});
