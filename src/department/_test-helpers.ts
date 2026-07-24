/**
 * Shared department-mesh test fakes: a scriptable, in-memory `JobSpawn` (no
 * real OS process — the adapter's callback-driven design is exercised
 * directly) plus small invocation/adapter fixtures. Underscore-prefixed so
 * `bun test` does not pick this file up as a suite (repo convention, see
 * `../jobs/_helpers.ts`).
 */

import type { JobSpawn, ProcessHandle, ProcessSpawnOptions } from '../jobs/types';
import type {
  AgentRuntimeAdapter,
  DeptMessage,
  DeptTaskSpec,
  InvocationEnvelope,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeHandle,
  RuntimeInput,
} from './adapter';

// ── Fake streaming process ──────────────────────────────────────────────────

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; error?: string };

/** A fully scriptable `ProcessHandle`: the test drives its "child" side
 *  directly (`emitLine`/`emitExit`) instead of a real subprocess. */
export class FakeProcessHandle implements ProcessHandle {
  readonly pid: number | null = 4242;
  written: string[] = [];
  ended = false;
  killedWith: NodeJS.Signals[] = [];
  /** Every `killGroup()` call, in order — separate from `killedWith` so
   *  tests can assert the d2 escalation targets the GROUP, not the direct
   *  child (`../jsonl-process.ts`'s `dispose()`). */
  killedGroupWith: NodeJS.Signals[] = [];

  private lineCb: ((line: string) => void) | null = null;
  private stderrCb: ((chunk: string) => void) | null = null;
  private exitCb: ((info: ExitInfo) => void) | null = null;
  private exited = false;

  writeLine(line: string): boolean {
    if (this.ended) return false;
    this.written.push(line);
    return true;
  }

  endStdin(): void {
    this.ended = true;
  }

  kill(signal?: NodeJS.Signals): void {
    this.killedWith.push(signal ?? 'SIGTERM');
  }

  killGroup(signal?: NodeJS.Signals): void {
    this.killedGroupWith.push(signal ?? 'SIGTERM');
  }

  onStdoutLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onStderr(cb: (chunk: string) => void): void {
    this.stderrCb = cb;
  }

  onExit(cb: (info: ExitInfo) => void): void {
    this.exitCb = cb;
  }

  // ── Test-only driving API (the "child process" side) ──────────────────────

  /** Feed one already-framed line to the adapter, as if the child wrote it. */
  emitLine(line: string): void {
    this.lineCb?.(line);
  }

  /** Convenience: JSON.stringify + emitLine. */
  emitJson(frame: Record<string, unknown>): void {
    this.emitLine(JSON.stringify(frame));
  }

  emitStderr(chunk: string): void {
    this.stderrCb?.(chunk);
  }

  /** Simulate the process terminating. Idempotent (real processes exit once). */
  emitExit(info: Partial<ExitInfo> = {}): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCb?.({ code: info.code ?? 0, signal: info.signal ?? null, error: info.error });
  }

  /** Every written line, JSON-parsed (assertion convenience). */
  writtenJson(): unknown[] {
    return this.written.map((line) => JSON.parse(line));
  }

  lastWrittenJson(): unknown {
    const last = this.written[this.written.length - 1];
    return last === undefined ? undefined : JSON.parse(last);
  }
}

export interface FakeSpawnCall {
  cmd: string;
  args: string[];
  opts?: ProcessSpawnOptions;
}

/** Records every spawn; each call gets a fresh `FakeProcessHandle`. */
export class FakeJobSpawn implements JobSpawn {
  calls: FakeSpawnCall[] = [];
  handles: FakeProcessHandle[] = [];

  spawn(cmd: string, args: string[], opts?: ProcessSpawnOptions): ProcessHandle {
    this.calls.push({ cmd, args, opts });
    const handle = new FakeProcessHandle();
    this.handles.push(handle);
    return handle;
  }

  get last(): FakeProcessHandle {
    const handle = this.handles[this.handles.length - 1];
    if (handle === undefined) throw new Error('FakeJobSpawn: no process spawned yet');
    return handle;
  }
}

// ── Invocation / message fixtures ───────────────────────────────────────────

export function makeMessage(overrides: Partial<DeptMessage> = {}): DeptMessage {
  return {
    messageId: 'msg-1',
    role: 'ROLE_USER',
    parts: [{ text: 'do the thing', mediaType: 'text/plain' }],
    ...overrides,
  };
}

export function makeTaskSpec(overrides: Partial<DeptTaskSpec> = {}): DeptTaskSpec {
  return {
    taskId: 'dtask-1',
    contextId: 'dctx-1',
    messages: [makeMessage()],
    ...overrides,
  };
}

export function makeRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    adapterId: 'jsonl-process',
    command: 'unity-department',
    args: ['--stdio'],
    startupTimeoutSeconds: 5,
    ...overrides,
  };
}

export function makeInvocation(overrides: Partial<InvocationEnvelope> = {}): InvocationEnvelope {
  return {
    runtime: makeRuntimeConfig(),
    task: makeTaskSpec(),
    ...overrides,
  };
}

// ── A minimal AgentRuntimeAdapter fake (manager-level tests) ────────────────

export interface FakeAdapterCall {
  kind: 'start' | 'send' | 'cancel' | 'dispose' | 'probe';
  handle?: RuntimeHandle;
  invocation?: InvocationEnvelope;
  input?: RuntimeInput;
  reason?: string;
}

/** A scriptable `AgentRuntimeAdapter` double — no process, no JSONL parsing.
 *  `start()` resolves immediately with a synthetic handle and stashes the
 *  sink so the test can drive events (`emit(handle, event)`) directly. Used
 *  by `manager.test.ts` to test lifecycle POLICY independent of any wire
 *  format (the same separation the interface itself draws: an adapter's wire
 *  format is its own business, not the supervisor's). */
export class FakeAdapter implements AgentRuntimeAdapter {
  readonly id = 'fake';
  calls: FakeAdapterCall[] = [];
  /** Every handle `start()` has minted, in order — index-addressable, since
   *  `emit()` needs the EXACT object `start()` returned (the sink map below
   *  is keyed by reference, matching how a real supervisor only ever holds
   *  the handle an adapter gave it, never reconstructs one). */
  handles: RuntimeHandle[] = [];
  private sinks = new Map<RuntimeHandle, (event: RuntimeEvent) => void>();

  async probe(): Promise<{ ok: true; capabilities: { midTaskInput: boolean; artifacts: boolean } }> {
    this.calls.push({ kind: 'probe' });
    return { ok: true, capabilities: { midTaskInput: true, artifacts: true } };
  }

  async start(invocation: InvocationEnvelope, sink: (event: RuntimeEvent) => void): Promise<RuntimeHandle> {
    this.calls.push({ kind: 'start', invocation });
    const handle: RuntimeHandle = {
      adapterId: this.id,
      taskId: invocation.task.taskId,
      contextId: invocation.task.contextId,
      capabilities: { midTaskInput: true, artifacts: true },
    };
    this.sinks.set(handle, sink);
    this.handles.push(handle);
    return handle;
  }

  async send(handle: RuntimeHandle, input: RuntimeInput): Promise<void> {
    this.calls.push({ kind: 'send', handle, input });
  }

  async cancel(handle: RuntimeHandle, reason?: string): Promise<void> {
    this.calls.push({ kind: 'cancel', handle, reason });
  }

  async dispose(handle: RuntimeHandle): Promise<void> {
    this.calls.push({ kind: 'dispose', handle });
    this.sinks.delete(handle);
  }

  /** Test-only: drive an event as if the runtime behind `handle` emitted it.
   *  `handle` MUST be one this adapter's `start()` actually returned (e.g.
   *  from `.handles` or `.lastHandle`) — a structurally-equal-but-different
   *  object will silently no-op, since the sink map is keyed by reference. */
  emit(handle: RuntimeHandle, event: RuntimeEvent): void {
    this.sinks.get(handle)?.(event);
  }

  /** Emit on the MOST RECENTLY minted handle — the common case (drive the
   *  current/latest process, whichever `start()` call produced it, without
   *  the caller tracking indices through a respawn). */
  emitLatest(event: RuntimeEvent): void {
    const handle = this.handles[this.handles.length - 1];
    if (handle === undefined) throw new Error('FakeAdapter: no handle minted yet');
    this.emit(handle, event);
  }

  get lastHandle(): RuntimeHandle {
    const handle = this.handles[this.handles.length - 1];
    if (handle === undefined) throw new Error('FakeAdapter: no handle minted yet');
    return handle;
  }

  startCalls(): InvocationEnvelope[] {
    return this.calls.filter((c) => c.kind === 'start').map((c) => c.invocation!);
  }
}

/** A `midTaskInput:false` variant of `FakeAdapter` — `start()` negotiates the
 *  capability down regardless of what the invocation asked for, and `send()`
 *  throws on a `message` input (mirrors `JsonlProcessAdapter`'s own guard) so
 *  a manager-level bug (calling send() instead of queueing) fails loudly. */
export class FakeNoMidTaskInputAdapter extends FakeAdapter {
  override async start(invocation: InvocationEnvelope, sink: (event: RuntimeEvent) => void): Promise<RuntimeHandle> {
    const handle = await super.start(invocation, sink);
    return { ...handle, capabilities: { midTaskInput: false, artifacts: true } };
  }

  override async send(handle: RuntimeHandle, input: RuntimeInput): Promise<void> {
    if (input.kind === 'message' && !handle.capabilities.midTaskInput) {
      throw new Error("fake: runtime declared capabilities.midTaskInput:false — must not receive task.message");
    }
    return super.send(handle, input);
  }
}
