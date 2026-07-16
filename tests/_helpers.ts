/**
 * Shared test fakes: a manual clock, an in-memory config filesystem, a
 * capturing logger, and a scriptable mock transport. Underscore-prefixed so
 * `bun test` does not pick this file up as a suite (pipeline-cli convention).
 */

import type { Clock } from '../src/core/clock';
import type { ConfigFileSystem } from '../src/core/config';
import type { Logger } from '../src/core/log';
import type { Transport, TransportConnection, TransportEvents } from '../src/core/transport';
import type { WireFrame } from '../src/core/wire';

// ── Fake clock ───────────────────────────────────────────────────────────────

interface FakeTimer {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private time = 0;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: FakeTimer = { id: this.nextId++, at: this.time + ms, fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  now(): number {
    return this.time;
  }

  /** Advance time, firing due timers in order (timers may schedule timers). */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.time = due.at;
      due.fn();
    }
    this.time = target;
  }

  get pendingCount(): number {
    return this.timers.length;
  }
}

/** Flush pending microtasks + macrotask queue (mock transports use them). */
export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── In-memory config fs ─────────────────────────────────────────────────────

export class MemFs implements ConfigFileSystem {
  files = new Map<string, { data: string; mode: number }>();
  dirs = new Map<string, number>();

  readFileText(path: string): string | null {
    return this.files.get(path)?.data ?? null;
  }

  writeFileText(path: string, data: string, mode: number): void {
    this.files.set(path, { data, mode });
  }

  mkdirp(path: string, mode: number): void {
    this.dirs.set(path, mode);
  }

  chmod(path: string, mode: number): void {
    const file = this.files.get(path);
    if (file) file.mode = mode;
  }
}

// ── Capturing logger ─────────────────────────────────────────────────────────

export class CaptureLogger implements Logger {
  lines: string[] = [];

  debug(message: string): void {
    this.lines.push(`debug: ${message}`);
  }
  info(message: string): void {
    this.lines.push(`info: ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error: ${message}`);
  }

  joined(): string {
    return this.lines.join('\n');
  }
}

// ── Mock transport ───────────────────────────────────────────────────────────

export class MockConnection implements TransportConnection {
  sent: WireFrame[] = [];
  closedLocally = false;
  private closeFired = false;

  constructor(private readonly events: TransportEvents) {}

  send(frame: WireFrame): void {
    this.sent.push(frame);
  }

  close(): void {
    this.closedLocally = true;
    // Mirror WebSocket semantics: local close surfaces onClose asynchronously.
    queueMicrotask(() => this.fireClose({}));
  }

  /** Server pushes a frame down. */
  serverSend(frame: WireFrame): void {
    this.events.onFrame(frame);
  }

  /** Server/network drops the connection. */
  serverClose(error?: string): void {
    this.fireClose(error !== undefined ? { error } : {});
  }

  private fireClose(info: { error?: string }): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.events.onClose(info);
  }
}

/**
 * Scriptable transport: `behavior` decides whether each `open()` establishes
 * (fires onOpen) or fails-to-establish (fires onClose before open).
 */
export class MockTransport implements Transport {
  connections: MockConnection[] = [];
  /** Per-open behavior; when the list runs out, the last entry repeats. */
  behaviors: Array<'establish' | 'fail'>;

  constructor(
    readonly name: string,
    behaviors: Array<'establish' | 'fail'> = ['establish']
  ) {
    this.behaviors = behaviors;
  }

  open(events: TransportEvents): TransportConnection {
    const connection = new MockConnection(events);
    this.connections.push(connection);
    const behavior = this.behaviors[Math.min(this.connections.length - 1, this.behaviors.length - 1)];
    queueMicrotask(() => {
      if (behavior === 'establish') events.onOpen();
      else events.onClose({ error: 'connection refused' });
    });
    return connection;
  }

  get last(): MockConnection {
    const connection = this.connections[this.connections.length - 1];
    if (!connection) throw new Error('no connection opened yet');
    return connection;
  }
}
