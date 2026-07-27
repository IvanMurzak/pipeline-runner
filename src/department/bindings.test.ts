/**
 * `DepartmentBindingStore` tests (simplified-onboarding b1).
 *
 * Three layers, deliberately separated:
 *
 *   1. LOAD semantics + the 07 §8 permission guard — pure, in-memory, no
 *      timers, no real filesystem.
 *   2. RELOAD wiring — an in-memory watch seam plus `FakeClock`, so the
 *      debounce and the safety-net poll are asserted deterministically rather
 *      than slept on.
 *   3. Two "does the promise hold" tests: one against a REAL filesystem and
 *      real `fs.watch`, and one against a real `DepartmentManager`, since the
 *      DoD is about a running supervisor accepting/rejecting offers, not about
 *      a Map.
 */

import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CaptureLogger, FakeClock } from '../../tests/_helpers';
import type { Dispatcher } from '../core/dispatcher';
import type { RuntimeConfig } from './adapter';
import {
  BINDINGS_API_VERSION,
  BINDINGS_FILE_MODE,
  BINDINGS_FILE_NAME,
  BindingStoreError,
  type BindingFileStat,
  type BindingFileSystem,
  DepartmentBindingStore,
  bindingFilePermissionRefusal,
  nodeBindingFs,
  resolveBindingsPath,
} from './bindings';
import { DEPARTMENT_RUNTIMES_ENV } from './config';
import { FakeAdapter, makeMessage } from './_test-helpers';
import type { DepartmentOfferInput, JournalWriter } from './manager';
import { DepartmentManager } from './manager';

// Derived from `join` so the separators match what the store itself computes
// on every platform (Windows `join('/cfg', …)` yields `\cfg\…`).
const PATH = join('/cfg', BINDINGS_FILE_NAME);
const DIR = dirname(PATH);

/** In-memory `BindingFileSystem` with a manually-driven watch, a mode/uid per
 *  file, and read counters (the debounce assertions need them). */
class MemBindingFs implements BindingFileSystem {
  files = new Map<string, { data: string; mode: number; uid: number }>();
  dirs = new Map<string, number>();
  reads = 0;
  watchers = new Map<string, Array<(filename: string | null) => void>>();
  /** Set to make `watchDir` throw — the "fs.watch is unavailable" branch. */
  watchThrows: Error | null = null;

  statFile(path: string): BindingFileStat | null {
    const file = this.files.get(path);
    return file === undefined ? null : { mode: file.mode, uid: file.uid };
  }

  readFileText(path: string): string | null {
    this.reads += 1;
    return this.files.get(path)?.data ?? null;
  }

  mkdirp(path: string, mode: number): void {
    this.dirs.set(path, mode);
  }

  writeFileAtomic(path: string, data: string, mode: number): void {
    const existing = this.files.get(path);
    this.files.set(path, { data, mode, uid: existing?.uid ?? 1000 });
    this.emit(path);
  }

  /** Test-only: place a file with arbitrary mode/uid (perm-guard fixtures). */
  put(path: string, data: string, mode = BINDINGS_FILE_MODE, uid = 1000): void {
    this.files.set(path, { data, mode, uid });
    this.emit(path);
  }

  remove(path: string): void {
    this.files.delete(path);
    this.emit(path);
  }

  watchDir(path: string, onChange: (filename: string | null) => void): () => void {
    if (this.watchThrows !== null) throw this.watchThrows;
    const list = this.watchers.get(path) ?? [];
    list.push(onChange);
    this.watchers.set(path, list);
    return () => {
      this.watchers.set(path, (this.watchers.get(path) ?? []).filter((cb) => cb !== onChange));
    };
  }

  /** Fire the directory watch for `path`'s parent, as the OS would. */
  emit(path: string): void {
    for (const cb of this.watchers.get(dirname(path)) ?? []) cb(basename(path));
  }
}

function doc(departments: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ apiVersion: BINDINGS_API_VERSION, departments, ...extra });
}

const JSONL: RuntimeConfig = { adapterId: 'jsonl-process', command: 'unity-department', args: ['--stdio'] };

function makeStore(
  options: {
    fs?: MemBindingFs;
    env?: Record<string, string | undefined>;
    clock?: FakeClock;
    logger?: CaptureLogger;
    platform?: string;
    uid?: number | null;
    pollMs?: number;
  } = {}
) {
  const fs = options.fs ?? new MemBindingFs();
  const logger = options.logger ?? new CaptureLogger();
  const clock = options.clock ?? new FakeClock();
  const store = new DepartmentBindingStore({
    dir: DIR,
    fs,
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    uid: options.uid !== undefined ? options.uid : 1000,
    logger,
    clock,
    pollMs: options.pollMs ?? 0,
  });
  return { store, fs, logger, clock };
}

// ── 1. Load semantics ───────────────────────────────────────────────────────

describe('load semantics', () => {
  test('no file and no env var: zero bindings, source none, and it says where the file goes', () => {
    const { store, logger } = makeStore();
    const snapshot = store.reload();
    expect(snapshot.source).toBe('none');
    expect(snapshot.bindings.size).toBe(0);
    expect(snapshot.refusal).toBeNull();
    expect(snapshot.path).toBe(PATH);
    expect(logger.joined()).toContain(PATH);
  });

  test('a well-formed file loads', () => {
    const { store, fs } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }));
    const snapshot = store.reload();
    expect(snapshot.source).toBe('file');
    expect(snapshot.bindings.get('dept-a')).toEqual(JSONL);
    expect(store.get('dept-a')).toEqual(JSONL);
    expect(store.get('dept-unknown')).toBeNull();
  });

  test('apiVersion is optional', () => {
    const { store, fs } = makeStore();
    fs.put(PATH, JSON.stringify({ departments: { 'dept-a': JSONL } }));
    expect(store.reload().bindings.size).toBe(1);
  });

  test('an unknown top-level key warns but does not refuse the document', () => {
    const { store, fs, logger } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }, { writtenBy: 'a newer CLI' }));
    expect(store.reload().bindings.size).toBe(1);
    expect(logger.joined()).toContain("unknown top-level key 'writtenBy'");
  });

  test('one malformed ENTRY is skipped; the rest of the file still applies', () => {
    const { store, fs, logger } = makeStore();
    fs.put(PATH, doc({ broken: { adapterId: 'jsonl-process' }, ok: JSONL }));
    const snapshot = store.reload();
    expect(snapshot.bindings.has('broken')).toBe(false);
    expect(snapshot.bindings.has('ok')).toBe(true);
    expect(logger.joined()).toContain("entry 'broken'");
  });
});

// ── 2. Fail-closed ──────────────────────────────────────────────────────────

describe('fails closed', () => {
  const cases: Array<[string, string, string]> = [
    ['invalid JSON', '{not json', 'not valid JSON'],
    ['a JSON array', '[]', 'not a JSON object'],
    ['a JSON scalar', '"hello"', 'not a JSON object'],
    ['no departments key', JSON.stringify({ apiVersion: BINDINGS_API_VERSION }), 'no `departments` object'],
    ['a departments array', doc([] as unknown as Record<string, unknown>), 'no `departments` object'],
    [
      'an unknown apiVersion',
      JSON.stringify({ apiVersion: 'runner.ai-pipeline.dev/v99', departments: { a: JSONL } }),
      'does not understand',
    ],
    ['a truncated document (partial write)', '{"apiVersion":"runner.ai-pipeline.dev/v1","departments":{"a":{"ada', 'not valid JSON'],
  ];

  for (const [label, text, expected] of cases) {
    test(`${label} yields ZERO bindings with a stated reason`, () => {
      const { store, fs, logger } = makeStore();
      fs.put(PATH, text);
      const snapshot = store.reload();
      expect(snapshot.bindings.size).toBe(0);
      expect(snapshot.refusal).toContain(expected);
      expect(logger.joined()).toContain('REFUSED');
    });
  }

  test('a malformed reload does NOT keep the previously loaded bindings', () => {
    // The security property: a broken file can only ever NARROW what this
    // runner will execute. "Keep the last good set" would be wider than the
    // file now says, and the DoD is explicit — fail closed to "no departments
    // configured", matching the env parser's long-standing behaviour.
    const { store, fs } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }));
    expect(store.reload().bindings.size).toBe(1);
    fs.put(PATH, '{ truncated');
    expect(store.reload().bindings.size).toBe(0);
    expect(store.get('dept-a')).toBeNull();
  });

  test('a file that cannot be read at all fails closed rather than throwing', () => {
    const fs = new MemBindingFs();
    fs.put(PATH, doc({ a: JSONL }));
    fs.readFileText = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    const { store } = makeStore({ fs });
    const snapshot = store.reload();
    expect(snapshot.bindings.size).toBe(0);
    expect(snapshot.refusal).toContain('could not be read');
  });
});

// ── 3. The 07 §8 permission guard ───────────────────────────────────────────

describe('permission guard (07 §8)', () => {
  test('a world-writable file is refused with a stated reason, not silently loaded', () => {
    const { store, fs, logger } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }), 0o666);
    const snapshot = store.reload();
    expect(snapshot.bindings.size).toBe(0);
    expect(snapshot.refusal).toContain('world-writable');
    expect(snapshot.refusal).toContain('chmod 600');
    expect(logger.joined()).toContain('REFUSED');
  });

  test('a group-writable file is refused too', () => {
    const { store, fs } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }), 0o660);
    expect(store.reload().refusal).toContain('group-writable');
  });

  test('0600 and 0644 are accepted (readable is fine; WRITABLE by others is not)', () => {
    for (const mode of [0o600, 0o644, 0o400]) {
      const { store, fs } = makeStore();
      fs.put(PATH, doc({ 'dept-a': JSONL }), mode);
      expect(store.reload().bindings.size).toBe(1);
    }
  });

  test("a file owned by somebody else's account is refused", () => {
    const { store, fs } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }), 0o600, 1234);
    const snapshot = store.reload();
    expect(snapshot.bindings.size).toBe(0);
    expect(snapshot.refusal).toContain('owned by uid 1234');
  });

  test('a root-owned file is accepted — root is not a privilege escalation', () => {
    const { store, fs } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }), 0o600, 0);
    expect(store.reload().bindings.size).toBe(1);
  });

  test('on Windows the mode check is skipped (the per-user ACL is the control)', () => {
    const { store, fs } = makeStore({ platform: 'win32', uid: null });
    fs.put(PATH, doc({ 'dept-a': JSONL }), 0o666, 4321);
    expect(store.reload().bindings.size).toBe(1);
  });

  test('bindingFilePermissionRefusal is a pure predicate', () => {
    expect(bindingFilePermissionRefusal({ mode: 0o600, uid: 1000 }, PATH, 'linux', 1000)).toBeNull();
    expect(bindingFilePermissionRefusal({ mode: 0o602, uid: 1000 }, PATH, 'linux', 1000)).toContain('world-writable');
    expect(bindingFilePermissionRefusal({ mode: 0o620, uid: 1000 }, PATH, 'linux', 1000)).toContain('group-writable');
    expect(bindingFilePermissionRefusal({ mode: 0o666, uid: 1000 }, PATH, 'win32', 1000)).toBeNull();
    expect(bindingFilePermissionRefusal({ mode: 0o600, uid: 7 }, PATH, 'linux', null)).toBeNull();
  });
});

// ── 4. PIPELINE_RUNNER_DEPARTMENTS retirement ───────────────────────────────

describe('PIPELINE_RUNNER_DEPARTMENTS (deprecated)', () => {
  const envValue = JSON.stringify({ 'legacy-dept': { adapterId: 'jsonl-process', command: 'legacy' } });

  test('still works when no binding file exists, with a deprecation warning', () => {
    const { store, logger } = makeStore({ env: { [DEPARTMENT_RUNTIMES_ENV]: envValue } });
    const snapshot = store.reload();
    expect(snapshot.source).toBe('env');
    expect(snapshot.bindings.get('legacy-dept')?.command).toBe('legacy');
    expect(logger.joined()).toContain('DEPRECATED');
    expect(logger.joined()).toContain('CANNOT pick up a new department without a');
  });

  test('the file wins outright when both are present, and the variable is named as ignored', () => {
    const { store, fs, logger } = makeStore({ env: { [DEPARTMENT_RUNTIMES_ENV]: envValue } });
    fs.put(PATH, doc({ 'file-dept': JSONL }));
    const snapshot = store.reload();
    expect(snapshot.source).toBe('file');
    expect(snapshot.bindings.has('legacy-dept')).toBe(false);
    expect(snapshot.bindings.has('file-dept')).toBe(true);
    expect(logger.joined()).toContain('IGNORED');
  });

  test('a REFUSED file does not fall back to the env var — that would be a widening', () => {
    const { store, fs } = makeStore({ env: { [DEPARTMENT_RUNTIMES_ENV]: envValue } });
    fs.put(PATH, doc({ 'file-dept': JSONL }), 0o666);
    const snapshot = store.reload();
    expect(snapshot.source).toBe('file');
    expect(snapshot.bindings.size).toBe(0);
    expect(snapshot.refusal).toContain('world-writable');
  });

  test('a blank variable is treated as unset', () => {
    const { store } = makeStore({ env: { [DEPARTMENT_RUNTIMES_ENV]: '   ' } });
    expect(store.reload().source).toBe('none');
  });
});

// ── 5. Reload wiring: watch, debounce, poll ─────────────────────────────────

describe('reload wiring', () => {
  test('a supervisor already watching picks up a newly written binding, without a restart', () => {
    const { store, fs, clock } = makeStore();
    store.reload();
    const reloads: number[] = [];
    const stop = store.watch((snapshot, changed) => {
      if (changed) reloads.push(snapshot.bindings.size);
    });
    expect(store.get('dept-a')).toBeNull();

    fs.put(PATH, doc({ 'dept-a': JSONL }));
    expect(store.get('dept-a')).toBeNull(); // debounced, not yet
    clock.advance(200);

    expect(store.get('dept-a')).toEqual(JSONL);
    expect(reloads).toEqual([1]);
    stop();
  });

  test('removing a binding is picked up the same way', () => {
    const { store, fs, clock } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL, 'dept-b': JSONL }));
    store.reload();
    const stop = store.watch();
    fs.put(PATH, doc({ 'dept-b': JSONL }));
    clock.advance(200);
    expect(store.get('dept-a')).toBeNull();
    expect(store.get('dept-b')).toEqual(JSONL);
    stop();
  });

  test('a burst of watch events coalesces into ONE read (a non-atomic writer never lands mid-write)', () => {
    const { store, fs, clock } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }));
    store.reload();
    const readsAfterInitial = fs.reads;
    const stop = store.watch();

    // truncate → partial → complete, as a naive writeFileSync would produce.
    fs.files.set(PATH, { data: '', mode: BINDINGS_FILE_MODE, uid: 1000 });
    fs.emit(PATH);
    fs.files.set(PATH, { data: '{"apiVersion":"runner', mode: BINDINGS_FILE_MODE, uid: 1000 });
    fs.emit(PATH);
    fs.files.set(PATH, { data: doc({ 'dept-a': JSONL, 'dept-b': JSONL }), mode: BINDINGS_FILE_MODE, uid: 1000 });
    fs.emit(PATH);
    clock.advance(200);

    expect(fs.reads - readsAfterInitial).toBe(1);
    expect(store.size).toBe(2);
    stop();
  });

  test('changes to unrelated files in the same directory are ignored', () => {
    const { store, fs, clock } = makeStore();
    store.reload();
    const readsBefore = fs.reads;
    const stop = store.watch();
    for (const cb of fs.watchers.get(DIR) ?? []) cb('config.json');
    clock.advance(500);
    expect(fs.reads).toBe(readsBefore);
    stop();
  });

  test('the safety-net poll re-reads even when the watch never fires', () => {
    const fs = new MemBindingFs();
    fs.watchThrows = Object.assign(new Error('ENOSYS: fs.watch unavailable'), { code: 'ENOSYS' });
    const { store, clock, logger } = makeStore({ fs, pollMs: 30_000 });
    store.reload();
    const stop = store.watch();
    expect(logger.joined()).toContain('could not watch');

    fs.files.set(PATH, { data: doc({ 'dept-a': JSONL }), mode: BINDINGS_FILE_MODE, uid: 1000 });
    clock.advance(29_000);
    expect(store.get('dept-a')).toBeNull();
    clock.advance(2_000);
    expect(store.get('dept-a')).toEqual(JSONL);
    stop();
  });

  test('stop() ends both triggers', () => {
    const { store, fs, clock } = makeStore({ pollMs: 30_000 });
    store.reload();
    const stop = store.watch();
    stop();
    fs.put(PATH, doc({ 'dept-a': JSONL }));
    clock.advance(120_000);
    expect(store.get('dept-a')).toBeNull();
    expect(clock.pendingCount).toBe(0);
  });

  test('the log stays quiet while the answer is unchanged, and speaks when it changes', () => {
    const { store, fs, logger, clock } = makeStore({ pollMs: 1_000 });
    fs.put(PATH, doc({ 'dept-a': JSONL }));
    store.reload();
    const linesAfterFirst = logger.lines.length;
    const stop = store.watch();
    clock.advance(10_000); // ten polls, same answer
    expect(logger.lines.length).toBe(linesAfterFirst);
    fs.put(PATH, doc({ 'dept-a': JSONL, 'dept-b': JSONL }));
    clock.advance(2_000);
    expect(logger.lines.length).toBeGreaterThan(linesAfterFirst);
    stop();
  });
});

// ── 6. Write side ───────────────────────────────────────────────────────────

describe('write side', () => {
  test('bind writes a versioned envelope at mode 0600 with sorted keys', () => {
    const { store, fs } = makeStore();
    store.bind('dept-b', JSONL);
    store.bind('dept-a', { adapterId: 'jsonl-process', command: 'a' });
    const file = fs.files.get(PATH)!;
    expect(file.mode).toBe(0o600);
    expect(fs.dirs.get(DIR)).toBe(0o700);
    const parsed = JSON.parse(file.data) as { apiVersion: string; departments: Record<string, unknown> };
    expect(parsed.apiVersion).toBe(BINDINGS_API_VERSION);
    expect(Object.keys(parsed.departments)).toEqual(['dept-a', 'dept-b']);
    expect(store.reload().bindings.size).toBe(2);
  });

  test('bind narrows the spec — an unrecognized lifecycle is dropped, not stored', () => {
    const { store } = makeStore();
    const stored = store.bind('d', { adapterId: 'jsonl-process', command: 'd', lifecycle: 'forever' });
    expect(stored.lifecycle).toBeUndefined();
  });

  test('bind refuses a spec with no command', () => {
    const { store } = makeStore();
    expect(() => store.bind('d', { adapterId: 'jsonl-process' })).toThrow(BindingStoreError);
  });

  test('unbind removes one and reports whether it was there', () => {
    const { store } = makeStore();
    store.bind('dept-a', JSONL);
    store.bind('dept-b', JSONL);
    expect(store.unbind('dept-a')).toBe(true);
    expect(store.unbind('dept-a')).toBe(false);
    expect(store.reload().bindings.size).toBe(1);
  });

  test('the write side REFUSES a file that failed the permission guard, rather than silently rewriting it', () => {
    const { store, fs } = makeStore();
    fs.put(PATH, doc({ 'dept-a': JSONL }), 0o666);
    expect(() => store.bind('dept-b', JSONL)).toThrow(BindingStoreError);
    // The suspect file is left exactly as it was, for a human to look at.
    expect(fs.files.get(PATH)!.mode).toBe(0o666);
  });

  test('the write side refuses to clobber a file it could not interpret', () => {
    const { store, fs } = makeStore();
    fs.put(PATH, '{ truncated');
    expect(() => store.bind('dept-b', JSONL)).toThrow(/refusing to overwrite/);
    expect(fs.files.get(PATH)!.data).toBe('{ truncated');
  });

  test('the write side never materializes the deprecated env var into the file', () => {
    const { store, fs } = makeStore({
      env: { [DEPARTMENT_RUNTIMES_ENV]: JSON.stringify({ legacy: { adapterId: 'jsonl-process', command: 'legacy' } }) },
    });
    store.bind('dept-a', JSONL);
    const parsed = JSON.parse(fs.files.get(PATH)!.data) as { departments: Record<string, unknown> };
    expect(Object.keys(parsed.departments)).toEqual(['dept-a']);
  });
});

// ── 7. Real filesystem + real fs.watch ──────────────────────────────────────

describe('real filesystem', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pr-bindings-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('resolveBindingsPath is home-aware', () => {
    expect(resolveBindingsPath({ PIPELINE_RUNNER_HOME: '/homes/one' }, 'linux')).toBe(join('/homes/one', 'config', BINDINGS_FILE_NAME));
    expect(resolveBindingsPath({ PIPELINE_RUNNER_HOME: '/homes/two' }, 'linux')).not.toBe(
      resolveBindingsPath({ PIPELINE_RUNNER_HOME: '/homes/one' }, 'linux')
    );
  });

  test('writeFileAtomic lands a complete document at 0600', () => {
    const store = new DepartmentBindingStore({ dir, fs: nodeBindingFs(), env: {}, logger: new CaptureLogger() });
    store.bind('dept-a', JSONL);
    const stat = statSync(store.path);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    expect(store.reload().bindings.get('dept-a')).toEqual(JSONL);
    // No temp file left behind.
    expect(store.reload().refusal).toBeNull();
  });

  test('a real running watch sees a real write within a few seconds', async () => {
    const logger = new CaptureLogger();
    const reader = new DepartmentBindingStore({ dir, fs: nodeBindingFs(), env: {}, logger, debounceMs: 20, pollMs: 250 });
    reader.reload();
    const stop = reader.watch();
    try {
      expect(reader.get('dept-a')).toBeNull();
      // A separate store instance, exactly as `pipeline-runner bind` is a
      // separate PROCESS from the supervisor.
      new DepartmentBindingStore({ dir, fs: nodeBindingFs(), env: {}, logger }).bind('dept-a', JSONL);

      const deadline = Date.now() + 8_000;
      while (reader.get('dept-a') === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(reader.get('dept-a')).toEqual(JSONL);

      new DepartmentBindingStore({ dir, fs: nodeBindingFs(), env: {}, logger }).unbind('dept-a');
      const deadline2 = Date.now() + 8_000;
      while (reader.get('dept-a') !== null && Date.now() < deadline2) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(reader.get('dept-a')).toBeNull();
    } finally {
      stop();
    }
  }, 20_000);

  test('a world-writable real file is refused', () => {
    if (process.platform === 'win32') return; // modes are synthesised there
    const path = join(dir, BINDINGS_FILE_NAME);
    writeFileSync(path, doc({ 'dept-a': JSONL }));
    // `writeFileSync`'s `mode` is masked by the process umask (022 on most CI
    // images, which would silently produce a harmless 0644) — chmod after the
    // fact is the only way to actually get the mode under test.
    chmodSync(path, 0o666);
    const store = new DepartmentBindingStore({ dir, fs: nodeBindingFs(), env: {}, logger: new CaptureLogger() });
    const snapshot = store.reload();
    expect(snapshot.bindings.size).toBe(0);
    expect(snapshot.refusal).toContain('writable');
  });
});

// ── 8. The DoD's actual claim: a live supervisor's admission decisions ──────

class MemJournal implements JournalWriter {
  ensureDir(): void {}
  appendLine(): void {}
}

const NULL_DISPATCHER: Pick<Dispatcher, 'on'> = { on: () => () => {} };

function makeOffer(departmentId: string, executionId: string): DepartmentOfferInput {
  return { executionId, taskId: `t-${executionId}`, contextId: `c-${executionId}`, departmentId, messages: [makeMessage()] };
}

describe('DepartmentManager wired to the live store', () => {
  test('an offer is rejected before the bind, accepted after it, and rejected again after the unbind — one process throughout', async () => {
    const fs = new MemBindingFs();
    const clock = new FakeClock();
    const store = new DepartmentBindingStore({
      dir: DIR,
      fs,
      env: {},
      platform: 'linux',
      uid: 1000,
      logger: new CaptureLogger(),
      clock,
      pollMs: 0,
    });
    store.reload();
    const stopWatch = store.watch();

    const adapter = new FakeAdapter();
    const manager = new DepartmentManager({
      adapters: [adapter],
      // EXACTLY the wiring cli.ts uses: a live accessor, never a captured Map.
      resolveRuntimeConfig: (departmentId) => store.get(departmentId),
      send: () => true,
      dispatcher: NULL_DISPATCHER,
      journal: new MemJournal(),
      journalRoot: '/data/department',
      clock: new FakeClock(),
      logger: new CaptureLogger(),
    });

    expect(await manager.admitTask(makeOffer('dept-a', 'x1'))).toEqual({ accepted: false, reason: 'capability' });

    // A second process writes the binding; the supervisor keeps running.
    new DepartmentBindingStore({ dir: DIR, fs, env: {}, platform: 'linux', uid: 1000, logger: new CaptureLogger() }).bind('dept-a', {
      adapterId: 'fake',
      command: 'dept-a',
    });
    clock.advance(200);

    expect(await manager.admitTask(makeOffer('dept-a', 'x2'))).toEqual({ accepted: true });
    expect(adapter.startCalls()).toHaveLength(1);

    new DepartmentBindingStore({ dir: DIR, fs, env: {}, platform: 'linux', uid: 1000, logger: new CaptureLogger() }).unbind('dept-a');
    clock.advance(200);

    expect(await manager.admitTask(makeOffer('dept-a', 'x3'))).toEqual({ accepted: false, reason: 'capability' });
    // The already-running execution is untouched — unbinding stops OFFERS.
    expect(adapter.calls.filter((c) => c.kind === 'cancel')).toHaveLength(0);

    stopWatch();
  });

  test('a store whose file turns malformed stops accepting offers (fail closed end-to-end)', async () => {
    const fs = new MemBindingFs();
    fs.put(PATH, doc({ 'dept-a': { adapterId: 'fake', command: 'dept-a' } }));
    const { store } = makeStore({ fs });
    store.reload();

    const manager = new DepartmentManager({
      adapters: [new FakeAdapter()],
      resolveRuntimeConfig: (departmentId) => store.get(departmentId),
      send: () => true,
      dispatcher: NULL_DISPATCHER,
      journal: new MemJournal(),
      journalRoot: '/data/department',
      clock: new FakeClock(),
      logger: new CaptureLogger(),
    });

    expect(await manager.admitTask(makeOffer('dept-a', 'y1'))).toEqual({ accepted: true });
    fs.put(PATH, '{ truncated');
    store.reload();
    expect(await manager.admitTask(makeOffer('dept-a', 'y2'))).toEqual({ accepted: false, reason: 'capability' });
  });
});
