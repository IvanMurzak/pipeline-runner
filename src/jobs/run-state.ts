/**
 * Cross-machine run-state handoff (f3, design 01 §Scale E13 / 02 §Work
 * "session resume"): the portable half of `<pipeline_root>/.runtime/<run_id>/`,
 * captured when a machine releases a run and restored when a DIFFERENT machine
 * picks it up.
 *
 * ── The decision this module implements ────────────────────────────────────
 *
 * `02-standalone-executor.md:169` states the fork: *"SDK session files are
 * machine-local … A hosted run parked and resumed elsewhere (D12) needs a
 * `SessionStore` adapter, or must not rely on session resume."*
 *
 * **We do not rely on session resume.** Transcripts are never mirrored — not to
 * shared storage, not to the control plane, not anywhere. What travels is the
 * durable cursor and nothing else. The full reasoning, the evidence, and the
 * residual losses are in `docs/cross-machine-resume.md`; the two load-bearing
 * facts are:
 *
 *   1. **Nothing engine-visible crosses a step boundary in a session.** Drive
 *      mints a FRESH `randomUUID()` session per step and keys the session file
 *      by step (`.runtime/<run_id>/sessions/<step>.json`); no variable carries
 *      a session id from step N to step N+1, and even a graph loop-back
 *      re-running the same step gets a new one. `d2-executor-conformance`
 *      already treats session ids as legitimately differing while requiring the
 *      run cursor to match. The cursor IS the run's continuity.
 *   2. **Mirroring transcripts would engage `ux-v2`'s content promise** — we
 *      ship metadata, never content — for a capability that buys nothing at the
 *      boundary that matters. E11 rejected server-side pipeline STORAGE on that
 *      same ground, and transcripts are a strictly larger content surface.
 *
 * ── What travels, and what deliberately does not ───────────────────────────
 *
 * | `.runtime/<run_id>/…` | Travels? | Why |
 * | --- | --- | --- |
 * | `next.json` | **yes** | the durable cursor — the run's entire engine-visible position |
 * | `sessions/*.json` | **no** | pinned claude session ids, meaningless off their machine |
 * | `~/.claude/projects/…/*.jsonl` | **no** | the transcripts themselves — content, never mirrored |
 *
 * The allowlist is POSITIVE (`PORTABLE_RUN_STATE_FILES`) and is iterated rather
 * than the source directory, so a file added to `.runtime/` later cannot start
 * travelling by accident — the same structural property the privacy filter
 * relies on.
 *
 * ── Why an absent `sessions/` directory is the mechanism, not an omission ───
 *
 * On the receiving machine drive finds no session file for the step the cursor
 * names, takes its `prior === null` branch, and spawns a FRESH session. That is
 * the whole trick: leaving `sessions/` behind is what makes the restored run
 * start clean instead of issuing `--resume <id>` against a session that does
 * not exist here (which would burn the crash-resume budget and halt).
 *
 * Import-inert: importing this module touches no filesystem and starts nothing.
 */

import { join } from 'node:path';
import type { ShipperFileSystem } from '../shipper/fs';
import { sanitizeJobId } from './workspace';

/**
 * The POSITIVE allowlist of run-state files that cross a machine boundary.
 * Iterated (never the source directory) so nothing new travels by default.
 */
export const PORTABLE_RUN_STATE_FILES = ['next.json'] as const;

/** The run-state subdirectory that is machine-local BY DECISION (see header). */
export const MACHINE_LOCAL_RUN_STATE_DIR = 'sessions';

/**
 * Cursor fields that name an absolute path on the machine that wrote them. A
 * run whose cursor carries any of these is refused: the engine would drive
 * steps into a directory that does not exist on the receiving machine, which is
 * a correctness hazard rather than the survivable loss the rest of this module
 * accepts. In practice they are set only for `isolation: external` runs, whose
 * run-level worktree is machine-local substrate exactly like a session file.
 */
export const MACHINE_LOCAL_CURSOR_FIELDS = [
  'worktree_path',
  'worktree_env_file',
  'worktree_pipeline_root',
  'main_pipeline_root',
] as const;

/** `<pipeline_root>/.runtime/<run_id>` — drive's durable per-run state root. */
export function runStateDir(pipelineRoot: string, runId: string): string {
  return join(pipelineRoot, '.runtime', runId);
}

/**
 * The portable run state for one run. Deliberately small: a cursor, and enough
 * provenance to debug a handoff. It carries NO transcript, NO session id, and
 * no free-form content from the run.
 */
export interface RunStateBundle {
  run_id: string;
  /** Verbatim `next.json` text — the durable cursor, and the only file carried. */
  cursor: string;
  /** ISO capture time. Provenance for a stale-handoff investigation. */
  captured_at: string;
  /**
   * True when a step session was `awaiting-input` at capture time. The question
   * itself is NOT carried (it lives on the control plane, which is what asked
   * it); this flag exists so the receiving runner can log that the step will
   * re-ask rather than silently appearing to lose an answer.
   */
  pending_question: boolean;
}

export type RunStatePortability = { portable: true } | { portable: false; reason: string };

/** What `captureRunState` found, so callers can log a refusal instead of a silence. */
export type RunStateCapture = { bundle: RunStateBundle } | { bundle: null; reason: string };

/** What `restoreRunState` did, so callers never guess whether a resume is safe. */
export type RunStateRestore = { restored: true; pending_question: boolean } | { restored: false; reason: string };

function parseCursor(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Is this cursor safe to carry to another machine?
 *
 * Note what is NOT a refusal. A run interrupted mid-step — a provider-limit
 * halt (D12's funding-failure path is exactly this), a crashed drive — IS
 * portable. Its cursor still names that step precisely BECAUSE the step
 * produced no record, so the receiving machine re-dispatches it from the top in
 * a fresh session. Nothing that completed is repeated; the interrupted
 * attempt's partial work is discarded, which is the same thing that happens
 * when a step is retried on one machine.
 */
export function classifyCursorPortability(cursorText: string): RunStatePortability {
  const cursor = parseCursor(cursorText);
  if (cursor === null) return { portable: false, reason: 'cursor is not readable JSON' };
  if (cursor.worktree_provisioned === true) {
    return { portable: false, reason: 'run-level worktree is provisioned — machine-local substrate' };
  }
  for (const field of MACHINE_LOCAL_CURSOR_FIELDS) {
    const value = cursor[field];
    if (value !== undefined && value !== null) {
      return { portable: false, reason: `cursor field '${field}' names a path on the machine that wrote it` };
    }
  }
  return { portable: true };
}

/**
 * True when any pinned step session is parked on a question. Read ONLY to set
 * `pending_question`; no session id and no transcript path ever leaves here.
 */
function hasPendingQuestion(fs: ShipperFileSystem, pipelineRoot: string, runId: string): boolean {
  const dir = join(runStateDir(pipelineRoot, runId), MACHINE_LOCAL_RUN_STATE_DIR);
  const entries = fs.listDir(dir);
  if (entries === null) return false;
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
    const parsed = parseCursor(fs.readFileText(join(dir, entry.name)) ?? '');
    if (parsed?.status === 'awaiting-input') return true;
  }
  return false;
}

/** Read the portable run state out of a live checkout. */
export function captureRunState(
  args: { pipelineRoot: string; runId: string; nowIso: string },
  fs: ShipperFileSystem
): RunStateCapture {
  const dir = runStateDir(args.pipelineRoot, args.runId);
  const cursor = fs.readFileText(join(dir, PORTABLE_RUN_STATE_FILES[0]));
  if (cursor === null) return { bundle: null, reason: 'no durable cursor yet' };
  const verdict = classifyCursorPortability(cursor);
  if (!verdict.portable) return { bundle: null, reason: verdict.reason };
  return {
    bundle: {
      run_id: args.runId,
      cursor,
      captured_at: args.nowIso,
      pending_question: hasPendingQuestion(fs, args.pipelineRoot, args.runId),
    },
  };
}

/**
 * Write a bundle into a FRESHLY PREPARED checkout on this machine.
 *
 * Refuses when the target already holds run state: a fresh prep never does, so
 * a populated `.runtime/<run_id>/` means this is the machine that owns the run
 * already and the local state is authoritative. Overwriting it with a bundle
 * of unknown age is how a run silently rewinds.
 *
 * `sessions/` is never created — see the module header; its absence is what
 * makes the restored run start clean.
 */
export function restoreRunState(
  bundle: RunStateBundle,
  args: { pipelineRoot: string; runId: string },
  fs: ShipperFileSystem
): RunStateRestore {
  if (bundle.run_id !== args.runId) {
    return { restored: false, reason: `bundle is for run ${bundle.run_id}, not ${args.runId}` };
  }
  const verdict = classifyCursorPortability(bundle.cursor);
  if (!verdict.portable) return { restored: false, reason: verdict.reason };
  const dir = runStateDir(args.pipelineRoot, args.runId);
  if (fs.statSize(join(dir, PORTABLE_RUN_STATE_FILES[0])) !== null) {
    return { restored: false, reason: 'this machine already holds run state for this run' };
  }
  // Self-contained gitignore, mirroring what drive writes: restored state must
  // never pollute the consumer's commits.
  fs.mkdirp(join(args.pipelineRoot, '.runtime'));
  fs.writeFileText(join(args.pipelineRoot, '.runtime', '.gitignore'), '*\n');
  fs.mkdirp(dir);
  fs.writeFileText(join(dir, PORTABLE_RUN_STATE_FILES[0]), bundle.cursor);
  return { restored: true, pending_question: bundle.pending_question };
}

/**
 * The handoff transport. The runner never assumes what backs it: a shared
 * filesystem (`fsRunStateStore`) is the shape exercised today; a control-plane
 * endpoint is the obvious follow-up and needs no change here, because the
 * payload is already metadata-only by construction.
 *
 * ABSENT ⇒ every existing behaviour is untouched. A runner without a store
 * publishes nothing, restores nothing, and behaves exactly as it did before
 * f3 — cross-machine resume is opt-in, single-machine resume is unaffected.
 */
export interface RunStateStore {
  /** Capture from a live checkout and publish. Returns what was (not) carried. */
  publish(args: { pipelineRoot: string; runId: string }): RunStateCapture;
  /** The published bundle for a run, or null when this run has never moved. */
  fetch(runId: string): RunStateBundle | null;
  /** Restore into a freshly prepared checkout on this machine. */
  restore(bundle: RunStateBundle, args: { pipelineRoot: string; runId: string }): RunStateRestore;
  /** Drop a run's bundle — the run reached a terminal outcome somewhere. */
  discard(runId: string): void;
}

function isBundle(value: unknown): value is RunStateBundle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  return typeof b.run_id === 'string' && typeof b.cursor === 'string' && typeof b.captured_at === 'string';
}

/**
 * A `RunStateStore` over one directory: `<dir>/<run-id>.json`, one bundle per
 * run. Point it at storage both machines can see (a shared mount, a synced
 * volume). The SAME `ShipperFileSystem` reads the local checkout and writes the
 * store, so a test drives the whole handoff in memory.
 */
export function fsRunStateStore(fs: ShipperFileSystem, dir: string, clock: () => number = Date.now): RunStateStore {
  const pathFor = (runId: string): string => join(dir, `${sanitizeJobId(runId)}.json`);
  return {
    publish(args) {
      const captured = captureRunState({ ...args, nowIso: new Date(clock()).toISOString() }, fs);
      if (captured.bundle === null) return captured;
      fs.mkdirp(dir);
      fs.writeFileText(pathFor(args.runId), JSON.stringify(captured.bundle, null, 2) + '\n');
      return captured;
    },
    fetch(runId) {
      const text = fs.readFileText(pathFor(runId));
      if (text === null) return null;
      try {
        const parsed: unknown = JSON.parse(text);
        if (!isBundle(parsed)) return null;
        return { ...parsed, pending_question: parsed.pending_question === true };
      } catch {
        return null;
      }
    },
    restore(bundle, args) {
      return restoreRunState(bundle, args, fs);
    },
    discard(runId) {
      fs.remove(pathFor(runId));
    },
  };
}
