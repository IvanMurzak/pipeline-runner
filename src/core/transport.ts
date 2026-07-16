/**
 * Transport seam: how frames physically reach the control plane.
 *
 * The connection manager (`connection.ts`) speaks only the small `Transport` /
 * `TransportConnection` interfaces below, tried IN ORDER — WSS primary,
 * long-poll fallback — so "WSS can't establish" falls through to the next
 * transport in the same attempt without the state machine knowing transport
 * details.
 *
 *   - `WebSocketTransport` — the primary: Bun's global `WebSocket` against
 *     `${baseUrl}/agent/v1` (http(s) → ws(s)). Factory-injectable for tests.
 *   - `LongPollTransport` — the fallback. ⚠ PROVISIONAL: the server-side
 *     long-poll endpoint does NOT exist yet (`packages/protocol` and
 *     ARCHITECTURE define only the WSS channel). The route below
 *     (`POST ${baseUrl}/agent/v1/poll`, body `{ frames: [...] }` out,
 *     response `{ frames: [...] }` in) is a placeholder wire-compatible
 *     framing — revisit when the control plane grows the endpoint. The
 *     `fetch` implementation is injectable; unit tests exercise the seam
 *     against a mock.
 *
 * Both transports deliver only frames that pass `parseWireFrame` (inbound is
 * untrusted); malformed payloads are logged and dropped, never thrown into
 * the socket loop.
 */

import type { Logger } from './log';
import { nullLogger } from './log';
import type { WireFrame } from './wire';
import { parseWireFrame } from './wire';

/** The `/agent/v1` channel path (ARCHITECTURE §Topology). */
export const AGENT_CHANNEL_PATH = '/agent/v1';

/** PROVISIONAL long-poll route — no server counterpart yet (see module doc). */
export const LONG_POLL_PATH = '/agent/v1/poll';

export interface TransportEvents {
  /** The transport is established; the connection sends `register` now. */
  onOpen(): void;
  /** A validated inbound frame. */
  onFrame(frame: WireFrame): void;
  /** The transport ended (failure to establish, drop, or local close). Fired at most once. */
  onClose(info: { error?: string }): void;
}

export interface TransportConnection {
  send(frame: WireFrame): void;
  close(): void;
}

export interface Transport {
  /** "wss" | "long-poll" (used in logs and fallback messages). */
  readonly name: string;
  open(events: TransportEvents): TransportConnection;
}

/** Derive the WSS channel URL from the control-plane base URL. */
export function agentWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  // ws:/wss: pass through unchanged.
  url.pathname = url.pathname.replace(/\/$/, '') + AGENT_CHANNEL_PATH;
  return url.toString();
}

/** The subset of the WebSocket API the transport uses (factory-injectable). */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultWebSocketFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

export class WebSocketTransport implements Transport {
  readonly name = 'wss';

  constructor(
    private readonly baseUrl: string,
    private readonly options: { factory?: WebSocketFactory; logger?: Logger } = {}
  ) {}

  open(events: TransportEvents): TransportConnection {
    const logger = this.options.logger ?? nullLogger;
    const factory = this.options.factory ?? defaultWebSocketFactory;
    let closed = false;
    const closeOnce = (info: { error?: string }) => {
      if (closed) return;
      closed = true;
      events.onClose(info);
    };

    let socket: WebSocketLike;
    try {
      socket = factory(agentWsUrl(this.baseUrl));
    } catch (err) {
      queueMicrotask(() => closeOnce({ error: err instanceof Error ? err.message : String(err) }));
      return { send: () => {}, close: () => {} };
    }

    socket.addEventListener('open', () => {
      if (!closed) events.onOpen();
    });
    socket.addEventListener('message', (event: never) => {
      const data = (event as { data?: unknown }).data;
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(data));
      } catch {
        logger.warn('non-JSON frame ignored');
        return;
      }
      const frame = parseWireFrame(decoded);
      if (frame === null) {
        logger.warn('malformed frame ignored');
        return;
      }
      if (!closed) events.onFrame(frame);
    });
    socket.addEventListener('close', (event: never) => {
      const reason = (event as { reason?: unknown }).reason;
      closeOnce({ error: typeof reason === 'string' && reason.length > 0 ? reason : undefined });
    });
    socket.addEventListener('error', () => {
      // A 'close' event follows an error; closeOnce dedupes.
    });

    return {
      send: (frame) => socket.send(JSON.stringify(frame)),
      close: () => {
        try {
          socket.close(1000);
        } catch {
          // Closing an unopened socket may throw in some impls — close is best-effort.
        }
      },
    };
  }
}

export interface LongPollOptions {
  fetchImpl?: typeof fetch;
  /** Override the PROVISIONAL poll route. */
  pollPath?: string;
  logger?: Logger;
}

export class LongPollTransport implements Transport {
  readonly name = 'long-poll';

  constructor(
    private readonly baseUrl: string,
    private readonly options: LongPollOptions = {}
  ) {}

  open(events: TransportEvents): TransportConnection {
    const logger = this.options.logger ?? nullLogger;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = new URL(this.baseUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + (this.options.pollPath ?? LONG_POLL_PATH);

    let closed = false;
    const outbound: WireFrame[] = [];
    const closeOnce = (info: { error?: string }) => {
      if (closed) return;
      closed = true;
      events.onClose(info);
    };

    const loop = async (): Promise<void> => {
      while (!closed) {
        // NOTE (provisional framing): each cycle POSTs the queued outbound
        // frames and long-polls the response for inbound frames. Outbound
        // frames enqueued mid-poll wait for the current cycle to return — a
        // real server-side endpoint may want a separate send channel.
        const body = JSON.stringify({ frames: outbound.splice(0) });
        let response: Response;
        try {
          response = await fetchImpl(url.toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
        } catch (err) {
          closeOnce({ error: err instanceof Error ? err.message : String(err) });
          return;
        }
        if (closed) return;
        if (!response.ok) {
          closeOnce({ error: `HTTP ${response.status}` });
          return;
        }
        let decoded: unknown = null;
        try {
          decoded = await response.json();
        } catch {
          logger.warn('non-JSON long-poll body ignored');
        }
        const frames =
          typeof decoded === 'object' && decoded !== null && Array.isArray((decoded as { frames?: unknown }).frames)
            ? ((decoded as { frames: unknown[] }).frames)
            : [];
        for (const raw of frames) {
          const frame = parseWireFrame(raw);
          if (frame === null) {
            logger.warn('malformed frame ignored');
            continue;
          }
          if (!closed) events.onFrame(frame);
        }
      }
    };

    queueMicrotask(() => {
      if (closed) return;
      events.onOpen();
      void loop();
    });

    return {
      send: (frame) => {
        outbound.push(frame);
      },
      close: () => {
        // Mirror WebSocket semantics: a local close still surfaces onClose
        // (asynchronously) so the connection state machine has one exit path.
        queueMicrotask(() => closeOnce({}));
      },
    };
  }
}

/** The default transport ladder: WSS primary, long-poll fallback. */
export function defaultTransports(baseUrl: string, logger?: Logger): Transport[] {
  return [new WebSocketTransport(baseUrl, { logger }), new LongPollTransport(baseUrl, { logger })];
}
