/**
 * Job-execution wire frames — sourced from the published
 * `@baizor/pipeline-protocol` package (repo
 * `github.com/IvanMurzak/pipeline-protocol`), which replaced the hand-rolled
 * vendored copy this file used to be (T8d de-vendoring).
 *
 * This module stays the jobs layer's single import point (`./wire`), so
 * internal import paths are unchanged. Re-exported surface:
 *   - `PipelineRef` + `lease` (server → agent): the job offer. A lease carries
 *     a checkout REFERENCE only — pipeline sources live in the user's git
 *     repo, never the cloud — plus a short-lived per-job JWT and the SLUGS
 *     (names) of declared secrets, never their values.
 *   - `accept` (agent → server): the runner takes the job; the envelope `id`
 *     ECHOES the lease's correlation id.
 *   - `run_status` (agent → server): compact run-lifecycle signal (`started` /
 *     `completed` / `halted`) — a routing convenience; the authoritative
 *     record is the uploaded event journal (the shipper's job).
 *   - T2-05 additive: the OPTIONAL `task` field (`LeaseTask`) + the `@task`
 *     `pipeline_ref.pipeline` sentinel (`TASK_PIPELINE_UNRESOLVED`) for
 *     task-dispatch leases.
 *   - T3-06 additive: the OPTIONAL `execution_overrides` field
 *     (`ExecutionOverrides`: `{ model?, effort? }`) carrying a matrix CELL's
 *     per-run model/effort.
 *
 * The envelope shape and the core frames (`register`/`heartbeat`/…) stay in
 * `../core/wire.ts`; this module only ADDS the job-execution frames. The
 * inbound (untrusted) `lease` is validated with the package's zod schema
 * (`.safeParse` + `.passthrough()`: extra fields ride along untouched). The
 * frame BUILDERS are runner-local helpers the package does not provide.
 */

import { LeaseMessageSchema } from '@baizor/pipeline-protocol';
import type { AcceptMessage, LeaseMessage, RunStatusMessage, RunStatusPhase } from '@baizor/pipeline-protocol';
import type { WireFrame } from '../core/wire';

// ── Protocol surface re-exported from the published package ─────────────────

export { RUN_STATUS_PHASES, TASK_PIPELINE_UNRESOLVED } from '@baizor/pipeline-protocol';

export type {
  AcceptMessage,
  ExecutionOverrides,
  LeaseMessage,
  LeaseTask,
  PipelineRef,
  RunStatusMessage,
  RunStatusPhase,
} from '@baizor/pipeline-protocol';

// ── Runtime guard for the INBOUND (untrusted) lease ──────────────────────────

/**
 * Narrow a frame to a well-formed `lease` (canonical zod schema). Extra fields
 * ride along untouched (the guard returns a boolean over the ORIGINAL frame —
 * nothing is copied or stripped). `task` (T2-05) and `execution_overrides`
 * (T3-06) are optional; when present they must be well-formed — leases without
 * them validate exactly as before. Value-VALIDITY of override contents (a
 * known model alias / effort level) is not checked here — that is
 * `computePlan`'s job (invalid → warn + inherit); the wire only rejects the
 * wrong SHAPE.
 */
export function isLeaseMessage(frame: WireFrame): frame is LeaseMessage {
  return LeaseMessageSchema.safeParse(frame).success;
}

// ── Frame builders (runner-local; the package ships schemas, not builders) ──

/** Build the `accept` reply for a lease, echoing its correlation `id`. */
export function buildAcceptFrame(lease: LeaseMessage, runnerId: string): AcceptMessage {
  const frame: AcceptMessage = {
    type: 'accept',
    runner_id: runnerId,
    job_id: lease.job_id,
    run_id: lease.run_id,
  };
  if (lease.id !== undefined) frame.id = lease.id;
  return frame;
}

/** Build a `run_status` frame. Fire-and-forget — no correlation id. */
export function buildRunStatusFrame(
  runId: string,
  jobId: string,
  phase: RunStatusPhase,
  detail?: { outcome?: string | null; halt_reason?: string | null }
): RunStatusMessage {
  const frame: RunStatusMessage = { type: 'run_status', run_id: runId, job_id: jobId, phase };
  if (detail?.outcome !== undefined) frame.outcome = detail.outcome;
  if (detail?.halt_reason !== undefined) frame.halt_reason = detail.halt_reason;
  return frame;
}
