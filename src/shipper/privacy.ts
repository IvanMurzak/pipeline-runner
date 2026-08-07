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
 *   - `events`: the full event stream and stats detail, verbatim — EXCEPT
 *     `RunFailureDetail.error` excerpts in stats records, which the stats
 *     ship path strips at EVERY tier (design D16 / G-sec-2, see
 *     `stripStatsFailureExcerpts`).
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
 * Step identity (`iteration_path`, `step_name` — `step_id` before schema v5 —
 * `script_path`, pipeline/branch names, tool names) is metadata: it is pipeline
 * STRUCTURE the product's metadata-tier dashboards are built on ("failing step
 * index", per-step statuses) and the ingest derivation correlates open/close on
 * it. It is kept — but PIPELINE-RELATIVE is now ENFORCED rather than assumed;
 * see SG4 below.
 *
 * ── SG4: the SHAPE of a value decides, not the NAME of its field ────────────
 *
 * The paragraph above used to read "Pipeline-RELATIVE step identity … is
 * metadata", and the word RELATIVE was carrying the whole rule while nothing
 * checked it. It was a claim about the EMITTER, and the emitter did not honour
 * it: the CLI's `PlanStep.path` is absolute by construction, so every
 * `keep`-classified path field shipped whatever it was handed, verbatim.
 * `C:\Users\<account>\…` reached the production `events` table for three weeks
 * (2026-07-19 → 2026-08-07, 17 rows; found by ux-v2 `i1`'s SG4 check).
 *
 * A field-name patch does not close it. Two reasons, both load-bearing:
 * `stats.failures[].step` is `keep`-classified and is not `*_path`-named, and a
 * `halt_reason` summary drags a path onto the wire inside free text where no
 * field-name rule could ever see it.
 *
 * So the rule is about the VALUE. After the allowlist has run, EVERY string
 * leaf of the filtered payload, at any depth, is put through:
 *
 *   1. RELATIVIZE against the run's OWN roots — `project_root`/`worktree` on
 *      the envelope and `pipeline_root`/`worktree_path`/`hook_dir` inside
 *      `data`, read from the UNFILTERED event (by the time the allowlist has
 *      run those are already `fp:…` and name nothing), plus any root the caller
 *      knows and passes as {@link PrivacyFilterOptions.pathRoots}. The
 *      remainder ships POSIX-separated —
 *      `.pipeline/<pipeline>/steps/01-prepare.md` — which is the label the
 *      dashboards wanted all along, and it is what finally makes
 *      `iteration.started` and `iteration.completed` agree on one value.
 *   2. FAIL CLOSED. Anything still path-shaped after step 1 — a path under no
 *      known root, a path embedded in free text, a relativized remainder that
 *      still names the OS account — becomes the same deterministic
 *      `fp:<sha256-16>` this file already uses. Correlatable, disclosing
 *      nothing. NO branch returns a raw absolute path.
 *
 * `events`/`full` are unaffected: they pass the event VERBATIM by contract, and
 * at those tiers the TIER is the control rather than any one field.
 *
 * The rule and its arbiter regex are ported from ux-v2 `b22`, which composed
 * exactly this over the filter at the CLI's two seams while waiting for it to
 * land HERE (`b23`). That composition is deleted: there is one rule, and this
 * is it.
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

/** Replaces `department.message.parts` at the metadata tier (department-mesh,
 *  task d1) — mirrors `QUESTION_PLACEHOLDER`'s stance: a department's message
 *  content is authored task content, not metadata, so it is redacted by
 *  default exactly like a pipeline question's text. */
export const MESSAGE_PARTS_PLACEHOLDER = '[message content stripped: privacy tier metadata]';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── SG4: the path rule (see this module's header) ────────────────────────────
//
// Everything in this section is PURE and takes no dependency beyond
// `node:crypto` above — deliberately, because the protocol package's
// conformance test pins this file's import list ("a second import is a new data
// path into the trust boundary and must be reviewed, not merged silently") and
// this filter travels as a vendored copy into trees with no install step. That
// is why the OS account name is read out of the environment below instead of
// through `node:os`'s `homedir()`, and why the home directory's last segment is
// split by hand instead of through `node:path`'s `basename()` — which would in
// any case apply the WRONG platform's rules, since a Windows-shaped path is
// routinely scrubbed on a Linux CI runner and vice versa.

/**
 * THE ARBITER. Transcribed verbatim from the parent monorepo's
 * `scripts/i1-production-e2e/check-sg4.mjs` (`PATH_RE`) — the SG4 check that
 * found this defect in the production `events` table — so "the filter is
 * correct" and "the production check is clean" are the same statement. A
 * payload is compliant exactly when this expression matches no string in it, at
 * any depth.
 *
 * The leading `(^|[^A-Za-z0-9])` guard is load-bearing and deliberately kept:
 * without it `https://host/x` matches the drive-letter branch on `s:/`.
 */
export const SG4_PATH_RE =
  /(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\\\[A-Za-z0-9_.-]+\\)/;

/** A value that IS a path, in any of the three absolute forms. Broader than
 *  {@link SG4_PATH_RE} on purpose: a bare POSIX `/opt/proj/steps/01.md` does
 *  not trip the arbiter but is still a machine path we would rather relativize
 *  than ship. `//` is excluded from the POSIX branch so a protocol-relative
 *  URL is not mistaken for a UNC share. */
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const UNC_ABS_RE = /^[\\/]{2}[^\\/]+[\\/]/;
const POSIX_ABS_RE = /^\/(?!\/)/;

/** Absolute-path runs EMBEDDED in a longer string (a truncated `halt_reason`,
 *  a FAIL summary). Same three shapes as the arbiter, with the same guard, plus
 *  a bounded tail charset so a path inside prose stops at whitespace or a
 *  quote. Group 1 is the guard character and is preserved; group 2 is the
 *  path. */
const EMBEDDED_PATH_RE =
  /(^|[^A-Za-z0-9])((?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_.-]+\\|\/Users\/|\/home\/)[^\s"'`<>|]*)/g;

/** Whether a string is shaped like a path at all (bounds the account-name
 *  sweep — see {@link hasAccountNameSegment}). */
function isPathLike(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

/** Whether the WHOLE value is an absolute path. */
export function looksAbsolutePath(value: string): boolean {
  return WINDOWS_ABS_RE.test(value) || UNC_ABS_RE.test(value) || POSIX_ABS_RE.test(value);
}

/** The last `\`- or `/`-separated segment of a path, platform-independently. */
function lastPathSegment(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/);
  return parts[parts.length - 1] ?? '';
}

/** This machine's home directory, from the environment only. `USERPROFILE` is
 *  the Windows spelling, `HOME` the POSIX one — the two `os.homedir()` itself
 *  consults first. */
function homeFromEnv(env: Record<string, string | undefined>): string | null {
  const home = (env.USERPROFILE ?? env.HOME ?? '').trim();
  return home.length > 0 ? home : null;
}

/**
 * Every name this machine's OS account could appear under in a path —
 * `USERNAME`/`USER`/`LOGNAME` and the last segment of the home directory
 * (`C:\Users\IvanD` → `IvanD`, `/home/ivan` → `ivan`, `/Users/ivan` → `ivan`).
 *
 * Injectable, and never throws: this runs on a hot path in a process that must
 * not fail for a telemetry reason. Names shorter than two characters are
 * dropped — a one-character account name would match half the world's path
 * segments, and the absolute-path rule already covers the disclosure that
 * matters.
 */
export function defaultAccountNames(
  env: Record<string, string | undefined> = process.env,
  home: string | null = homeFromEnv(env)
): string[] {
  const out = new Set<string>();
  const add = (value: string | undefined | null): void => {
    const v = (value ?? '').trim();
    if (v.length >= 2) out.add(v.toLowerCase());
  };
  add(env.USERNAME);
  add(env.USER);
  add(env.LOGNAME);
  if (home !== null) add(lastPathSegment(home));
  return [...out];
}

/**
 * Whether a PATH-LIKE string carries an account name as a whole segment.
 *
 * Scoped to path-like strings on purpose, and the boundary is stated rather
 * than hidden: the disclosure SG4 names is "absolute paths carrying the OS
 * username", i.e. the filesystem layout. A bare token that happens to equal the
 * account name with no path around it (a step named `runner` on a CI box whose
 * account is `runner`) is not a layout disclosure, and redacting it would
 * silently corrupt step identity for every consumer downstream.
 */
function hasAccountNameSegment(value: string, accountNames: readonly string[]): boolean {
  if (accountNames.length === 0 || !isPathLike(value)) return false;
  for (const seg of value.split(/[\\/]+/)) {
    if (seg && accountNames.includes(seg.toLowerCase())) return true;
  }
  return false;
}

/** Envelope-level fields that name a machine root. */
const ENVELOPE_ROOT_KEYS = ['project_root', 'worktree'] as const;
/** `data`-level fields that name a machine root. */
const DATA_ROOT_KEYS = ['pipeline_root', 'worktree_path', 'hook_dir'] as const;

/**
 * The roots an absolute path in THIS event may legitimately be made relative
 * to — read out of the event itself, plus whatever the caller knows.
 *
 * Read from the UNFILTERED event: by the time the allowlist has run,
 * `project_root` is already `fp:<hash>` and names nothing.
 *
 * Sorted longest-first so the most specific root wins — a worktree nested
 * inside the project root must relativize against the worktree.
 */
export function collectPathRoots(
  event: unknown,
  extra: readonly (string | null | undefined)[] = []
): string[] {
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const v = value.replace(/[\\/]+$/, '');
    if (v.length > 0 && looksAbsolutePath(v)) seen.add(v);
  };
  for (const v of extra) add(v);
  if (isRecord(event)) {
    for (const k of ENVELOPE_ROOT_KEYS) add(event[k]);
    const data = event.data;
    if (isRecord(data)) for (const k of DATA_ROOT_KEYS) add(data[k]);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** Normalize separators for comparison; the emitted form is always POSIX. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * `path` expressed relative to `root`, or null when it is not under it.
 *
 * Deliberately string-wise rather than `node:path.relative`, for the reason
 * given at the top of this section. Comparison is case-insensitive in both
 * directions — on NTFS that is correct, and on a case-sensitive filesystem the
 * only effect is that we relativize slightly MORE often, which is the safe
 * direction.
 */
function relativeUnder(path: string, root: string): string | null {
  const p = toPosix(path);
  const r = toPosix(root).replace(/\/+$/, '');
  if (r.length === 0) return null;
  const pl = p.toLowerCase();
  const rl = r.toLowerCase();
  if (pl === rl) return '.';
  if (!pl.startsWith(`${rl}/`)) return null;
  const rest = p.slice(r.length + 1).replace(/^\/+/, '');
  return rest.length > 0 ? rest : '.';
}

export interface PathScrubOptions {
  /** Roots an absolute path may be relativized against, longest-first. */
  roots?: readonly string[];
  /** Names that must never survive as a path segment. Defaults to
   *  {@link defaultAccountNames}. */
  accountNames?: readonly string[];
  /** The salt this filter fingerprints with, so a path that cannot be
   *  relativized correlates with the same run's other fingerprints. */
  fingerprintSalt?: string;
}

interface ResolvedScrubOptions {
  roots: readonly string[];
  accountNames: readonly string[];
  salt: string;
}

function resolveScrubOptions(options: PathScrubOptions): ResolvedScrubOptions {
  return {
    roots: options.roots ?? [],
    accountNames: options.accountNames ?? defaultAccountNames(),
    salt: options.fingerprintSalt ?? '',
  };
}

/** Is this string safe to ship as-is? The arbiter, plus the account-name rule. */
function isShippable(value: string, opts: ResolvedScrubOptions): boolean {
  return !SG4_PATH_RE.test(value) && !hasAccountNameSegment(value, opts.accountNames);
}

/** One absolute path → the value that ships in its place. Relativized under the
 *  most specific root that contains it and still passes {@link isShippable};
 *  otherwise the fingerprint. Never returns the input. */
function transformPath(path: string, opts: ResolvedScrubOptions): string {
  for (const root of opts.roots) {
    const rel = relativeUnder(path, root);
    if (rel !== null && isShippable(rel, opts)) return rel;
  }
  return fingerprintString(path, opts.salt);
}

/**
 * Scrub ONE string. Three cases, in order:
 *
 *   1. the whole value is an absolute path  → {@link transformPath};
 *   2. the value CONTAINS absolute paths    → each run transformed in place
 *      (a truncated `halt_reason` quoting a stack frame);
 *   3. otherwise                            → unchanged.
 *
 * Then the fail-closed post-condition: whatever came out of 1–3 must satisfy
 * {@link isShippable}, or the WHOLE string is replaced by a fingerprint. There
 * is no path through this function that returns a value the SG4 arbiter would
 * flag — which is also what makes it IDEMPOTENT.
 */
function scrubResolved(value: string, opts: ResolvedScrubOptions): string {
  let out: string;
  if (looksAbsolutePath(value) && !value.includes('\n')) {
    out = transformPath(value, opts);
  } else if (SG4_PATH_RE.test(value)) {
    out = value.replace(
      EMBEDDED_PATH_RE,
      (_m, guard: string, path: string) => `${guard}${transformPath(path, opts)}`
    );
  } else {
    out = value;
  }
  return isShippable(out, opts) ? out : fingerprintString(value, opts.salt);
}

/** {@link scrubResolved} with the caller's options resolved first. */
export function scrubPathString(value: string, options: PathScrubOptions = {}): string {
  return scrubResolved(value, resolveScrubOptions(options));
}

/**
 * Scrub every STRING VALUE in a payload, at any depth, preserving structure.
 *
 * Values only, never keys — keys come from the allowlists and are fixed, and
 * the SG4 check itself only ever inspects string leaves (`scanStrings` in
 * `check-sg4.mjs` recurses into values).
 *
 * The options are resolved ONCE and the resolved form is threaded down, which
 * is not only a performance choice: `ResolvedScrubOptions` names the salt
 * `salt` while `PathScrubOptions` names it `fingerprintSalt`, so re-entering
 * the public entry point per string would silently drop the salt and
 * fingerprint under the empty key. Hence `scrubResolved` exists at all.
 */
export function scrubPayloadPaths<T>(payload: T, options: PathScrubOptions = {}): T {
  const opts = resolveScrubOptions(options);
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return scrubResolved(node, opts);
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return walk(payload) as T;
}

// ── The metadata-tier allowlists ─────────────────────────────────────────────

type FieldRule = 'keep' | 'fingerprint' | 'summary' | 'question' | 'message_parts';

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
  // department-mesh (task d1): a department event's `run_id` above IS its
  // execution id (see `../department/events.ts`'s module doc); these two are
  // its task/context identity, structural like `session_id`, not content.
  task_id: 'keep',
  context_id: 'keep',
  // simplified-onboarding b4 (journal schema 2): the department a task ran in
  // and the engine that ran it are structure and taxonomy — the same kind of
  // thing as `pipeline_name` and `resolved_model`. `sender` is NOT: it is a
  // person's identity (`ivan@acme`), so it is FINGERPRINTED rather than kept,
  // which still correlates one sender's tasks across events without the
  // identity itself leaving the machine at this tier.
  department_id: 'keep',
  engine: 'keep',
  sender: 'fingerprint',
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
    // v5's step identity plus v4's, so shipping a journal written before the
    // rename keeps its step tag instead of silently dropping it.
    step_name: 'keep',
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
    step_name: 'keep',
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
    step_name: 'keep',
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

  // ── department-mesh (task d1, 07-runtime-contract.md §8) ──────────────────
  // One entry per `RuntimeEvent` variant (`../department/events.ts`'s
  // `DEPARTMENT_JOURNAL_EVENT_TYPES` pins the exhaustive list; a coverage
  // test in `tests/shipper-privacy-department.test.ts` fails if either side
  // drifts). `department.message`/`department.artifact` carry the department's
  // actual task content (not telemetry) — redacted/dropped by default at the
  // metadata tier exactly like `awaiting_input.question`, never silently
  // leaked just because a new event type showed up.
  'department.status': { state: 'keep', message: 'summary' },
  'department.progress': { note: 'summary' },
  'department.input_required': { question_id: 'keep', question: 'question' },
  'department.message': { parts: 'message_parts' },
  'department.artifact': { name: 'keep', media_type: 'keep' }, // path/bytes_base64 are content — dropped
  'department.completed': { summary: 'summary' },
  'department.failed': { reason: 'summary', retry_safe: 'keep' },
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
  // Sync-mechanics stamps (protocol 0.2.0): the shipper's own revision/origin
  // (design D13/D18) — counters/taxonomy, never content.
  revision: 'keep',
  origin: 'keep',
};

/** `RunFailureDetail` entries inside a stats record (design D16): timestamp,
 *  tool name and step id are metadata; the `error` excerpt text is CONTENT
 *  and is deliberately ABSENT from this allowlist (stripped). */
const STATS_FAILURE_ALLOWLIST: Record<string, FieldRule> = {
  ts: 'keep',
  tool: 'keep',
  step: 'keep',
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
  /**
   * SG4: extra roots an absolute path in this payload may be relativized
   * against — what the CALLER knows that the payload no longer does.
   *
   * The event's own roots are read out of the event (see
   * {@link collectPathRoots}); this is for the two cases where they are not
   * there: a bare stats record passed straight to
   * {@link filterStatsRecordMetadata} (a `RunRecord` carries no root field at
   * all), and a payload read back off a queue file, whose `project_root` is
   * already a fingerprint. Never required — a root nobody supplies simply
   * means the path fails closed to a fingerprint instead of relativizing.
   */
  pathRoots?: readonly (string | null | undefined)[];
  /** SG4: override the OS account names the scrub refuses to let through.
   *  Defaults to {@link defaultAccountNames}; injectable for tests. */
  accountNames?: readonly string[];
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
    case 'message_parts': {
      if (!Array.isArray(value)) return undefined;
      // A schema-valid single placeholder part, same spirit as `question`'s
      // placeholder object: downstream consumers expecting `parts: Part[]`
      // still get a well-formed array, just with zero authored content.
      return [{ text: MESSAGE_PARTS_PLACEHOLDER, media_type: 'text/plain' }];
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

/**
 * Filter the synthetic `.stats` run record (nested allowlists), then apply the
 * SG4 path scrub.
 *
 * The scrub is not decoration here. `STATS_FAILURE_ALLOWLIST.step` is
 * `keep`-classified and is NOT `*_path`-named, so it is invisible to any
 * field-name rule — and it is reached on the run-exit ship path. `steps[].id`
 * is the same shape of value. A bare `RunRecord` carries no root field, so the
 * roots for this record come from `options.pathRoots`; without one an absolute
 * `step` fails closed to a fingerprint rather than shipping.
 */
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
  if (Array.isArray(record.failures)) {
    out.failures = record.failures
      .filter(isRecord)
      .map((failure) => filterByAllowlist(failure, STATS_FAILURE_ALLOWLIST, salt));
  }
  return scrubPayloadPaths(out, {
    roots: collectPathRoots(record, options.pathRoots ?? []),
    accountNames: options.accountNames,
    fingerprintSalt: salt,
  });
}

/**
 * D16 (G-sec-2): strip `RunFailureDetail.error` excerpt text from a stats
 * run record — applied by the shipper on the stats path at EVERY tier,
 * BEFORE the tier filter and BEFORE anything is spooled. Failure excerpts
 * routinely contain code, paths and command lines; the design strips them
 * by default (tool name + step + count survive — the count both as the
 * array length and as `tokens.failed_tools`). Entries that are not objects
 * carry no classifiable metadata and are dropped entirely.
 */
export function stripStatsFailureExcerpts(record: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(record.failures)) return record;
  const failures = record.failures.filter(isRecord).map((failure) => {
    const { error: _stripped, ...rest } = failure;
    return rest;
  });
  return { ...record, failures };
}

/**
 * Filter ONE journal event for the given tier. `event` must already be a JSON
 * object (non-object lines are unshippable upstream).
 *
 *   - `events` / `full`: the event passes VERBATIM.
 *   - `metadata`: envelope + data are rebuilt from the positive allowlists —
 *     unknown event type ⇒ `data: {}`; unknown field ⇒ dropped; root paths ⇒
 *     fingerprints; question ⇒ placeholder; fail summaries ⇒ truncated — and
 *     then the SG4 scrub runs over the WHOLE result, so no absolute path and no
 *     OS account name survives in any field, `keep`-classified or not.
 *
 * ORDER MATTERS TWICE. The roots are collected from the UNFILTERED `event`,
 * because the allowlist has already replaced `project_root` with a fingerprint
 * by the time `out` exists. And the scrub runs LAST, after truncation, so a
 * path that only becomes visible once a `summary` field is cut short is still
 * caught.
 */
export function filterEventForTier(
  event: Record<string, unknown>,
  tier: PrivacyTier,
  options: PrivacyFilterOptions = {}
): Record<string, unknown> {
  if (tier === 'events' || tier === 'full') return event;

  const salt = options.fingerprintSalt ?? '';
  const roots = collectPathRoots(event, options.pathRoots ?? []);
  const out = filterByAllowlist(event, ENVELOPE_ALLOWLIST, salt);

  const type = typeof event.type === 'string' ? event.type : '';
  const dataAllowlist = DATA_ALLOWLISTS[type];
  const data = isRecord(event.data) ? event.data : {};
  if (type === 'stats.run_record') {
    // The nested filter scrubs its own output with these same roots; the
    // envelope-wide pass below is then a no-op over it (the scrub is
    // idempotent by construction — see `scrubResolved`).
    out.data = filterStatsRecordMetadata(data, { ...options, pathRoots: roots });
  } else if (dataAllowlist !== undefined) {
    out.data = filterByAllowlist(data, dataAllowlist, salt);
  } else {
    // Unknown/new event type: default STRIPPED — never leaked.
    out.data = {};
  }
  return scrubPayloadPaths(out, {
    roots,
    accountNames: options.accountNames,
    fingerprintSalt: salt,
  });
}
