/**
 * Startup-reconcile classification (c6, design 04 §Startup reconcile): decide,
 * for each durable job record, whether the interrupted run is
 *
 *   - UNRECOVERABLE — the resume substrate is gone: checkout missing,
 *     `<pipeline_root>/.runtime/<run_id>/next.json` missing (also covers a
 *     crash during `preparing`, which never wrote one), or a pinned step
 *     session whose claude transcript has been cleaned up
 *     (`~/.claude/projects/<encoded spawn_cwd>/<session_id>.jsonl` — subject
 *     to Claude Code's `cleanupPeriodDays`). Record dropped; best-effort
 *     `run_status halted (resume state lost/expired)`.
 *   - FRESH — `now − updated_at < lease_ttl_s`: the lease is plausibly still
 *     alive → resume NOW (`drive --resume` in the recorded checkout; no
 *     re-prep, no wipe).
 *   - STALE — older than the TTL: QUARANTINE. No spawn, no heartbeat listing,
 *     no capacity use; the record + workspace wait for the server's decision
 *     (a `resume_hint` re-offer → adoption, or `cancel` → discard).
 *
 * Pure classification over injectable seams — the manager owns acting on the
 * result. The default substrate probe reads through `ShipperFileSystem`
 * (dir-exists via listDir, file-exists via statSize, session files via
 * readFileText), so tests drive the whole matrix in memory.
 */

import { join } from 'node:path';
import type { ShipperFileSystem } from '../shipper/fs';
import type { JobRecord } from './job-store';

/** Claude Code's project-dir encoding: the spawn cwd with every
 *  non-alphanumeric character replaced by `-` (the same rule pipeline-cli's
 *  transcript walker vendors — step-transcripts encoding). */
export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A pinned step session's transcript path. Drive spawns claude with
 *  cwd = the job's checkout dir, so that is the encoded project dir. */
export function claudeTranscriptPath(homeDir: string, spawnCwd: string, sessionId: string): string {
  return join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(spawnCwd), `${sessionId}.jsonl`);
}

/** `<pipeline_root>/.runtime/<run_id>` — drive's durable per-run state root. */
export function runtimeDirFor(record: Pick<JobRecord, 'run_id'> & { pipeline_root: string }): string {
  return join(record.pipeline_root, '.runtime', record.run_id);
}

/**
 * The substrate probe the classifier (and the adoption validator) look
 * through. Injectable so unit tests script the exact matrix; the default
 * implementation reads the real filesystem.
 */
export interface SubstrateProbe {
  checkoutExists(record: JobRecord): boolean;
  nextJsonExists(record: JobRecord): boolean;
  /**
   * True when every pinned step session that would have to crash-resume
   * (session file status `running` or `awaiting-input` — a parallel layer may
   * have SEVERAL) still has its claude transcript on disk. Vacuously true
   * when no session files exist yet (drive died before pinning any).
   * A session file that exists but cannot be parsed counts as BROKEN
   * substrate (false) — resuming over it would be a guess.
   */
  transcriptsPresent(record: JobRecord): boolean;
}

/** Session-file shape drive persists at `.runtime/<run_id>/sessions/<step>.json`
 *  (pipeline-cli contract): `session_id` + `status`. */
interface StepSessionFile {
  session_id: string;
  status: string;
}

function parseSessionFile(text: string | null): StepSessionFile | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.session_id !== 'string' || typeof record.status !== 'string') return null;
    return { session_id: record.session_id, status: record.status };
  } catch {
    return null;
  }
}

/** The real probe: `ShipperFileSystem` reads + the claude transcript layout. */
export function fsSubstrateProbe(fs: ShipperFileSystem, homeDir: string): SubstrateProbe {
  const dirExists = (path: string): boolean => fs.listDir(path) !== null;
  const fileExists = (path: string): boolean => fs.statSize(path) !== null;
  return {
    checkoutExists: (record) => dirExists(record.checkout_dir),
    nextJsonExists: (record) => {
      if (record.pipeline_root === null) return false;
      return fileExists(join(runtimeDirFor({ run_id: record.run_id, pipeline_root: record.pipeline_root }), 'next.json'));
    },
    transcriptsPresent: (record) => {
      if (record.pipeline_root === null) return false;
      const sessionsDir = join(
        runtimeDirFor({ run_id: record.run_id, pipeline_root: record.pipeline_root }),
        'sessions'
      );
      const entries = fs.listDir(sessionsDir);
      if (entries === null) return true; // no sessions pinned yet — nothing to require
      for (const entry of entries) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
        const session = parseSessionFile(fs.readFileText(join(sessionsDir, entry.name)));
        if (session === null) return false; // broken substrate — never resume over a guess
        if (session.status !== 'running' && session.status !== 'awaiting-input') continue;
        if (!fileExists(claudeTranscriptPath(homeDir, record.checkout_dir, session.session_id))) return false;
      }
      return true;
    },
  };
}

export type RecordClassification =
  | { kind: 'fresh' }
  | { kind: 'stale' }
  | { kind: 'unrecoverable'; reason: string };

/**
 * Classify one NON-TOMBSTONED record (callers skip `record.terminal` — those
 * belong to the retention GC, not the reconcile).
 */
export function classifyRecord(record: JobRecord, nowMs: number, probe: SubstrateProbe): RecordClassification {
  if (!probe.checkoutExists(record)) {
    return { kind: 'unrecoverable', reason: 'checkout missing' };
  }
  if (record.pipeline_root === null || record.start_iteration === null) {
    // Crash during `preparing`: no .runtime yet — prep is a fresh checkout
    // anyway (04 failure-mode table).
    return { kind: 'unrecoverable', reason: 'crashed during workspace prep (no pipeline root recorded)' };
  }
  if (!probe.nextJsonExists(record)) {
    return { kind: 'unrecoverable', reason: 'next.json missing' };
  }
  if (!probe.transcriptsPresent(record)) {
    return { kind: 'unrecoverable', reason: 'step session transcript missing (expired?)' };
  }
  const updatedAtMs = Date.parse(record.updated_at);
  if (!Number.isFinite(updatedAtMs)) {
    // Unreadable freshness: never resume optimistically — quarantine and let
    // the server's re-offer/cancel arbitrate.
    return { kind: 'stale' };
  }
  return nowMs - updatedAtMs < record.lease_ttl_s * 1000 ? { kind: 'fresh' } : { kind: 'stale' };
}
