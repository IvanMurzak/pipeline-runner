/**
 * The register handshake, agent side: build the opening `register` frame from
 * the stored identity, and interpret the server's reply.
 *
 *   - `register_ack`    → persist `runner_id` + adopt `heartbeat_interval_s`
 *                         (`applyRegisterAck`).
 *   - `register_reject` → classify: `upgrade_required` / `invalid_token` /
 *                         `revoked` are FATAL (reconnecting cannot help — do
 *                         NOT hot-loop); `capacity` is transient (retry with
 *                         backoff). `describeReject` renders the precise
 *                         operator-facing message per reason.
 *
 * department-mesh d7 (D17): `buildRegisterFrame` also attaches the identity's
 * `capabilities` (`./capabilities.ts`) when present — see that module's
 * PROTOCOL FOLLOW-UP note for why it rides the frame's additive
 * `.passthrough()` rather than a typed schema field.
 */

import type { AgentIdentity } from './config';
import type { ConfigStore } from './config';
import type { RegisterAckMessage, RegisterMessage, RegisterRejectMessage } from './wire';
import { PROTOCOL_VERSION } from './wire';

/**
 * Build the `register` frame — the FIRST frame on every connection. `id` is
 * the correlation id echoed by the reply.
 */
export function buildRegisterFrame(identity: AgentIdentity, id: string): RegisterMessage {
  const frame: RegisterMessage = {
    type: 'register',
    id,
    runner_token: identity.runner_token,
    labels: identity.labels,
    os: identity.os,
    agent_version: identity.agent_version,
    cli_version: identity.cli_version,
    plugin_version: identity.plugin_version ?? null,
    protocol_version: PROTOCOL_VERSION,
  };
  if (identity.capacity !== undefined) frame.capacity = identity.capacity;
  // d7 (D17): capability advertisement — additive passthrough field (no
  // typed schema slot in protocol 0.4.0 yet; see the module doc above).
  // Omitted (not `null`) when this identity predates d7 / was never
  // re-registered, exactly like `capacity` above.
  if (identity.capabilities !== undefined) frame.capabilities = identity.capabilities;
  return frame;
}

/**
 * Is a reject reason FATAL (stop; do not reconnect) or transient (retry with
 * backoff)? Unknown reasons from a newer server are treated as transient —
 * additive-forward: we cannot know they are unrecoverable.
 */
export function classifyReject(reason: string): 'fatal' | 'retryable' {
  switch (reason) {
    case 'upgrade_required':
    case 'invalid_token':
    case 'revoked':
      return 'fatal';
    default:
      return 'retryable';
  }
}

/** A precise operator-facing message per reject reason. Never includes the token. */
export function describeReject(reject: RegisterRejectMessage): string {
  const detail = reject.message ? ` (server: ${reject.message})` : '';
  switch (reject.reason) {
    case 'upgrade_required': {
      const min = reject.min_protocol_version !== undefined ? `v${reject.min_protocol_version}` : 'a newer protocol';
      return `update the agent (server requires protocol ${min}; this agent speaks v${PROTOCOL_VERSION})${detail}`;
    }
    case 'invalid_token':
      return `runner token was not accepted — check the token and re-run \`pipeline-runner register\`${detail}`;
    case 'revoked':
      return `runner token has been revoked — issue a new token from the control plane and re-register${detail}`;
    case 'capacity':
      return `server is at capacity — retrying with backoff${detail}`;
    default:
      return `register rejected: ${reject.reason as string}${detail}`;
  }
}

/**
 * Persist the ack's server-assigned identity: `runner_id` always,
 * `heartbeat_interval_s` when the server states one.
 */
export function applyRegisterAck(store: ConfigStore, ack: RegisterAckMessage): AgentIdentity {
  const patch: { runner_id: string; heartbeat_interval_s?: number } = { runner_id: ack.runner_id };
  if (ack.heartbeat_interval_s !== undefined) patch.heartbeat_interval_s = ack.heartbeat_interval_s;
  return store.update(patch);
}
