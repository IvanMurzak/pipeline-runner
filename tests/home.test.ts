import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { defaultConfigDir } from '../src/core/config';
import {
  acquireHomeLock,
  HomeLockError,
  type HomeLockFs,
  isProcessAlive,
  LOCK_FILE_NAME,
  resolveHome,
  resolveLockHomeDir,
  resolveWorkspaceRoot,
} from '../src/core/home';
import { defaultDataDir } from '../src/shipper/fs';

const WIN_ENV = { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
const POSIX_ENV = { HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.config', XDG_STATE_HOME: '/home/u/.state' };

describe('resolveHome', () => {
  test('null when PIPELINE_RUNNER_HOME is unset or blank', () => {
    expect(resolveHome({})).toBeNull();
    expect(resolveHome({ PIPELINE_RUNNER_HOME: '' })).toBeNull();
    expect(resolveHome({ PIPELINE_RUNNER_HOME: '   ' })).toBeNull();
  });

  test('the configured path when set', () => {
    expect(resolveHome({ PIPELINE_RUNNER_HOME: '/srv/runner-a' })).toBe('/srv/runner-a');
  });
});

describe('resolveWorkspaceRoot', () => {
  test('unset home/override ⇒ the pre-d7 default, <configDir>/jobs (unchanged behavior)', () => {
    expect(resolveWorkspaceRoot(POSIX_ENV, 'linux')).toBe(join('/home/u/.config', 'pipeline-runner', 'jobs'));
    expect(resolveWorkspaceRoot(WIN_ENV, 'win32')).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'pipeline-runner', 'jobs'));
  });

  test('an isolated home roots workspaces at <home>/jobs', () => {
    const env = { ...POSIX_ENV, PIPELINE_RUNNER_HOME: '/srv/runner-a' };
    expect(resolveWorkspaceRoot(env, 'linux')).toBe(join('/srv/runner-a', 'jobs'));
  });

  test('an explicit PIPELINE_RUNNER_JOBS_DIR wins over the home (most specific)', () => {
    const env = { ...POSIX_ENV, PIPELINE_RUNNER_HOME: '/srv/runner-a', PIPELINE_RUNNER_JOBS_DIR: '/custom/checkouts' };
    expect(resolveWorkspaceRoot(env, 'linux')).toBe('/custom/checkouts');
  });

  test('a blank PIPELINE_RUNNER_JOBS_DIR is treated as unset', () => {
    const env = { ...POSIX_ENV, PIPELINE_RUNNER_JOBS_DIR: '   ' };
    expect(resolveWorkspaceRoot(env, 'linux')).toBe(join('/home/u/.config', 'pipeline-runner', 'jobs'));
  });
});

describe('resolveLockHomeDir', () => {
  test('the isolated home when set', () => {
    expect(resolveLockHomeDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a' }, 'linux')).toBe('/srv/runner-a');
  });

  test('the pre-d7 default DATA dir when no home is configured — guards the single-home case too', () => {
    expect(resolveLockHomeDir(POSIX_ENV, 'linux')).toBe(join('/home/u/.state', 'pipeline-runner'));
    expect(resolveLockHomeDir(WIN_ENV, 'win32')).toBe(join('C:\\Users\\u\\AppData\\Local', 'pipeline-runner'));
  });
});

describe('isProcessAlive', () => {
  test('true when kill(pid, 0) succeeds', () => {
    expect(isProcessAlive(123, () => {})).toBe(true);
  });

  test('true on EPERM (exists, not ours to signal)', () => {
    const err = Object.assign(new Error('perm'), { code: 'EPERM' });
    expect(
      isProcessAlive(123, () => {
        throw err;
      })
    ).toBe(true);
  });

  test('false on ESRCH (gone) or any other error', () => {
    const err = Object.assign(new Error('gone'), { code: 'ESRCH' });
    expect(
      isProcessAlive(123, () => {
        throw err;
      })
    ).toBe(false);
  });

  test('false for a non-positive/non-integer pid without even calling kill', () => {
    let called = false;
    const kill = () => {
      called = true;
    };
    expect(isProcessAlive(0, kill)).toBe(false);
    expect(isProcessAlive(-5, kill)).toBe(false);
    expect(isProcessAlive(1.5, kill)).toBe(false);
    expect(called).toBe(false);
  });
});

// ── In-memory HomeLockFs (mirrors _service-helpers.ts's FakeServiceFs style) ──

class MemHomeLockFs implements HomeLockFs {
  files = new Map<string, string>();
  dirs = new Set<string>();

  mkdirp(path: string): void {
    this.dirs.add(path);
  }

  writeExclusive(path: string, data: string): void {
    if (this.files.has(path)) {
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    }
    this.files.set(path, data);
  }

  readFileText(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  remove(path: string): void {
    this.files.delete(path);
  }
}

describe('acquireHomeLock', () => {
  const HOME = '/srv/runner-a';
  const LOCK_PATH = join(HOME, LOCK_FILE_NAME);

  test('a fresh home acquires cleanly and writes a pid/host/timestamp payload', () => {
    const fs = new MemHomeLockFs();
    const lock = acquireHomeLock(HOME, { fs, pid: 111, hostname: 'host-a', now: () => new Date('2026-07-24T00:00:00Z') });
    expect(lock.path).toBe(LOCK_PATH);
    expect(fs.dirs.has(HOME)).toBe(true);
    const payload = JSON.parse(fs.files.get(LOCK_PATH) ?? '{}');
    expect(payload).toEqual({ pid: 111, hostname: 'host-a', started_at: '2026-07-24T00:00:00.000Z' });
  });

  test('a SECOND acquire in the SAME home is refused while the first holder is alive (the P1 guard)', () => {
    const fs = new MemHomeLockFs();
    acquireHomeLock(HOME, { fs, pid: 111, isAlive: () => true });
    expect(() => acquireHomeLock(HOME, { fs, pid: 222, isAlive: () => true })).toThrow(HomeLockError);
    try {
      acquireHomeLock(HOME, { fs, pid: 222, isAlive: () => true });
    } catch (err) {
      expect((err as Error).message).toContain('pid 111');
      expect((err as Error).message).toContain(LOCK_PATH);
      expect((err as Error).message).toContain('PIPELINE_RUNNER_HOME');
    }
  });

  test('two DIFFERENT homes never contend — both acquire independently', () => {
    const fs = new MemHomeLockFs();
    const a = acquireHomeLock('/srv/runner-a', { fs, pid: 111, isAlive: () => true });
    const b = acquireHomeLock('/srv/runner-b', { fs, pid: 222, isAlive: () => true });
    expect(a.path).not.toBe(b.path);
    expect(fs.files.has(a.path)).toBe(true);
    expect(fs.files.has(b.path)).toBe(true);
  });

  test('a lock left by a DEAD pid self-heals: removed and re-acquired, no throw', () => {
    const fs = new MemHomeLockFs();
    acquireHomeLock(HOME, { fs, pid: 111, isAlive: () => true }); // simulate the crashed daemon
    const revived = acquireHomeLock(HOME, { fs, pid: 222, isAlive: (pid) => pid !== 111 });
    expect(revived.path).toBe(LOCK_PATH);
    const payload = JSON.parse(fs.files.get(LOCK_PATH) ?? '{}');
    expect(payload.pid).toBe(222); // the new holder's pid, not the stale one
  });

  test('an unreadable/corrupt lock file is treated as stale and self-heals', () => {
    const fs = new MemHomeLockFs();
    fs.mkdirp(HOME);
    fs.files.set(LOCK_PATH, 'not json');
    const lock = acquireHomeLock(HOME, { fs, pid: 333 });
    expect(fs.files.has(LOCK_PATH)).toBe(true);
    expect(JSON.parse(fs.files.get(LOCK_PATH) ?? '{}').pid).toBe(333);
    expect(lock.path).toBe(LOCK_PATH);
  });

  test('release() removes the lock file; a subsequent acquire in the same home then succeeds', () => {
    const fs = new MemHomeLockFs();
    const lock = acquireHomeLock(HOME, { fs, pid: 111, isAlive: () => true });
    expect(fs.files.has(LOCK_PATH)).toBe(true);
    lock.release();
    expect(fs.files.has(LOCK_PATH)).toBe(false);
    expect(() => acquireHomeLock(HOME, { fs, pid: 222, isAlive: () => true })).not.toThrow();
  });

  test('release() is a no-op the second time (idempotent)', () => {
    const fs = new MemHomeLockFs();
    const lock = acquireHomeLock(HOME, { fs, pid: 111 });
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});

// ── The D17 P1 gate, end-to-end: two isolated homes coexist; a second ──────
// ── daemon in ONE home is refused ───────────────────────────────────────────
describe('two runners, isolated homes (D17 P1 gate)', () => {
  test('two homes never share a config dir, data dir, or workspace root', () => {
    const envA = { PIPELINE_RUNNER_HOME: '/srv/runner-a' };
    const envB = { PIPELINE_RUNNER_HOME: '/srv/runner-b' };

    // join(p) normalizes separators for the host OS — resolveLockHomeDir
    // returns `home` as typed (forward slashes), the others already ran
    // through `join`, so normalize all four the same way before comparing.
    const pathsFor = (env: Record<string, string>) => ({
      config: join(defaultConfigDir(env, 'linux')),
      data: join(defaultDataDir(env, 'linux')),
      workspace: join(resolveWorkspaceRoot(env, 'linux')),
      lock: join(resolveLockHomeDir(env, 'linux')),
    });
    const a = pathsFor(envA);
    const b = pathsFor(envB);

    for (const key of ['config', 'data', 'workspace', 'lock'] as const) {
      expect(a[key]).not.toBe(b[key]);
      expect(a[key].startsWith(join('/srv/runner-a'))).toBe(true);
      expect(b[key].startsWith(join('/srv/runner-b'))).toBe(true);
    }
  });

  test('both homes acquire their lock independently; a second daemon in EITHER home alone is refused', () => {
    const fs = new MemHomeLockFs();
    const homeA = resolveLockHomeDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a' }, 'linux');
    const homeB = resolveLockHomeDir({ PIPELINE_RUNNER_HOME: '/srv/runner-b' }, 'linux');

    const lockA = acquireHomeLock(homeA, { fs, pid: 111, isAlive: () => true });
    const lockB = acquireHomeLock(homeB, { fs, pid: 222, isAlive: () => true });
    expect(lockA.path).not.toBe(lockB.path);

    // A second daemon in home A alone is refused — home B is untouched.
    expect(() => acquireHomeLock(homeA, { fs, pid: 333, isAlive: () => true })).toThrow(HomeLockError);
    expect(() => acquireHomeLock(homeB, { fs, pid: 444, isAlive: () => true })).toThrow(HomeLockError);

    // Releasing one home's lock never affects the other.
    lockA.release();
    expect(() => acquireHomeLock(homeA, { fs, pid: 555, isAlive: () => true })).not.toThrow();
    expect(() => acquireHomeLock(homeB, { fs, pid: 222, isAlive: () => true })).toThrow(HomeLockError); // still held
  });

  test('the single default-home case (no PIPELINE_RUNNER_HOME) also enforces "one daemon" — not just named homes', () => {
    const fs = new MemHomeLockFs();
    const env = { HOME: '/home/u', XDG_STATE_HOME: '/home/u/.state' };
    const defaultHomeDir = resolveLockHomeDir(env, 'linux');

    acquireHomeLock(defaultHomeDir, { fs, pid: 111, isAlive: () => true });
    expect(() => acquireHomeLock(defaultHomeDir, { fs, pid: 222, isAlive: () => true })).toThrow(HomeLockError);
  });
});
