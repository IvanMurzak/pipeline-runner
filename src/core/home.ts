/**
 * The isolated HOME (department-mesh d7 — `07-runtime-contract.md` §2.2,
 * D17): `PIPELINE_RUNNER_HOME` roots an instance's config dir (`./config.ts`)
 * and data dir (`../shipper/fs.ts`), so N runner instances can coexist on
 * one host without ever sharing a config file, job store, spool, or
 * workspace root. This module owns the two pieces `config.ts`/`fs.ts` don't:
 *
 *   - `resolveWorkspaceRoot` — generalizes the historical
 *     `PIPELINE_RUNNER_JOBS_DIR` (job CHECKOUTS, distinct from the job
 *     STATE STORE under the data dir) onto the home.
 *   - the per-home exclusive lock, `<home>/runner.lock` — reconnaissance
 *     found **no single-instance guard anywhere** in `src/`; this closes
 *     that gap "one daemon per home", while "N homes per host" stays fully
 *     supported (each home gets its own lock file).
 *
 * Unset `PIPELINE_RUNNER_HOME` ⇒ every resolver here keeps the pre-d7
 * behavior: `resolveWorkspaceRoot` returns exactly what `cli.ts` computed
 * inline before this change, and the lock anchors in the (still OS-default)
 * data dir — so even a single default-home runner gets the "one daemon"
 * guard, and a second `start` against the same unconfigured defaults is
 * refused exactly like two named homes would be.
 */

import * as fs from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { defaultDataDir } from '../shipper/fs';
import { defaultConfigDir, PIPELINE_RUNNER_HOME_ENV, resolveHome } from './config';

export { PIPELINE_RUNNER_HOME_ENV, resolveHome } from './config';

export const LOCK_FILE_NAME = 'runner.lock';
/** Generalizes the historical `PIPELINE_RUNNER_JOBS_DIR` — still respected
 *  as the most-specific override (wins even over a configured home). */
export const PIPELINE_RUNNER_JOBS_DIR_ENV = 'PIPELINE_RUNNER_JOBS_DIR';

/**
 * The job-workspace root (fresh shallow-clone checkouts —
 * `jobs/workspace.ts`), NOT the durable job-record store (that lives under
 * the data dir, `job-store.ts`). Precedence: an explicit
 * `PIPELINE_RUNNER_JOBS_DIR` always wins (most specific); then the isolated
 * home's `jobs/` dir; then the pre-d7 default (`<configDir>/jobs`) — which
 * is what every existing single-home install already uses, so this is a
 * pure generalization, not a behavior change, when neither env var is set.
 */
export function resolveWorkspaceRoot(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform
): string {
  const override = env[PIPELINE_RUNNER_JOBS_DIR_ENV];
  if (override !== undefined && override.trim().length > 0) return override;
  const home = resolveHome(env);
  if (home !== null) return join(home, 'jobs');
  return join(defaultConfigDir(env, platform), 'jobs');
}

/**
 * The directory the per-home lock file lives in: the isolated home when
 * `PIPELINE_RUNNER_HOME` is set, else the pre-d7 default data dir — so the
 * "one daemon" guard applies even to the historical single-home case.
 */
export function resolveLockHomeDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform
): string {
  const home = resolveHome(env);
  return home !== null ? home : defaultDataDir(env, platform);
}

/** Refused: another (live) process already holds this home's lock. */
export class HomeLockError extends Error {}

interface LockPayload {
  pid: number;
  hostname: string;
  started_at: string;
}

/** Injectable filesystem seam — deliberately narrow (just what the lock
 *  needs), mirroring `ConfigFileSystem`/`ServiceFs`'s testability philosophy. */
export interface HomeLockFs {
  mkdirp(path: string): void;
  /** Atomic create-exclusive write. MUST throw an error whose `.code` is
   *  `'EEXIST'` when `path` already exists (never silently overwrite). */
  writeExclusive(path: string, data: string): void;
  readFileText(path: string): string | null;
  /** Idempotent: removing a missing file is a no-op. */
  remove(path: string): void;
}

/** The real filesystem — `fs.openSync(path, 'wx')` is the atomic
 *  create-exclusive primitive (fails `EEXIST` if the path already exists),
 *  portable across POSIX and Windows. */
export function nodeHomeLockFs(): HomeLockFs {
  return {
    mkdirp: (path) => {
      fs.mkdirSync(path, { recursive: true });
    },
    writeExclusive: (path, data) => {
      const fd = fs.openSync(path, 'wx');
      try {
        fs.writeSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
    },
    readFileText: (path) => {
      try {
        return fs.readFileSync(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    remove: (path) => {
      try {
        fs.rmSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}

/**
 * True when the OS reports a live process at `pid`. Signal `0` delivers
 * nothing — it is Node/Bun's documented portable existence probe, Windows
 * included (`process.kill(pid, 0)`). `EPERM` still counts as alive (the
 * process exists; we just aren't allowed to signal it); any other error
 * (`ESRCH` and friends) means it is gone.
 */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = process.kill.bind(process)
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface HomeLockHandle {
  readonly path: string;
  release(): void;
}

export interface AcquireHomeLockOptions {
  fs?: HomeLockFs;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  hostname?: string;
}

/**
 * Acquire the per-home exclusive lock (`<home>/runner.lock`, 07 §2.2): "one
 * daemon per home". An atomic exclusive-create is the gate; a lock file left
 * behind by a since-dead pid (the daemon was killed, not stopped cleanly) is
 * self-healed — removed and retried once — so a hard kill never bricks the
 * home. A LIVE holder throws `HomeLockError`: the "second daemon in one home
 * is refused" guard (the P1 two-runner-per-host gate's other half).
 */
export function acquireHomeLock(homeDir: string, options: AcquireHomeLockOptions = {}): HomeLockHandle {
  const lfs = options.fs ?? nodeHomeLockFs();
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;
  const now = options.now ?? (() => new Date());
  const host = options.hostname ?? hostname();
  const path = join(homeDir, LOCK_FILE_NAME);

  lfs.mkdirp(homeDir);

  const write = (): boolean => {
    const payload: LockPayload = { pid, hostname: host, started_at: now().toISOString() };
    try {
      lfs.writeExclusive(path, JSON.stringify(payload, null, 2) + '\n');
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!write()) {
    const existing = readLockPayload(lfs, path);
    if (existing !== null && isAlive(existing.pid)) {
      throw new HomeLockError(
        `home is already locked by a running runner (pid ${existing.pid}` +
          `${existing.hostname ? `, host ${existing.hostname}` : ''}) — ${path}\n` +
          `each daemon needs its OWN home (${PIPELINE_RUNNER_HOME_ENV}); if that process is ` +
          'actually gone, delete the lock file and retry.'
      );
    }
    // Stale (dead pid) or an unreadable/corrupt lock file — self-heal:
    // remove it and retry once. A second failure means we lost a race with
    // another daemon starting concurrently; that one wins, we bail.
    lfs.remove(path);
    if (!write()) {
      throw new HomeLockError(`could not acquire the home lock at ${path} (lost a race with another starting daemon)`);
    }
  }

  return { path, release: () => lfs.remove(path) };
}

function readLockPayload(lfs: HomeLockFs, path: string): LockPayload | null {
  const text = lfs.readFileText(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as Partial<LockPayload>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : '',
      started_at: typeof parsed.started_at === 'string' ? parsed.started_at : '',
    };
  } catch {
    return null;
  }
}
