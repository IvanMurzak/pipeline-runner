import { describe, expect, test } from 'bun:test';
import {
  agentWsUrl,
  LONG_POLL_PATH,
  LongPollTransport,
  WebSocketTransport,
  type TransportEvents,
  type WebSocketLike,
} from '../src/core/transport';
import type { WireFrame } from '../src/core/wire';
import { CaptureLogger, tick } from './_helpers';

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, Array<(event: never) => void>>();
  sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emit('close', {});
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function collectEvents() {
  const opens: number[] = [];
  const frames: WireFrame[] = [];
  const closes: Array<{ error?: string }> = [];
  const events: TransportEvents = {
    onOpen: () => opens.push(1),
    onFrame: (frame) => frames.push(frame),
    onClose: (info) => closes.push(info),
  };
  return { events, opens, frames, closes };
}

/** Scriptable fetch: every call is captured and resolved manually. */
class FetchScript {
  calls: Array<{
    url: string;
    body: { frames: WireFrame[] };
    resolve: (response: Response) => void;
    reject: (error: unknown) => void;
  }> = [];

  readonly impl = ((url: unknown, init?: { body?: unknown }) =>
    new Promise<Response>((resolve, reject) => {
      this.calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as { frames: WireFrame[] },
        resolve,
        reject,
      });
    })) as unknown as typeof fetch;

  respond(index: number, payload: unknown, status = 200): void {
    this.calls[index]!.resolve(new Response(JSON.stringify(payload), { status }));
  }
}

// ── WSS transport ────────────────────────────────────────────────────────────

describe('agentWsUrl', () => {
  test('maps http(s) to ws(s) and appends the channel path', () => {
    expect(agentWsUrl('https://cp.example.com')).toBe('wss://cp.example.com/agent/v1');
    expect(agentWsUrl('http://localhost:8080')).toBe('ws://localhost:8080/agent/v1');
    expect(agentWsUrl('https://cp.example.com/')).toBe('wss://cp.example.com/agent/v1');
    expect(agentWsUrl('wss://cp.example.com')).toBe('wss://cp.example.com/agent/v1');
  });
});

describe('WebSocketTransport', () => {
  function makeTransport(logger = new CaptureLogger()) {
    FakeWebSocket.instances = [];
    const transport = new WebSocketTransport('https://cp.example.com', {
      factory: (url) => new FakeWebSocket(url),
      logger,
    });
    return { transport, logger };
  }

  test('opens against the derived /agent/v1 URL and surfaces open/frame/close', () => {
    const { transport } = makeTransport();
    const { events, opens, frames, closes } = collectEvents();
    const connection = transport.open(events);
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toBe('wss://cp.example.com/agent/v1');

    socket.emit('open', {});
    expect(opens).toHaveLength(1);

    connection.send({ type: 'register', id: 'r1' });
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'register', id: 'r1' });

    socket.emit('message', { data: JSON.stringify({ type: 'register_ack', runner_id: 'r-1', protocol_version: 1 }) });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe('register_ack');

    socket.emit('close', { reason: 'bye' });
    expect(closes).toEqual([{ error: 'bye' }]);
  });

  test('malformed inbound payloads are dropped, never delivered', () => {
    const { transport, logger } = makeTransport();
    const { events, frames } = collectEvents();
    transport.open(events);
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open', {});
    socket.emit('message', { data: 'not json{{' });
    socket.emit('message', { data: JSON.stringify({ no_type: true }) });
    socket.emit('message', { data: JSON.stringify([1, 2, 3]) });
    expect(frames).toHaveLength(0);
    expect(logger.joined()).toContain('non-JSON frame ignored');
    expect(logger.joined()).toContain('malformed frame ignored');
  });

  test('onClose fires at most once (error then close dedupes)', () => {
    const { transport } = makeTransport();
    const { events, closes } = collectEvents();
    transport.open(events);
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('error', {});
    socket.emit('close', {});
    socket.emit('close', {});
    expect(closes).toHaveLength(1);
  });

  test('a throwing factory surfaces failure-to-establish as an async onClose', async () => {
    const transport = new WebSocketTransport('https://cp.example.com', {
      factory: () => {
        throw new Error('no network');
      },
    });
    const { events, closes, opens } = collectEvents();
    transport.open(events);
    expect(closes).toHaveLength(0); // async, like a real socket
    await tick();
    expect(closes).toEqual([{ error: 'no network' }]);
    expect(opens).toHaveLength(0);
  });

  test('local close() closes the socket', () => {
    const { transport } = makeTransport();
    const { events, closes } = collectEvents();
    const connection = transport.open(events);
    const socket = FakeWebSocket.instances[0]!;
    socket.emit('open', {});
    connection.close();
    expect(socket.closed).toBe(true);
    expect(closes).toHaveLength(1);
  });
});

// ── Long-poll transport (PROVISIONAL server route — seam test vs mock fetch) ─

describe('LongPollTransport', () => {
  function makeTransport() {
    const script = new FetchScript();
    const logger = new CaptureLogger();
    const transport = new LongPollTransport('https://cp.example.com', { fetchImpl: script.impl, logger });
    return { transport, script, logger };
  }

  test('opens (async), POSTs queued outbound frames to the provisional route, delivers inbound frames', async () => {
    const { transport, script } = makeTransport();
    const { events, opens, frames } = collectEvents();
    const connection = transport.open(events);
    connection.send({ type: 'register', id: 'r1' }); // queued before the loop starts
    await tick();
    expect(opens).toHaveLength(1);
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]!.url).toBe(`https://cp.example.com${LONG_POLL_PATH}`);
    expect(script.calls[0]!.body.frames).toEqual([{ type: 'register', id: 'r1' }]);

    script.respond(0, { frames: [{ type: 'register_ack', runner_id: 'r-1', protocol_version: 1 }, { bad: 'frame' }] });
    await tick();
    expect(frames).toHaveLength(1); // the malformed one was dropped
    expect(frames[0]!.type).toBe('register_ack');
    expect(script.calls).toHaveLength(2); // the loop long-polls again
    connection.close();
  });

  test('frames sent between cycles ride the next POST', async () => {
    const { transport, script } = makeTransport();
    const { events } = collectEvents();
    const connection = transport.open(events);
    await tick();
    connection.send({ type: 'heartbeat', id: 'h1', runner_id: 'r-1' });
    script.respond(0, { frames: [] });
    await tick();
    expect(script.calls[1]!.body.frames).toEqual([{ type: 'heartbeat', id: 'h1', runner_id: 'r-1' }]);
    connection.close();
  });

  test('an HTTP error ends the transport with onClose', async () => {
    const { transport, script } = makeTransport();
    const { events, closes } = collectEvents();
    transport.open(events);
    await tick();
    script.respond(0, {}, 503);
    await tick();
    expect(closes).toEqual([{ error: 'HTTP 503' }]);
    expect(script.calls).toHaveLength(1); // loop stopped
  });

  test('a network failure ends the transport with onClose', async () => {
    const { transport, script } = makeTransport();
    const { events, closes } = collectEvents();
    transport.open(events);
    await tick();
    script.calls[0]!.reject(new Error('ECONNREFUSED'));
    await tick();
    expect(closes).toHaveLength(1);
    expect(closes[0]!.error).toContain('ECONNREFUSED');
  });

  test('local close() stops the loop and surfaces one onClose (WebSocket-symmetric)', async () => {
    const { transport, script } = makeTransport();
    const { events, closes } = collectEvents();
    const connection = transport.open(events);
    await tick();
    connection.close();
    await tick();
    expect(closes).toHaveLength(1);
    script.respond(0, { frames: [{ type: 'late_frame' }] }); // the in-flight poll returns late
    await tick();
    expect(closes).toHaveLength(1); // still exactly one close, no late delivery crash
  });
});
