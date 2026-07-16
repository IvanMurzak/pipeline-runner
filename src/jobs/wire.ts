/**
 * VENDORED from ai-pipeline `packages/protocol/src/wire` — source of truth;
 * replace with the published `@ai-pipeline/protocol` package once available
 * (npm publish blocked). Mirrors `@ai-pipeline/protocol` exactly; verify
 * against the source on every sync.
 *
 * Vendored subset (exactly what JOB EXECUTION needs — nothing more):
 *   - `PipelineRef` + `lease` (server → agent, `server.ts`): the job offer. A
 *     lease carries a checkout REFERENCE only — pipeline sources live in the
 *     user's git repo, never the cloud — plus a short-lived per-job JWT and the
 *     SLUGS (names) of declared secrets, never their values.
 *   - `accept` (agent → server, `client.ts`): the runner takes the job. The
 *     envelope `id` ECHOES the lease's correlation id.
 *   - `run_status` (agent → server, `client.ts`): compact run-lifecycle signal
 *     (`started` / `completed` / `halted`) — a routing convenience; the
 *     authoritative record is the uploaded event journal (the shipper's job).
 *   - T2-05 ADDITIVE (synced with the same source, protocol major still 1):
 *     the OPTIONAL `task` field (`LeaseTaskSchema`) and the `@task`
 *     `pipeline_ref.pipeline` sentinel (`TASK_PIPELINE_UNRESOLVED`) for
 *     task-dispatch leases. A lease WITHOUT `task` is the T2-03
 *     fixed-pipeline lease, byte-for-byte unchanged.
 *   - T3-06 ADDITIVE (same source, protocol major still 1): the OPTIONAL
 *     `execution_overrides` field (`ExecutionOverridesSchema`: `{ model?,
 *     effort? }`) carrying a matrix CELL's per-run model/effort. A lease
 *     WITHOUT it uses the pipeline's own defaults, byte-for-byte unchanged.
 *
 * The envelope shape and the core frames (`register`/`heartbeat`/...) stay in
 * `../core/wire.ts`; this module only ADDS the job-execution frames. The source
 * encodes these with zod `.passthrough()`; this copy hand-rolls the TS types
 * plus a runtime guard for the INBOUND (untrusted) `lease`. Field names,
 * optionality, and enum values match the zod schemas 1:1.
 */

import type { WireFrame } from '../core/wire';

/**
 * The pipeline a lease points a runner at (mirrors `PipelineRefSchema`).
 * Sources (PIPELINE.md + steps/**) live in the user's git repo, NEVER the
 * cloud, so the lease carries only a REFERENCE the runner resolves by checkout.
 */
export interface PipelineRef {
  [field: string]: unknown;
  /** Repo identity to fetch (git remote / `org/name`). */
  repo: string;
  /** Git ref to check out (branch / tag / sha). */
  ref: string;
  /** Pipeline name or path within the repo (under `.claude/pipeline/`). */
  pipeline: string;
  /** Pinned content hash (PIPELINE.md + steps/** + scripts/**), or null/absent
   *  for an unpinned "latest ref" lease. */
  content_hash?: string | null;
}

// ── T3-06 ADDITIVE: matrix-run execution overrides ───────────────────────────

/**
 * Per-cell execution overrides a MATRIX-run lease carries (T3-06, mirrors the
 * protocol `ExecutionOverridesSchema`): the model / reasoning-effort a single
 * matrix CELL runs the whole pipeline with. Both fields are OPTIONAL — a cell
 * may override only the model, only the effort, or (an empty object) neither.
 * These are RUN-LEVEL defaults (they replace the pipeline's default model /
 * effort for this cell), NOT per-step pins: a step that declares its own
 * `model:` keeps it. The runner threads `model` → `pipeline drive
 * --default-model` and `effort` → `--default-effort` (see jobs/drive.ts), which
 * the CLI feeds to `computePlan`'s `defaultModel` / `defaultEffort`. ABSENT ⇒
 * the run uses the pipeline's own defaults, byte-for-byte as before matrix runs.
 * Passthrough — extra fields ride along untouched.
 */
export interface ExecutionOverrides {
  [field: string]: unknown;
  /** Model this cell runs the pipeline with (alias `opus`/`sonnet`/… or a
   *  canonical `claude-*` id). Absent ⇒ keep the pipeline's default model. */
  model?: string;
  /** Reasoning-effort level this cell runs with (`low`|`medium`|`high`|`xhigh`|
   *  `max`). Absent ⇒ keep the pipeline's default effort. */
  effort?: string;
}

// ── T2-05 ADDITIVE: task-dispatch lease shape ────────────────────────────────

/**
 * Sentinel `pipeline_ref.pipeline` value for a TASK-dispatch lease (T2-05,
 * mirrors `TASK_PIPELINE_UNRESOLVED` in the protocol source): the cloud knows
 * the checkout target (repo/ref) but NOT the pipeline — the runner resolves it
 * locally by BM25-matching the lease's `task` text against the checked-out
 * project's own pipeline manifests (sources never live in the cloud). A lease
 * whose `pipeline_ref.pipeline` equals this sentinel MUST also carry a `task`
 * field; a runner MUST NOT try to check out a pipeline by this name.
 */
export const TASK_PIPELINE_UNRESOLVED = '@task' as const;

/**
 * The natural-language WORK ITEM a task-dispatch lease carries (T2-05, mirrors
 * `LeaseTaskSchema`): exactly what the runner's deterministic BM25 matcher
 * needs to pick a pipeline from the checked-out project's local manifests —
 * the task identity plus the text (`title` + `body`) and `labels` it matches
 * on. NO pipeline identity here by design: the match happens ON THE RUNNER.
 * Passthrough — extra fields ride along untouched.
 */
export interface LeaseTask {
  [field: string]: unknown;
  /** The control-plane task id (tasks.id) — echoes through run provenance. */
  task_id: string;
  /** Short human title (part of the BM25 match input). */
  title: string;
  /** The full natural-language task text the runner BM25-matches. May be
   *  empty when the title says it all. */
  body: string;
  /** Task labels (routing/BM25 hints). */
  labels: string[];
}

/**
 * `lease` (server → agent) — offer a queued run to a runner whose labels match.
 * The envelope `id` is the correlation id the runner echoes on `accept`.
 * `job_jwt` is a SECRET (short-lived, job-scoped) — never log it; only
 * `secret_slugs` (names) ride the lease, never secret values.
 *
 * T2-05 ADDITIVE: an OPTIONAL `task` field turns the lease into a
 * task-dispatch — `pipeline_ref` then carries the checkout target only
 * (`pipeline` = `TASK_PIPELINE_UNRESOLVED`, `content_hash` null) and the
 * runner resolves the pipeline by BM25 over its local manifests before
 * driving. ABSENT ⇒ the T2-03 fixed-pipeline lease, unchanged.
 */
export interface LeaseMessage extends WireFrame {
  type: 'lease';
  /** The offered job. */
  job_id: string;
  /** The run this job executes. */
  run_id: string;
  pipeline_ref: PipelineRef;
  /** The labels this offer was matched on. */
  labels: string[];
  /** Short-lived per-job JWT (opaque here) — SECRET, never log. */
  job_jwt: string;
  /** Declared-secret SLUGS only — never values. */
  secret_slugs: string[];
  /** Lease heartbeat TTL in seconds: miss it mid-run and the run is marked
   *  interrupted. The existing heartbeat loop keeps the lease alive. */
  lease_ttl_s?: number;
  /** T2-05 ADDITIVE — OPTIONAL task-dispatch work item. Present ⇒ the runner
   *  BM25-resolves the pipeline locally; absent ⇒ the T2-03 fixed-pipeline
   *  lease, unchanged. */
  task?: LeaseTask;
  /** T3-06 ADDITIVE — OPTIONAL per-cell matrix execution overrides (model /
   *  effort). Present ⇒ the runner drives this cell with those run-level
   *  defaults; absent ⇒ the pipeline's own defaults, unchanged. */
  execution_overrides?: ExecutionOverrides;
}

/**
 * `accept` (agent → server) — the runner accepts a `lease`. Echo the lease's
 * correlation `id` on the envelope so the gateway pairs acceptance to offer.
 */
export interface AcceptMessage extends WireFrame {
  type: 'accept';
  runner_id: string;
  /** The job being accepted (from the `lease`). */
  job_id: string;
  /** The run this job executes. */
  run_id: string;
}

/** The run-lifecycle phase a `run_status` reports (mirrors `client.ts`). */
export const RUN_STATUS_PHASES = ['started', 'completed', 'halted'] as const;
export type RunStatusPhase = (typeof RUN_STATUS_PHASES)[number];

/**
 * `run_status` (agent → server) — a compact run-lifecycle signal. The
 * authoritative record remains the uploaded events; this is a
 * routing/notification convenience. Fire-and-forget (no `id`).
 */
export interface RunStatusMessage extends WireFrame {
  type: 'run_status';
  run_id: string;
  /** The job this run executes (from the lease). */
  job_id?: string;
  phase: RunStatusPhase;
  /** Terminal outcome for `completed`. Null/absent while `started`. */
  outcome?: string | null;
  /** Halt reason for `halted`. */
  halt_reason?: string | null;
}

// ── Runtime guard for the INBOUND (untrusted) lease ──────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === 'string');
}

function isPipelineRef(v: unknown): v is PipelineRef {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const record = v as Record<string, unknown>;
  return (
    isNonEmptyString(record.repo) &&
    isNonEmptyString(record.ref) &&
    isNonEmptyString(record.pipeline) &&
    (record.content_hash === undefined || record.content_hash === null || isNonEmptyString(record.content_hash))
  );
}

/** T2-05 ADDITIVE: narrow to a well-formed `LeaseTask` (mirrors
 *  `LeaseTaskSchema`: `body` may be empty, `title`/`task_id` may not;
 *  extra fields ride along untouched). */
function isLeaseTask(v: unknown): v is LeaseTask {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const record = v as Record<string, unknown>;
  return (
    isNonEmptyString(record.task_id) &&
    isNonEmptyString(record.title) &&
    typeof record.body === 'string' &&
    isStringArray(record.labels)
  );
}

/** T3-06 ADDITIVE: narrow to well-formed `ExecutionOverrides` (mirrors
 *  `ExecutionOverridesSchema`: both `model` and `effort` OPTIONAL; when
 *  present each must be a non-empty string; an empty object is valid — a cell
 *  overriding nothing. Extra fields ride along untouched). Value-VALIDITY
 *  (a known model alias / effort level) is not checked here — that is
 *  `computePlan`'s job (invalid → warn + inherit); this guard only rejects the
 *  wrong SHAPE. */
function isExecutionOverrides(v: unknown): v is ExecutionOverrides {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const record = v as Record<string, unknown>;
  return (
    (record.model === undefined || isNonEmptyString(record.model)) &&
    (record.effort === undefined || isNonEmptyString(record.effort))
  );
}

/** Narrow a frame to a well-formed `lease`. Extra fields ride along untouched.
 *  T2-05 ADDITIVE: `task` is optional; when PRESENT it must be a well-formed
 *  `LeaseTask` — leases without it validate exactly as before. T3-06 ADDITIVE:
 *  `execution_overrides` is optional; when PRESENT it must be well-formed —
 *  leases without it validate exactly as before. */
export function isLeaseMessage(frame: WireFrame): frame is LeaseMessage {
  return (
    frame.type === 'lease' &&
    isNonEmptyString(frame.job_id) &&
    isNonEmptyString(frame.run_id) &&
    isPipelineRef(frame.pipeline_ref) &&
    isStringArray(frame.labels) &&
    isNonEmptyString(frame.job_jwt) &&
    isStringArray(frame.secret_slugs) &&
    (frame.lease_ttl_s === undefined ||
      (typeof frame.lease_ttl_s === 'number' && Number.isInteger(frame.lease_ttl_s) && frame.lease_ttl_s > 0)) &&
    (frame.task === undefined || isLeaseTask(frame.task)) &&
    (frame.execution_overrides === undefined || isExecutionOverrides(frame.execution_overrides))
  );
}

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
