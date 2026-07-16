/**
 * Privacy-tier filter — THE trust boundary of the shipper.
 *
 * Enforced AGENT-SIDE, BEFORE anything is persisted to the spool or uploaded:
 * the cloud must never receive above-tier data. Tiers (ARCHITECTURE §1,
 * "Privacy tiers — data never leaves the box above its tier"):
 *
 *   - `metadata` (DEFAULT): step statuses, timings, token/cost counts,
 *     tool-call counts, model/effort ids, outcome taxonomy, FAIL summaries.
 *     Implemented as a POSITIVE ALLOWLIST per event type — an unknown event
 *     type ships with its `data` fully stripped, and an unknown field inside a
 *     known type is DROPPED by default. New fields never leak.
 *   - `events`: the full event stream and stats detail, verbatim.
 *   - `full`: + step transcripts and logs. Transcript/log shipping is NOT yet
 *     implemented (scope-flagged in T1-12); `full` currently ships exactly
 *     what `events` ships.
 *
 * Field rules at the `metadata` tier:
 *   - keep         — copied verbatim (ids, counts, flags, taxonomy, names).
 *   - fingerprint  — ABSOLUTE MACHINE PATHS (`project_root`, `worktree`,
 *     `pipeline_root`, worktree hook paths) are replaced with a deterministic
 *     `fp:<sha256-16>` so the value still correlates across events/restarts
 *     without revealing the path (usernames, client names). Deterministic ⇒
 *     dictionary-attackable for guessable paths; set `fingerprintSalt`
 *     (config/env) to harden. Null passes through as null.
 *   - summary      — the FAIL-summary text fields ARCHITECTURE grants the
 *     metadata tier (`halt_reason`): kept but TRUNCATED to a bounded length.
 *   - question     — `awaiting_input.question`: the question text/context/
 *     options are CONTENT and are replaced with a schema-valid placeholder
 *     (`{ text: QUESTION_PLACEHOLDER, question_id? }`) so the server's strict
 *     parse — and its awaiting-input derivation — still works while zero
 *     authored content leaves the machine.
 *
 * Pipeline-RELATIVE step identity (`iteration_path`, `step_id`, `script_path`,
 * pipeline/branch names, tool names) is metadata: it is pipeline STRUCTURE the
 * product's metadata-tier dashboards are built on ("failing step index", per-
 * step statuses) and the ingest derivation correlates open/close on it.
 *
 * Unknown journal lines that are not JSON objects cannot be classified and are
 * never shipped at any tier (the G2 run_id rule already excludes them).
 */

import { createHash } from 'node:crypto';

export const PRIVACY_TIERS = ['metadata', 'events', 'full'] as const;
export type PrivacyTier = (typeof PRIVACY_TIERS)[number];

/** The fail-closed default: the most private tier. */
export const DEFAULT_PRIVACY_TIER: PrivacyTier = 'metadata';

/** Env var the tier may be configured through (config option wins). */
export const PRIVACY_TIER_ENV = 'PIPELINE_PRIVACY_TIER';
/** Env var for the optional fingerprint salt. */
export const PRIVACY_SALT_ENV = 'PIPELINE_PRIVACY_SALT';

/** Replaces `awaiting_input.question.text` at the metadata tier. */
export const QUESTION_PLACEHOLDER = '[question content stripped: privacy tier metadata]';

/** `summary` fields are truncated to this many characters at metadata tier. */
export const SUMMARY_MAX_CHARS = 256;

/**
 * Resolve the effective tier FAIL-CLOSED: an explicit valid tier wins, else a
 * valid env value, else `metadata`. Anything unrecognized degrades to
 * `metadata` (never to a more permissive tier) and reports itself via the
 * returned `warning`.
 */
export function resolvePrivacyTier(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env
): { tier: PrivacyTier; warning: string | null } {
  for (const [value, source] of [
    [explicit, 'config'],
    [env[PRIVACY_TIER_ENV], `env ${PRIVACY_TIER_ENV}`],
  ] as const) {
    if (value === undefined || value === '') continue;
    if ((PRIVACY_TIERS as readonly string[]).includes(value)) {
      return { tier: value as PrivacyTier, warning: null };
    }
    return {
      tier: DEFAULT_PRIVACY_TIER,
      warning: `unrecognized privacy tier '${value}' (${source}) — failing closed to '${DEFAULT_PRIVACY_TIER}'`,
    };
  }
  return { tier: DEFAULT_PRIVACY_TIER, warning: null };
}

/** Deterministic `fp:<sha256-16>` fingerprint (optionally salted). */
export function fingerprintString(value: string, salt = ''): string {
  return `fp:${createHash('sha256').update(`${salt}${value}`).digest('hex').slice(0, 16)}`;
}

// ── The metadata-tier allowlists ─────────────────────────────────────────────

type FieldRule = 'keep' | 'fingerprint' | 'summary' | 'question';

/** Envelope fields kept at the metadata tier. Anything else on the envelope
 *  (a newer peer's passthrough addition) is dropped. */
const ENVELOPE_ALLOWLIST: Record<string, FieldRule> = {
  schema: 'keep',
  ts: 'keep',
  type: 'keep',
  run_id: 'keep',
  parent_run_id: 'keep',
  session_id: 'keep',
  project_root: 'fingerprint',
  worktree: 'fingerprint',
};

/**
 * Per-event-type `data` allowlists at the metadata tier — mirrors the v4+v5
 * event `data` schemas in ai-pipeline `packages/protocol/src/events/types.ts`
 * field-for-field. A type absent from this table ships `data: {}`.
 */
const DATA_ALLOWLISTS: Record<string, Record<string, FieldRule>> = {
  'session.opened': { claude_pid: 'keep' },
  'pipeline.started': {
    pipeline_name: 'keep',
    first_iteration_path: 'keep',
    pipeline_root: 'fingerprint',
    default_model: 'keep',
  },
  'iteration.started': {
    iteration_path: 'keep',
    index: 'keep',
    resolved_model: 'keep',
    resolved_effort: 'keep',
    step_id: 'keep',
    step_type: 'keep',
    resumed: 'keep',
    emission: 'keep',
  },
  'iteration.resumed': {
    iteration_path: 'keep',
    index: 'keep',
    resolved_model: 'keep',
    resolved_effort: 'keep',
    step_id: 'keep',
    resumed: 'keep',
    emission: 'keep',
  },
  'iteration.completed': {
    iteration_path: 'keep',
    outcome: 'keep',
    next_iteration_path: 'keep',
    has_improvement_brief: 'keep',
    has_blocker_delegation: 'keep',
    halt_reason: 'summary',
    terminal: 'keep',
    step_id: 'keep',
    step_type: 'keep',
    failure_class: 'keep',
  },
  'improver.started': { iteration_path: 'keep' },
  'improver.completed': { iteration_path: 'keep', applied: 'keep', has_script_brief: 'keep' },
  'script_creator.started': { iteration_path: 'keep' },
  'script_creator.completed': { iteration_path: 'keep', script_path: 'keep', outcome: 'keep' },
  'blocker.delegated': {
    parent_iteration_path: 'keep',
    blocker_issue_url: 'keep',
    child_run_id: 'keep',
    blocker_target_repo: 'keep',
  },
  'blocker.polling': { blocker_issue_url: 'keep', pr_state: 'keep' },
  'blocker.resolved': { blocker_issue_url: 'keep', merged_pr_url: 'keep' },
  'pipeline.completed': { pipeline_name: 'keep' },
  'pipeline.halted': { pipeline_name: 'keep', iteration_path: 'keep', halt_reason: 'summary' },
  'manager.stopped': { run_id: 'keep', agent_id: 'keep' },
  'worktree.created': {
    worktree_path: 'fingerprint',
    branch: 'keep',
    env_file: 'fingerprint',
    port_base: 'keep',
    ok: 'keep',
    hook_dir: 'fingerprint',
    // `detail` (free-text hook stderr) is deliberately ABSENT: dropped.
  },
  'worktree.finalized': { worktree_path: 'fingerprint', ok: 'keep', outcome: 'keep' },
  'worktree.destroyed': { worktree_path: 'fingerprint', ok: 'keep', outcome: 'keep' },
  'tool.called': { tool_name: 'keep', success: 'keep', agent_spawn: 'keep', tool_use_id: 'keep' },
  'turn.usage': {
    assistant_turns: 'keep',
    input_tokens: 'keep',
    output_tokens: 'keep',
    cache_read_tokens: 'keep',
    cache_creation_tokens: 'keep',
  },
  'run.started': {
    pipeline_name: 'keep',
    pipeline_root: 'fingerprint',
    first_iteration_path: 'keep',
    orchestrator: 'keep',
    default_model: 'keep',
  },
  'run.completed': { pipeline_name: 'keep', outcome: 'keep' },
  'run.halted': { pipeline_name: 'keep', iteration_path: 'keep', halt_reason: 'summary' },
  awaiting_input: { run_id: 'keep', iteration: 'keep', question_id: 'keep', question: 'question' },
  // Synthetic stats record (shipper-emitted, see ./stats.ts) — its own nested
  // filter runs first; the entry here lets the envelope-level walk pass the
  // already-filtered record through.
  'stats.run_record': {},
};

/** The nested allowlists for the synthetic `.stats` run record (mirrors the
 *  OSS `apps/pipeline-cli/src/lib/stats.ts` RunRecord/StepStat/TokenStats). */
const STATS_RECORD_ALLOWLIST: Record<string, FieldRule> = {
  schema: 'keep',
  run_id: 'keep',
  pipeline: 'keep',
  started_at: 'keep',
  ended_at: 'keep',
  duration_s: 'keep',
  outcome: 'keep',
  halt_reason: 'summary',
  runner: 'keep',
  mode: 'keep',
  steps_run: 'keep',
  improver_runs: 'keep',
  improver_applied: 'keep',
  scripts_created: 'keep',
  merges: 'keep',
  merge_conflicts: 'keep',
  llm_steps: 'keep',
};

const STATS_STEP_ALLOWLIST: Record<string, FieldRule> = {
  id: 'keep',
  started_at: 'keep',
  seconds: 'keep',
  outcome: 'keep',
  model: 'keep',
  effort: 'keep',
  step_type: 'keep',
  failure_class: 'keep',
};

const STATS_TOKENS_ALLOWLIST: Record<string, FieldRule> = {
  input: 'keep',
  output: 'keep',
  cache_read: 'keep',
  cache_creation: 'keep',
  tools_called: 'keep',
  tools_failed: 'keep',
  failed_tools: 'keep', // tool-name → count map: names + counts are metadata
  agents_spawned: 'keep',
  cost_usd: 'keep',
};

// ── Filtering ────────────────────────────────────────────────────────────────

export interface PrivacyFilterOptions {
  /** Optional salt hardening the deterministic path fingerprints. */
  fingerprintSalt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyRule(rule: FieldRule, value: unknown, salt: string): unknown {
  switch (rule) {
    case 'keep':
      return value;
    case 'fingerprint':
      return typeof value === 'string' && value.length > 0 ? fingerprintString(value, salt) : value === null ? null : undefined;
    case 'summary':
      if (typeof value === 'string') {
        return value.length > SUMMARY_MAX_CHARS ? `${value.slice(0, SUMMARY_MAX_CHARS)}…` : value;
      }
      return value === null ? null : undefined;
    case 'question': {
      if (!isRecord(value)) return undefined;
      const placeholder: Record<string, unknown> = { text: QUESTION_PLACEHOLDER };
      if (typeof value.question_id === 'string' && value.question_id.length > 0) {
        placeholder.question_id = value.question_id;
      }
      return placeholder;
    }
  }
}

function filterByAllowlist(
  source: Record<string, unknown>,
  allowlist: Record<string, FieldRule>,
  salt: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, rule] of Object.entries(allowlist)) {
    if (!(field in source)) continue;
    const filtered = applyRule(rule, source[field], salt);
    if (filtered !== undefined) out[field] = filtered;
  }
  return out;
}

/** Filter the synthetic `.stats` run record (nested allowlists). */
export function filterStatsRecordMetadata(
  record: Record<string, unknown>,
  options: PrivacyFilterOptions = {}
): Record<string, unknown> {
  const salt = options.fingerprintSalt ?? '';
  const out = filterByAllowlist(record, STATS_RECORD_ALLOWLIST, salt);
  if (Array.isArray(record.steps)) {
    out.steps = record.steps.map((step) => (isRecord(step) ? filterByAllowlist(step, STATS_STEP_ALLOWLIST, salt) : {}));
  }
  if (isRecord(record.tokens)) out.tokens = filterByAllowlist(record.tokens, STATS_TOKENS_ALLOWLIST, salt);
  else if (record.tokens === null) out.tokens = null;
  return out;
}

/**
 * Filter ONE journal event for the given tier. `event` must already be a JSON
 * object (non-object lines are unshippable upstream).
 *
 *   - `events` / `full`: the event passes VERBATIM.
 *   - `metadata`: envelope + data are rebuilt from the positive allowlists —
 *     unknown event type ⇒ `data: {}`; unknown field ⇒ dropped; paths ⇒
 *     fingerprints; question ⇒ placeholder; fail summaries ⇒ truncated.
 */
export function filterEventForTier(
  event: Record<string, unknown>,
  tier: PrivacyTier,
  options: PrivacyFilterOptions = {}
): Record<string, unknown> {
  if (tier === 'events' || tier === 'full') return event;

  const salt = options.fingerprintSalt ?? '';
  const out = filterByAllowlist(event, ENVELOPE_ALLOWLIST, salt);

  const type = typeof event.type === 'string' ? event.type : '';
  const dataAllowlist = DATA_ALLOWLISTS[type];
  const data = isRecord(event.data) ? event.data : {};
  if (type === 'stats.run_record') {
    out.data = filterStatsRecordMetadata(data, options);
  } else if (dataAllowlist !== undefined) {
    out.data = filterByAllowlist(data, dataAllowlist, salt);
  } else {
    // Unknown/new event type: default STRIPPED — never leaked.
    out.data = {};
  }
  return out;
}
