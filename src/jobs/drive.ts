/**
 * The `pipeline drive` contract, agent side: build the exact argv for each
 * invocation mode, parse the final stdout JSON, and classify an exec result
 * into a job-level outcome.
 *
 * Drive contract (see pipeline-cli `src/commands/drive.ts`):
 *   - `pipeline drive --root <pipeline_root> --run-id <id> --start <iteration>
 *     --json` runs the pipeline to completion in one supervised process.
 *   - Exit codes: 0 completed · 1 halted/depth-exhausted · 2 usage error ·
 *     3 blocked (nested blocker) · 4 awaiting-input (PARKED on a question).
 *   - Exit 4 stdout carries `{status:"awaiting-input", step_id,
 *     iteration_path, session_id, question:{text,context,options}}`; resume
 *     the SAME claude session via `--resume --start <iteration> --answer
 *     "<text>"`.
 *   - `--resume` alone re-enters a persisted run (crash / pause recovery).
 *
 * Provider-limit detection is a seam (`ProviderLimitDetector`): the executor
 * checks every drive exec result against it BEFORE exit-code classification,
 * and a positive match pauses the job (auto-resume) instead of failing it.
 * The default detector is a conservative pattern scan over the combined
 * output; deployments with structured limit reporting inject their own.
 */

import type { JobExecResult } from './types';

/** `pipeline drive` exit codes (see the drive header contract). */
export const DRIVE_EXIT = {
  completed: 0,
  halted: 1,
  usage: 2,
  blocked: 3,
  awaitingInput: 4,
} as const;

/** One drive invocation: the initial run, a plain resume, or an answer delivery. */
export type DriveMode =
  | { kind: 'start'; startIteration: string }
  | { kind: 'resume' }
  | { kind: 'answer'; startIteration: string; answer: string };

export interface DriveTarget {
  /** Absolute pipeline root inside the job's checkout (`--root`). */
  pipelineRoot: string;
  /** The lease's run id (`--run-id`). */
  runId: string;
  /** T3-06 — matrix-cell RUN-LEVEL model override (`lease.execution_overrides.
   *  model`). Emitted as `--default-model`; the CLI feeds it to computePlan's
   *  `defaultModel`, so it replaces the pipeline's default model for this cell
   *  (a step's own `model:` still wins). Absent/blank ⇒ no flag. */
  defaultModel?: string;
  /** T3-06 — matrix-cell RUN-LEVEL effort override (`lease.execution_overrides.
   *  effort`). Emitted as `--default-effort` → computePlan's `defaultEffort`.
   *  Absent/blank ⇒ no flag. */
  defaultEffort?: string;
  /** env-variables design (task b1/d1) — the lease's frozen `PP_*` map
   *  (`lease.variables`). Mapped to one `--var NAME=value` flag per entry —
   *  but, unlike `defaultModel`/`defaultEffort` above, ONLY on the START
   *  invocation (see `buildDriveArgs`): variables are frozen at run init
   *  (D11) and the CLI rejects a repeated `--var` on an already-frozen resume
   *  with a loud exit-2 usage error. Absent/empty ⇒ no flags, ever — a lease
   *  without `variables` drives byte-identically to today. */
  variables?: Record<string, string>;
}

/** Build the exact `pipeline` argv for one drive invocation. */
export function buildDriveArgs(target: DriveTarget, mode: DriveMode): string[] {
  const args = ['drive', '--root', target.pipelineRoot, '--run-id', target.runId];
  // T3-06: matrix-cell execution overrides ride as pipeline-level defaults on
  // EVERY invocation (start / resume / answer) so the cell's model + effort
  // persist across provider-limit and needs-input resumes. Emitted only when
  // non-blank ⇒ a no-override run's argv is byte-identical to before matrix runs.
  const defaultModel = target.defaultModel?.trim();
  if (defaultModel) args.push('--default-model', defaultModel);
  const defaultEffort = target.defaultEffort?.trim();
  if (defaultEffort) args.push('--default-effort', defaultEffort);
  switch (mode.kind) {
    case 'start':
      args.push('--start', mode.startIteration);
      // D11 corollary: lease variables are frozen at init — send --var ONLY
      // on this START invocation, never on resume/answer (those cases below
      // never read target.variables at all — structurally START-only, not
      // just by convention). Each entry is ONE argv element ("NAME=value"):
      // no shell, no joining, no re-splitting — a value containing spaces or
      // metacharacters stays exactly one argument (T8/T3 discipline). A value
      // containing its own `=` is safe too: the CLI's --var parser splits on
      // the FIRST `=` only (pipeline-cli `commands/drive.ts`, design 04 §1).
      // Sorted by name for deterministic argv (mirrors the existing
      // Object.entries(...).sort(([a],[b]) => a.localeCompare(b)) convention
      // in ../service/systemd.ts / launchd.ts) — a lease's variables arrive as
      // a plain JS object, and argv order should not depend on wire/JSON key
      // order. NOTE: an empty-string value is emitted verbatim as `--var
      // NAME=` (unlike the blank-⇒-no-flag defaultModel/defaultEffort above):
      // an empty resolved variable is a legitimate distinct value (D1), never
      // "absent", so it must ride through unfiltered.
      for (const [name, value] of Object.entries(target.variables ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        args.push('--var', `${name}=${value}`);
      }
      break;
    case 'resume':
      args.push('--resume');
      break;
    case 'answer':
      args.push('--resume', '--start', mode.startIteration, '--answer', mode.answer);
      break;
  }
  args.push('--json');
  return args;
}

/** A parked needs-input question as drive reports it (exit 4 final JSON). */
export interface DriveParked {
  step_id: string | null;
  /** Resume target: `--resume --start <iteration_path> --answer <text>`. */
  iteration_path: string;
  session_id: string | null;
  question: { text: string; context: string | null; options: string[] | null };
}

/** A drive exec result classified into the job-level outcome. */
export type DriveOutcome =
  | { kind: 'completed'; outcome: string }
  | { kind: 'halted'; reason: string }
  | { kind: 'awaiting_input'; parked: DriveParked }
  | { kind: 'failed'; reason: string };

/**
 * Parse drive's final stdout JSON (a single pretty-printed object). Tolerates
 * stray non-JSON output around it (custom executor templates may leak lines);
 * null when no object parses.
 */
export function parseDriveFinalJson(stdout: string): Record<string, unknown> | null {
  const attempt = (text: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  const whole = attempt(trimmed);
  if (whole !== null) return whole;
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  return attempt(trimmed.slice(first, last + 1));
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Defensive question narrowing — same shape pipeline-cli's extractQuestion yields. */
function narrowQuestion(raw: unknown): DriveParked['question'] {
  const q = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    text: asString(q.text) ?? 'step requested input but provided no question text',
    context: asString(q.context),
    options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : null,
  };
}

/** Classify one drive exec result. Provider limits are detected SEPARATELY
 *  (see `ProviderLimitDetector`) and take precedence over this mapping. */
export function classifyDriveOutcome(result: JobExecResult): DriveOutcome {
  if (result.code === null) {
    return { kind: 'failed', reason: `pipeline drive did not run: ${result.error ?? 'process died without an exit code'}` };
  }
  const json = parseDriveFinalJson(result.stdout);
  switch (result.code) {
    case DRIVE_EXIT.completed:
      return { kind: 'completed', outcome: asString(json?.status) ?? 'completed' };
    case DRIVE_EXIT.halted:
      return { kind: 'halted', reason: asString(json?.reason) ?? asString(json?.status) ?? 'halted' };
    case DRIVE_EXIT.blocked: {
      // A nested blocker needs an interactive resolution pass — no cloud-side
      // actor exists for that (v1), so the job halts with the pointer.
      const record = asString(json?.blocker_record_file);
      return { kind: 'halted', reason: `blocked on a nested blocker${record !== null ? ` (${record})` : ''}` };
    }
    case DRIVE_EXIT.awaitingInput: {
      const iteration = asString(json?.iteration_path);
      if (iteration === null) {
        return { kind: 'failed', reason: 'drive parked awaiting input but reported no iteration_path to resume at' };
      }
      return {
        kind: 'awaiting_input',
        parked: {
          step_id: asString(json?.step_id),
          iteration_path: iteration,
          session_id: asString(json?.session_id),
          question: narrowQuestion(json?.question),
        },
      };
    }
    case DRIVE_EXIT.usage: {
      const firstErr = result.stderr.trim().split('\n')[0] ?? '';
      return { kind: 'failed', reason: `pipeline drive usage error (exit 2)${firstErr ? `: ${firstErr}` : ''}` };
    }
    default:
      return { kind: 'failed', reason: `pipeline drive exited ${result.code}` };
  }
}

// ── Provider-limit detection (seam + conservative default) ──────────────────

/** A detected provider/usage limit. `retry_after_ms` when the provider stated
 *  a window; absent ⇒ the executor's pause policy decides. */
export interface ProviderLimit {
  reason: string;
  retry_after_ms?: number;
}

/** Inspect a drive exec result for a provider/usage limit. Null ⇒ no limit. */
export type ProviderLimitDetector = (result: JobExecResult) => ProviderLimit | null;

const PROVIDER_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /provider limit/i,
  /rate.?limit/i,
  /overloaded/i,
  /too many requests/i,
];

/**
 * Conservative default: a NON-completed drive whose output mentions a
 * usage/rate-limit condition. A completed run (exit 0) is never limit-paused.
 */
export const defaultProviderLimitDetector: ProviderLimitDetector = (result) => {
  if (result.code === DRIVE_EXIT.completed) return null;
  const text = `${result.stdout}\n${result.stderr}`;
  for (const pattern of PROVIDER_LIMIT_PATTERNS) {
    const match = text.match(pattern);
    if (match !== null) return { reason: match[0] };
  }
  return null;
};
