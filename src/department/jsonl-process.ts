/**
 * `jsonl-process` — the flagship `AgentRuntimeAdapter` (department-mesh, task
 * d1; `07-runtime-contract.md` §3). Line-delimited JSON on stdin/stdout: what
 * third parties target. Spawns through the generalized streaming seam
 * (`../jobs/types.ts`'s `JobSpawn`/`ProcessHandle` — stdin as a live pipe,
 * stdout parsed incrementally) so a mid-task message is actually possible.
 *
 * Down (supervisor → process): `initialize` / `task.start` / `task.message` /
 * `task.cancel` / `shutdown`. Up (process → supervisor): `ready` /
 * `task.status` / `task.progress` / `task.message` / `task.input_required` /
 * `task.artifact` / `task.completed` / `task.failed`. The wire keys are
 * camelCase exactly as specified (07 §3's JSON examples) — this IS the
 * external contract a third-party runtime implements against, independent of
 * the runner's own (snake_case) cloud-wire conventions.
 *
 * Rules enforced here (07 §3):
 *   - One JSON object per line. Unparseable lines are logged and dropped,
 *     never fatal — the same tolerance `../jobs/drive.ts` already applies to
 *     stray output.
 *   - The process MUST emit `ready` within `startupTimeoutSeconds` or the
 *     execution fails (`start()` rejects).
 *   - Inline `bytes` on an artifact are permitted only under 64 KiB; an
 *     oversize inline artifact is dropped (logged), not forwarded.
 *   - Capability negotiation is honest: `send()` REFUSES (throws) a
 *     `task.message` to a handle whose negotiated `capabilities.midTaskInput`
 *     is false — the supervisor must queue it instead (`./manager.ts`).
 *   - An unexpected process exit (no `task.completed`/`task.failed` seen, and
 *     not a deliberate `dispose()`) is surfaced as a synthetic
 *     `{type:'failed', retrySafe:true}` event, never silently dropped.
 */

import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { JobSpawn, ProcessHandle } from '../jobs/types';
import { nodeJobSpawn } from '../jobs/types';
import type {
  AgentRuntimeAdapter,
  DeptMessage,
  DeptTaskSpec,
  InvocationEnvelope,
  Part,
  ProbeResult,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeHandle,
  RuntimeInput,
} from './adapter';
import { RuntimeAdapterError } from './adapter';

export const JSONL_PROTOCOL_VERSION = '1.0';
export const DEFAULT_STARTUP_TIMEOUT_S = 30;
export const DEFAULT_GRACEFUL_SHUTDOWN_S = 15;
export const DEFAULT_PROBE_TIMEOUT_S = 10;
/** 07 §3: "Inline `bytes` are permitted only under 64 KiB." */
export const INLINE_ARTIFACT_BYTES_LIMIT = 64 * 1024;

export interface JsonlProcessAdapterOptions {
  spawn?: JobSpawn;
  clock?: Clock;
  logger?: Logger;
}

// ── Wire shapes (this module's private serialization surface) ──────────────

interface WirePart {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

interface WireMessage {
  messageId: string;
  role: string;
  parts: WirePart[];
  contextId?: string;
  taskId?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

function toWirePart(part: Part): WirePart {
  const wire: WirePart = {};
  if (part.text !== undefined) wire.text = part.text;
  if (part.raw !== undefined) wire.raw = part.raw;
  if (part.url !== undefined) wire.url = part.url;
  if (part.data !== undefined) wire.data = part.data;
  if (part.mediaType !== undefined) wire.mediaType = part.mediaType;
  if (part.filename !== undefined) wire.filename = part.filename;
  if (part.metadata !== undefined) wire.metadata = part.metadata;
  return wire;
}

function toWireMessage(message: DeptMessage): WireMessage {
  const wire: WireMessage = { messageId: message.messageId, role: message.role, parts: message.parts.map(toWirePart) };
  if (message.contextId !== undefined) wire.contextId = message.contextId;
  if (message.taskId !== undefined) wire.taskId = message.taskId;
  if (message.createdAt !== undefined) wire.createdAt = message.createdAt;
  if (message.metadata !== undefined) wire.metadata = message.metadata;
  return wire;
}

function buildInitializeDown(capabilities: RuntimeCapabilities): Record<string, unknown> {
  return { type: 'initialize', protocolVersion: JSONL_PROTOCOL_VERSION, capabilities };
}

function buildTaskStartDown(task: DeptTaskSpec): Record<string, unknown> {
  return {
    type: 'task.start',
    task: {
      taskId: task.taskId,
      contextId: task.contextId,
      messages: task.messages.map(toWireMessage),
      ...(task.acceptedOutputModes !== undefined ? { acceptedOutputModes: task.acceptedOutputModes } : {}),
    },
  };
}

function buildTaskMessageDown(message: DeptMessage): Record<string, unknown> {
  return { type: 'task.message', message: toWireMessage(message) };
}

function buildTaskCancelDown(reason?: string): Record<string, unknown> {
  return reason === undefined ? { type: 'task.cancel' } : { type: 'task.cancel', reason };
}

function buildShutdownDown(graceSeconds: number): Record<string, unknown> {
  return { type: 'shutdown', graceSeconds };
}

function writeDown(proc: ProcessHandle, frame: Record<string, unknown>): void {
  proc.writeLine(JSON.stringify(frame));
}

// ── Up-message parsing (tolerant: malformed ⇒ null, never throws) ──────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one raw stdout line as a JSON object. Null (never throws) on
 *  anything that is not a well-formed JSON object — the 07 §3 tolerance. */
function tryParseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

interface ReadyInfo {
  runtime?: string;
  version?: string;
  capabilities: RuntimeCapabilities;
}

function narrowCapabilities(raw: unknown): RuntimeCapabilities {
  const c = isRecord(raw) ? raw : {};
  return {
    midTaskInput: c.midTaskInput === true,
    artifacts: c.artifacts === true,
  };
}

function narrowReady(raw: Record<string, unknown>): ReadyInfo | null {
  if (raw.type !== 'ready') return null;
  return {
    runtime: typeof raw.runtime === 'string' ? raw.runtime : undefined,
    version: typeof raw.version === 'string' ? raw.version : undefined,
    capabilities: narrowCapabilities(raw.capabilities),
  };
}

function narrowPart(raw: unknown): Part | null {
  if (!isRecord(raw)) return null;
  const part: Part = {};
  if (typeof raw.text === 'string') part.text = raw.text;
  if (typeof raw.raw === 'string') part.raw = raw.raw;
  if (typeof raw.url === 'string') part.url = raw.url;
  if (raw.data !== undefined) part.data = raw.data;
  if (typeof raw.mediaType === 'string') part.mediaType = raw.mediaType;
  if (typeof raw.filename === 'string') part.filename = raw.filename;
  if (isRecord(raw.metadata)) part.metadata = raw.metadata;
  return part;
}

function narrowParts(raw: unknown): Part[] | null {
  if (!Array.isArray(raw)) return null;
  const parts: Part[] = [];
  for (const entry of raw) {
    const part = narrowPart(entry);
    if (part !== null) parts.push(part);
  }
  return parts;
}

/** Decode a base64 `bytes` field. Null when absent/malformed. */
function decodeBase64(raw: unknown): Uint8Array | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return new Uint8Array(Buffer.from(raw, 'base64'));
  } catch {
    return null;
  }
}

/**
 * Route one PARSED, non-handshake up-line to a `RuntimeEvent`, or `null` when
 * the line should be logged and dropped (unrecognized `type`, malformed
 * shape, or an oversize inline artifact — 07 §3's inline-bytes cap). Pure —
 * the caller does the logging so this stays trivially testable.
 */
export function narrowRuntimeEvent(raw: Record<string, unknown>): { event: RuntimeEvent } | { drop: string } {
  switch (raw.type) {
    case 'task.status': {
      // The RuntimeEvent union recognizes exactly one status literal
      // ('WORKING') today — an up-line reporting anything else is dropped
      // rather than silently coerced.
      if (raw.state !== 'WORKING') return { drop: `task.status with unrecognized state '${String(raw.state)}'` };
      return {
        event: { type: 'status', state: 'WORKING', ...(typeof raw.message === 'string' ? { message: raw.message } : {}) },
      };
    }
    case 'task.progress': {
      if (typeof raw.note !== 'string') return { drop: 'task.progress missing note' };
      return { event: { type: 'progress', note: raw.note } };
    }
    case 'task.message': {
      const parts = narrowParts(raw.parts);
      if (parts === null || parts.length === 0) return { drop: 'task.message missing/empty parts' };
      return { event: { type: 'message', parts } };
    }
    case 'task.input_required': {
      if (typeof raw.questionId !== 'string' || raw.questionId.length === 0) {
        return { drop: 'task.input_required missing questionId' };
      }
      const q = isRecord(raw.question) ? raw.question : {};
      if (typeof q.text !== 'string' || q.text.length === 0) {
        return { drop: 'task.input_required missing question.text' };
      }
      return {
        event: {
          type: 'input_required',
          questionId: raw.questionId,
          question: {
            text: q.text,
            context: typeof q.context === 'string' ? q.context : null,
            options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : null,
          },
        },
      };
    }
    case 'task.artifact': {
      if (typeof raw.name !== 'string' || raw.name.length === 0) return { drop: 'task.artifact missing name' };
      if (typeof raw.mediaType !== 'string' || raw.mediaType.length === 0) {
        return { drop: 'task.artifact missing mediaType' };
      }
      let bytes: Uint8Array | undefined;
      if (raw.bytes !== undefined) {
        const decoded = decodeBase64(raw.bytes);
        if (decoded === null) return { drop: `task.artifact '${raw.name}' has malformed base64 bytes` };
        if (decoded.byteLength >= INLINE_ARTIFACT_BYTES_LIMIT) {
          return {
            drop: `task.artifact '${raw.name}' inline bytes (${decoded.byteLength}B) meet/exceed the ${INLINE_ARTIFACT_BYTES_LIMIT}B cap — use 'path' instead`,
          };
        }
        bytes = decoded;
      }
      const path = typeof raw.path === 'string' ? raw.path : undefined;
      if (bytes === undefined && path === undefined) return { drop: `task.artifact '${raw.name}' has neither bytes nor path` };
      return { event: { type: 'artifact', name: raw.name, mediaType: raw.mediaType, ...(bytes ? { bytes } : {}), ...(path ? { path } : {}) } };
    }
    case 'task.completed': {
      return { event: { type: 'completed', ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}) } };
    }
    case 'task.failed': {
      if (typeof raw.reason !== 'string' || raw.reason.length === 0) return { drop: 'task.failed missing reason' };
      return { event: { type: 'failed', reason: raw.reason, retrySafe: raw.retrySafe === true } };
    }
    default:
      return { drop: `unrecognized up-message type '${String(raw.type)}'` };
  }
}

// ── The handle ────────────────────────────────────────────────────────────

class JsonlHandle implements RuntimeHandle {
  readonly adapterId = 'jsonl-process';
  /** True from `task.start`/`task.message` until a terminal event is routed
   *  or the process exits — governs the `midTaskInput` refusal in `send()`. */
  working = true;
  terminalReached = false;
  disposing = false;

  constructor(
    readonly taskId: string,
    readonly contextId: string,
    readonly capabilities: RuntimeCapabilities,
    readonly proc: ProcessHandle,
    readonly gracefulShutdownSeconds: number,
    readonly runtimeName: string
  ) {}
}

function asJsonlHandle(handle: RuntimeHandle): JsonlHandle {
  if (!(handle instanceof JsonlHandle)) {
    throw new RuntimeAdapterError('jsonl-process: handle was not minted by this adapter');
  }
  return handle;
}

// ── The adapter ───────────────────────────────────────────────────────────

export class JsonlProcessAdapter implements AgentRuntimeAdapter {
  readonly id = 'jsonl-process';

  private readonly spawnSeam: JobSpawn;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(options: JsonlProcessAdapterOptions = {}) {
    this.spawnSeam = options.spawn ?? nodeJobSpawn();
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? nullLogger;
  }

  async probe(config: RuntimeConfig): Promise<ProbeResult> {
    const proc = this.spawnSeam.spawn(config.command, config.args ?? [], { cwd: config.cwd, env: config.env });
    const timeoutMs = (config.startupTimeoutSeconds ?? DEFAULT_PROBE_TIMEOUT_S) * 1000;
    try {
      const ready = await this.waitForReady(proc, timeoutMs, config.command);
      // Probe-only: never leave the process running.
      writeDown(proc, buildShutdownDown(1));
      proc.endStdin();
      this.clock.setTimeout(() => proc.kill(), 500);
      return { ok: true, runtime: ready.runtime, version: ready.version, capabilities: ready.capabilities };
    } catch (err) {
      proc.kill();
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async start(invocation: InvocationEnvelope, sink: RuntimeEventSink): Promise<RuntimeHandle> {
    const { runtime, task } = invocation;
    const proc = this.spawnSeam.spawn(runtime.command, runtime.args ?? [], { cwd: runtime.cwd, env: runtime.env });
    const timeoutMs = (runtime.startupTimeoutSeconds ?? DEFAULT_STARTUP_TIMEOUT_S) * 1000;
    try {
      return await this.runHandshakeThenStart(proc, task, timeoutMs, runtime, sink);
    } catch (err) {
      proc.kill();
      throw err;
    }
  }

  async send(handleIn: RuntimeHandle, input: RuntimeInput): Promise<void> {
    const handle = asJsonlHandle(handleIn);
    if (handle.disposing) throw new RuntimeAdapterError('jsonl-process: handle is disposing');
    if (input.kind === 'message') {
      // Honest capability negotiation (07 §3): a midTaskInput:false runtime
      // is NEVER sent task.message — full stop. The supervisor is the one
      // that should have queued it instead of calling send() at all; this is
      // the adapter's own belt-and-braces enforcement.
      if (!handle.capabilities.midTaskInput) {
        throw new RuntimeAdapterError(
          `jsonl-process: runtime '${handle.runtimeName}' declared capabilities.midTaskInput:false — task.message must be queued by the supervisor, not sent`
        );
      }
      writeDown(handle.proc, buildTaskMessageDown(input.message));
      return;
    }
    // 'task.start' on an existing handle: daemon-lifecycle reuse (07 §5) —
    // the SAME process receives another task over the same pipe.
    handle.working = true;
    handle.terminalReached = false;
    writeDown(handle.proc, buildTaskStartDown(input.task));
  }

  async cancel(handleIn: RuntimeHandle, reason?: string): Promise<void> {
    const handle = asJsonlHandle(handleIn);
    writeDown(handle.proc, buildTaskCancelDown(reason));
  }

  async dispose(handleIn: RuntimeHandle): Promise<void> {
    const handle = asJsonlHandle(handleIn);
    if (handle.disposing) return;
    handle.disposing = true;
    writeDown(handle.proc, buildShutdownDown(handle.gracefulShutdownSeconds));
    handle.proc.endStdin();
    // Best-effort grace then a direct-child SIGTERM (NOT a process-group
    // kill — that escalation, and SIGKILL-after-grace, is task d2's scope;
    // this mirrors today's `types.ts:96-103` limitation deliberately).
    await new Promise<void>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        handle.proc.kill('SIGTERM');
        resolve();
      }, handle.gracefulShutdownSeconds * 1000);
      handle.proc.onExit(() => {
        this.clock.clearTimeout(timer);
        resolve();
      });
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /**
   * Probe-only ready wait: send `initialize`, resolve on the first `ready`
   * line, reject on timeout or an early exit. Nothing else is routed — the
   * caller tears the process down immediately either way, so a stray extra
   * line racing the teardown is harmless (unlike `start()`, below).
   */
  private waitForReady(proc: ProcessHandle, timeoutMs: number, command: string): Promise<ReadyInfo> {
    return new Promise<ReadyInfo>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new RuntimeAdapterError(`jsonl-process: '${command}' did not emit 'ready' within ${timeoutMs}ms`));
      }, timeoutMs);
      proc.onStdoutLine((line) => {
        if (settled) return;
        const parsed = tryParseLine(line);
        const info = parsed === null ? null : narrowReady(parsed);
        if (info === null) return; // tolerated: probe cares only about ready
        settled = true;
        this.clock.clearTimeout(timer);
        resolve(info);
      });
      proc.onExit((info) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        reject(
          new RuntimeAdapterError(
            `jsonl-process: '${command}' exited before 'ready' (code ${info.code ?? 'null'}${info.error ? `, ${info.error}` : ''})`
          )
        );
      });
      writeDown(proc, buildInitializeDown({ midTaskInput: true, artifacts: true }));
    });
  }

  /**
   * `start()`'s real work: ONE persistent stdout-line callback for the
   * process's ENTIRE lifetime, switching behavior on an internal `phase`
   * flag flipped synchronously the instant `ready` is parsed.
   *
   * This is deliberately NOT split into "wait for ready" then "register the
   * active handler" as two sequential steps: `ProcessHandle` is a
   * single-subscriber seam, and re-registering a fresh callback only takes
   * effect for lines processed AFTER the `await` that separates the two
   * steps resolves. If the child's `ready` line and its first task event
   * arrive in the SAME stdout chunk, `makeLineBuffer` (`../jobs/types.ts`)
   * delivers both synchronously, back-to-back, inside one `data` handler —
   * well before the `await` continuation (a microtask) ever runs. A
   * two-step design would silently drop that second line. One callback with
   * an internal phase switch has no such window: the switch happens
   * synchronously inside the very call that detects `ready`, so the very
   * next line in the same loop already sees the new phase.
   */
  private runHandshakeThenStart(
    proc: ProcessHandle,
    task: DeptTaskSpec,
    timeoutMs: number,
    runtime: RuntimeConfig,
    sink: RuntimeEventSink
  ): Promise<JsonlHandle> {
    return new Promise<JsonlHandle>((resolve, reject) => {
      let phase: 'handshake' | 'active' = 'handshake';
      let handshakeSettled = false;
      let handle: JsonlHandle | null = null;

      const timer = this.clock.setTimeout(() => {
        if (handshakeSettled) return;
        handshakeSettled = true;
        reject(new RuntimeAdapterError(`jsonl-process: '${runtime.command}' did not emit 'ready' within ${timeoutMs}ms`));
      }, timeoutMs);

      proc.onStdoutLine((line) => {
        const parsed = tryParseLine(line);
        if (parsed === null) {
          this.logger.warn(`jsonl-process: skipping unparseable line: ${truncate(line)}`);
          return;
        }
        if (phase === 'handshake') {
          const info = narrowReady(parsed);
          if (info === null) {
            this.logger.warn(`jsonl-process: unexpected '${String(parsed.type)}' line before ready — ignored`);
            return;
          }
          handshakeSettled = true;
          this.clock.clearTimeout(timer);
          phase = 'active'; // synchronous — the next line in this same chunk already sees it
          handle = new JsonlHandle(
            task.taskId,
            task.contextId,
            info.capabilities,
            proc,
            runtime.gracefulShutdownSeconds ?? DEFAULT_GRACEFUL_SHUTDOWN_S,
            info.runtime ?? runtime.command
          );
          writeDown(proc, buildTaskStartDown(task));
          resolve(handle);
          return;
        }
        // phase === 'active'
        if (handle !== null) this.routeActiveLine(handle, parsed, sink);
      });

      proc.onStderr((chunk) => {
        const trimmed = chunk.trim();
        if (trimmed.length === 0) return;
        this.logger.debug(`jsonl-process[${task.taskId}] stderr: ${truncate(trimmed)}`);
      });

      proc.onExit((info) => {
        if (phase === 'handshake') {
          if (handshakeSettled) return;
          handshakeSettled = true;
          this.clock.clearTimeout(timer);
          reject(
            new RuntimeAdapterError(
              `jsonl-process: '${runtime.command}' exited before 'ready' (code ${info.code ?? 'null'}${info.error ? `, ${info.error}` : ''})`
            )
          );
          return;
        }
        if (handle === null || handle.terminalReached || handle.disposing) return;
        sink({
          type: 'failed',
          reason: `runtime process exited unexpectedly (code ${info.code ?? 'null'}${info.signal ? `, signal ${info.signal}` : ''}${info.error ? `, ${info.error}` : ''})`,
          retrySafe: true,
        });
        handle.terminalReached = true;
      });

      writeDown(proc, buildInitializeDown({ midTaskInput: true, artifacts: true }));
    });
  }

  /** Route one ACTIVE-phase parsed line to the sink, updating the handle's
   *  `working`/`terminalReached` bookkeeping (`send()`'s capability guard and
   *  the exit handler's "already terminal" check both read it). */
  private routeActiveLine(handle: JsonlHandle, parsed: Record<string, unknown>, sink: RuntimeEventSink): void {
    const routed = narrowRuntimeEvent(parsed);
    if ('drop' in routed) {
      this.logger.warn(`jsonl-process: ${routed.drop}`);
      return;
    }
    if (routed.event.type === 'completed' || routed.event.type === 'failed') {
      handle.terminalReached = true;
      handle.working = false;
    } else if (routed.event.type === 'input_required') {
      // Paused awaiting an answer — not "working" for capability-refusal
      // purposes, but not terminal either.
      handle.working = false;
    } else {
      handle.working = true;
    }
    sink(routed.event);
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
