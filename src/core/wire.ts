/**
 * Wire-protocol surface the agent CORE consumes — sourced from the published
 * `@baizor/pipeline-protocol` package (repo
 * `github.com/IvanMurzak/pipeline-protocol`), which replaced the hand-rolled
 * vendored copy this file used to be (T8d de-vendoring).
 *
 * This module stays the runner's single import point for these shapes
 * (`./wire` / `../core/wire`), so the rest of the codebase keeps its import
 * paths unchanged. It re-exports the package surface the core needs:
 *   - the wire ENVELOPE (`WireFrame`, a local alias of the package's tolerant
 *     `AnyWireMessage`): every frame is `{ type, id?, …fields }` where `id` is
 *     the OPTIONAL correlation id — set on a request expecting a reply, echoed
 *     on the reply. Frames are additive-forward: unknown extra fields are
 *     PRESERVED, never rejected (zod `.passthrough()`).
 *   - the register handshake: `register` / `register_ack` / `register_reject`
 *     + `REGISTER_REJECT_REASONS`.
 *   - the heartbeat pair: `heartbeat` / `heartbeat_ack` + `RUNNER_STATUSES` +
 *     `HEARTBEAT_DIRECTIVES`.
 *   - `PROTOCOL_VERSION` + `isCompatible`.
 *
 * Inbound (untrusted) frames are validated with the package's zod schemas
 * (`.safeParse`; the guards return booleans/references, never zod output, so
 * the original frame object — extra fields included — always rides through
 * untouched). One deliberate exception: `isHeartbeatAck` stays hand-rolled —
 * see the note on it.
 */

import {
  AnyWireMessage,
  HEARTBEAT_DIRECTIVES,
  RegisterAckMessageSchema,
  RegisterRejectMessageSchema,
} from '@baizor/pipeline-protocol';
import type { HeartbeatAckMessage, RegisterAckMessage, RegisterRejectMessage } from '@baizor/pipeline-protocol';

// ── Protocol surface re-exported from the published package ─────────────────

export {
  HEARTBEAT_DIRECTIVES,
  isCompatible,
  PROTOCOL_VERSION,
  REGISTER_REJECT_REASONS,
  RUNNER_STATUSES,
} from '@baizor/pipeline-protocol';

export type {
  HeartbeatAckMessage,
  HeartbeatDirective,
  HeartbeatMessage,
  RegisterAckMessage,
  RegisterMessage,
  RegisterRejectMessage,
  RegisterRejectReason,
  RunnerStatus,
} from '@baizor/pipeline-protocol';

/**
 * The minimal wire envelope under the name the runner has always used: a
 * `type` discriminant plus an optional correlation `id`, with passthrough
 * semantics for everything else. Alias of the package's tolerant
 * `AnyWireMessage` (ANY `type` string is accepted so a newer same-major peer's
 * additive message types still route).
 */
export type WireFrame = AnyWireMessage;

// ── Runtime guards for INBOUND (untrusted) frames ───────────────────────────

/**
 * Parse a decoded JSON value into a well-formed wire frame, or null if it is
 * not one (not an object, missing/empty `type`, malformed `id`). Validates
 * with the package's tolerant `AnyWireMessage` schema but returns the ORIGINAL
 * object, so extra fields (and reference identity) are preserved exactly.
 */
export function parseWireFrame(value: unknown): WireFrame | null {
  return AnyWireMessage.safeParse(value).success ? (value as WireFrame) : null;
}

/** Narrow a frame to a well-formed `register_ack` (canonical zod schema). */
export function isRegisterAck(frame: WireFrame): frame is RegisterAckMessage {
  return RegisterAckMessageSchema.safeParse(frame).success;
}

/** Narrow a frame to a well-formed `register_reject` (canonical zod schema). */
export function isRegisterReject(frame: WireFrame): frame is RegisterRejectMessage {
  return RegisterRejectMessageSchema.safeParse(frame).success;
}

/**
 * Narrow a frame to a well-formed `heartbeat_ack`.
 *
 * KEPT HAND-ROLLED on purpose (not `HeartbeatAckMessageSchema.safeParse`): the
 * package schema refines the optional `ts` field to a strict ISO-8601 datetime
 * (`z.string().datetime({ offset: true })`), while this runner has always read
 * only `directive` and accepted any `ts`. Swapping in the schema would change
 * inbound acceptance — an ack whose `ts` does not parse as a strict datetime
 * would be dropped and count toward missed-ack liveness. Behavior is preserved
 * verbatim; tightening to the canonical schema is an owner decision.
 */
export function isHeartbeatAck(frame: WireFrame): frame is HeartbeatAckMessage {
  return (
    frame.type === 'heartbeat_ack' &&
    (frame.directive === undefined ||
      frame.directive === null ||
      (HEARTBEAT_DIRECTIVES as readonly string[]).includes(frame.directive as string))
  );
}
