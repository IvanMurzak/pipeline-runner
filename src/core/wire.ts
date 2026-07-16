/**
 * VENDORED from ai-pipeline `packages/protocol/src/wire` — source of truth;
 * replace with the published `@ai-pipeline/protocol` package once available
 * (npm publish blocked).
 *
 * Vendored subset (exactly what the agent CORE needs — nothing more):
 *   - the wire ENVELOPE shape (`envelope.ts`): every frame is `{ type, id?, …fields }`
 *     where `id` is the OPTIONAL correlation id — set on a request expecting a
 *     reply, echoed on the reply so a peer can pair response↔request over one
 *     multiplexed socket. Frames are additive-forward: unknown extra fields are
 *     PRESERVED, never rejected (the source uses zod `.passthrough()`).
 *   - the register handshake (`handshake.ts`): `register` / `register_ack` /
 *     `register_reject` + `REGISTER_REJECT_REASONS`.
 *   - the heartbeat pair (`client.ts` / `server.ts`): `heartbeat` /
 *     `heartbeat_ack` + `RUNNER_STATUSES` + `HEARTBEAT_DIRECTIVES`.
 *   - `PROTOCOL_VERSION` + `isCompatible` (`version.ts`).
 *
 * Deliberately NOT vendored (later tasks): `lease`/`accept` (T1-12 lease loop),
 * `upload`/`upload_ack` (T1-12 shipper), `needs_input`/`answer` (T1-13 relay),
 * `cancel`, `run_status`. The dispatcher routes-and-ignores those types by name
 * (see `dispatcher.ts`) so attaching handlers later needs no wire change here.
 *
 * The source encodes these shapes with zod; this vendored copy hand-rolls the
 * TS types plus light runtime guards for INBOUND (untrusted) frames, keeping
 * the agent dependency-free. Field names, optionality, and enum values match
 * the zod schemas 1:1 — verify against the source on every sync.
 */

/** Negotiated wire-protocol MAJOR (mirrors `version.ts`). Additive within a major. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Additive-within-a-major compatibility check (mirrors `version.ts`): two peers
 * are wire-compatible iff they share the protocol MAJOR.
 */
export function isCompatible(remoteMajor: number): boolean {
  return Number.isInteger(remoteMajor) && remoteMajor === PROTOCOL_VERSION;
}

/**
 * The minimal wire envelope: a `type` discriminant plus an optional correlation
 * `id`. The index signature carries the passthrough semantics — extra fields a
 * newer same-major peer adds ride along untouched.
 */
export interface WireFrame {
  [field: string]: unknown;
  type: string;
  /** Correlation id: set on a request expecting a reply, echoed on the reply. */
  id?: string;
}

/** Why the control plane refused a `register` (mirrors `handshake.ts`). */
export const REGISTER_REJECT_REASONS = ['upgrade_required', 'invalid_token', 'revoked', 'capacity'] as const;
export type RegisterRejectReason = (typeof REGISTER_REJECT_REASONS)[number];

/** Runner liveness/pause states surfaced on a heartbeat (mirrors `client.ts`). */
export const RUNNER_STATUSES = ['online', 'paused', 'draining'] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

/** Server directive piggy-backed on a `heartbeat_ack` (mirrors `server.ts`). */
export const HEARTBEAT_DIRECTIVES = ['none', 'reregister', 'drain'] as const;
export type HeartbeatDirective = (typeof HEARTBEAT_DIRECTIVES)[number];

/**
 * `register` (agent → server) — the opening frame, ALWAYS the first frame sent
 * on a fresh connection. The `runner_token` is the sole credential; the server
 * returns a stable `runner_id` on `register_ack`.
 */
export interface RegisterMessage extends WireFrame {
  type: 'register';
  /** Scoped runner token (org/project-scoped, revocable). SECRET — never log. */
  runner_token: string;
  /** Matchable labels: `os:windows`, `repo:acme/api`, `gpu`, custom. */
  labels: string[];
  /** Operating system, e.g. "windows" | "linux" | "darwin". */
  os: string;
  /** `pipeline-runner` version. */
  agent_version: string;
  /** `pipeline` CLI (execution engine) version. */
  cli_version: string;
  /** Claude-Pipeline plugin version, or null if not installed. */
  plugin_version?: string | null;
  /** The runner's advertised protocol MAJOR. */
  protocol_version: number;
  /** Max parallel runs this runner will accept. */
  capacity?: number;
}

/** `register_ack` (server → agent) — connection accepted. */
export interface RegisterAckMessage extends WireFrame {
  type: 'register_ack';
  /** The negotiated protocol MAJOR. */
  protocol_version: number;
  /** Server-assigned stable runner identity (used on every later message). */
  runner_id: string;
  /** Expected heartbeat cadence in seconds. */
  heartbeat_interval_s?: number;
}

/** `register_reject` (server → agent) — connection refused. */
export interface RegisterRejectMessage extends WireFrame {
  type: 'register_reject';
  reason: RegisterRejectReason;
  /** The minimum protocol MAJOR the server accepts — set on `upgrade_required`. */
  min_protocol_version?: number;
  /** Optional human-readable detail for logs / the runner console. */
  message?: string | null;
}

/** `heartbeat` (agent → server) — periodic liveness. Set `id` to pair the ack. */
export interface HeartbeatMessage extends WireFrame {
  type: 'heartbeat';
  runner_id: string;
  /** Run ids currently executing on this runner. */
  active_run_ids?: string[];
  /** Runner state; absent ⇒ treat as `online`. */
  status?: RunnerStatus;
  /** When `status: "paused"`, the ISO time auto-resume is expected, or null. */
  paused_until?: string | null;
}

/** `heartbeat_ack` (server → agent) — the reply to a `heartbeat`; echoes `id`. */
export interface HeartbeatAckMessage extends WireFrame {
  type: 'heartbeat_ack';
  /** Server ISO time at ack — lets the runner measure skew / round-trip. */
  ts?: string;
  /** Optional server directive; absent ⇒ `none`. */
  directive?: HeartbeatDirective | null;
}

// ── Runtime guards for INBOUND (untrusted) frames ───────────────────────────
// Defensive equivalents of the source's zod `.parse()`: verify the fields this
// agent actually reads; preserve everything else (passthrough).

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Parse a decoded JSON value into a well-formed wire frame, or null if it is
 * not one (not an object, missing/empty `type`, malformed `id`). Mirrors the
 * tolerant `AnyWireMessage` in the source: ANY `type` string is accepted so a
 * newer same-major peer's additive message types still route.
 */
export function parseWireFrame(value: unknown): WireFrame | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.type)) return null;
  if (record.id !== undefined && !isNonEmptyString(record.id)) return null;
  return record as WireFrame;
}

/** Narrow a frame to a well-formed `register_ack`. */
export function isRegisterAck(frame: WireFrame): frame is RegisterAckMessage {
  return (
    frame.type === 'register_ack' &&
    isNonEmptyString(frame.runner_id) &&
    isPositiveInt(frame.protocol_version) &&
    (frame.heartbeat_interval_s === undefined || isPositiveInt(frame.heartbeat_interval_s))
  );
}

/** Narrow a frame to a well-formed `register_reject`. */
export function isRegisterReject(frame: WireFrame): frame is RegisterRejectMessage {
  return (
    frame.type === 'register_reject' &&
    (REGISTER_REJECT_REASONS as readonly string[]).includes(frame.reason as string) &&
    (frame.min_protocol_version === undefined || isPositiveInt(frame.min_protocol_version))
  );
}

/** Narrow a frame to a well-formed `heartbeat_ack`. */
export function isHeartbeatAck(frame: WireFrame): frame is HeartbeatAckMessage {
  return (
    frame.type === 'heartbeat_ack' &&
    (frame.directive === undefined ||
      frame.directive === null ||
      (HEARTBEAT_DIRECTIVES as readonly string[]).includes(frame.directive as string))
  );
}
