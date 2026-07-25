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
 *
 * department-mesh d5 (P6, `13-mcp-authorization.md` §10.2): the frame's
 * `runner_token` field now carries EITHER credential class — a short-lived
 * `runner:register` JWT for a migrated runner, or the legacy plaintext token
 * for one that has not migrated. **No protocol change is involved**: the wire
 * field is `z.string().min(1)` and the cloud classifies what arrived
 * (`cloud/apps/api/src/modules/gateway/register-credential.ts`). Choosing
 * between the two is `./register-credential.ts`'s job, not this module's.
 */

import type { AgentIdentity } from './config';
import type { ConfigStore } from './config';
import type { RegisterAckMessage, RegisterMessage, RegisterRejectMessage } from './wire';
import { PROTOCOL_VERSION } from './wire';

/**
 * Build the `register` frame — the FIRST frame on every connection. `id` is
 * the correlation id echoed by the reply.
 *
 * `credential` is the value for the frame's `runner_token` field (d5). Omitted
 * ⇒ the identity's legacy `runner_token`, which is the pre-P6 behaviour and the
 * shape every existing caller/test uses. It throws only when there is nothing
 * at all to present, which `ConfigStore.load()` already rejects upstream.
 */
export function buildRegisterFrame(identity: AgentIdentity, id: string, credential?: string): RegisterMessage {
  const runnerToken = credential ?? identity.runner_token;
  if (runnerToken === undefined || runnerToken.length === 0) {
    throw new Error('cannot build a register frame: no register credential available');
  }
  const frame: RegisterMessage = {
    type: 'register',
    id,
    runner_token: runnerToken,
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
      // d5 (P6): the cloud reuses this reason for a RETIRED legacy credential
      // as well as a protocol mismatch (c15's `register-credential.ts`), and
      // the two have opposite fixes. The server's `message` says which; naming
      // both here means an operator is never left guessing when it does not.
      const min = reject.min_protocol_version !== undefined ? `v${reject.min_protocol_version}` : 'a newer protocol';
      return (
        `update the agent (server requires protocol ${min}; this agent speaks v${PROTOCOL_VERSION})` +
        ` — or, if this runner's legacy token has been retired, install its OAuth client secret with` +
        ` \`pipeline-runner set-credentials\`${detail}`
      );
    }
    case 'invalid_token':
      return `runner credential was not accepted — check the credential and re-run \`pipeline-runner register\`${detail}`;
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
