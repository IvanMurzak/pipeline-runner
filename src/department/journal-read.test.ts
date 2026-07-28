/**
 * x22 — `pipeline-runner journal`'s read surface.
 *
 * Two things are under test and they are different in kind:
 *
 *  1. The `--json` OUTPUT CONTRACT. Every key is asserted present (a stated
 *     `null`, never a missing key) because another package is going to shell
 *     this out and read it, and a key that appears only sometimes is a bug that
 *     surfaces on somebody else's machine.
 *  2. The FAILURE MODES, all of them. This command exists because
 *     `pipeline department status` rendered `?` for a journal it could not
 *     reach; a read surface that answers "nothing here" for four genuinely
 *     different reasons would have moved that problem rather than fixed it.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  DEFAULT_JOURNAL_LIMIT,
  JOURNAL_READ_SCHEMA,
  journalExitCode,
  type JournalReadFs,
  type JournalReadOutput,
  journalRootForHome,
  readDepartmentJournal,
  renderJournalText,
  type SupervisorObservation,
} from './journal-read';
import { buildDepartmentIndexEntry, departmentIndexPath } from './events';

/** A fake fs backed by one path→text map; a path mapped to an Error THROWS,
 *  which is how the unreadable cases are driven. */
class FakeFs implements JournalReadFs {
  readonly files = new Map<string, string | Error>();
  readonly reads: string[] = [];

  seed(path: string, text: string): this {
    this.files.set(path, text);
    return this;
  }

  fail(path: string, err: Error): this {
    this.files.set(path, err);
    return this;
  }

  existsSync(path: string): boolean {
    return this.files.has(path);
  }

  readFileSync(path: string, _encoding: 'utf-8'): string {
    this.reads.push(path);
    const entry = this.files.get(path);
    if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (entry instanceof Error) throw entry;
    return entry;
  }
}

function line(overrides: Partial<Parameters<typeof buildDepartmentIndexEntry>[0]> = {}): string {
  return JSON.stringify(
    buildDepartmentIndexEntry({
      executionId: 'exec-1',
      taskId: 'task-1',
      contextId: 'ctx-1',
      departmentId: 'dept-1',
      sender: 'ada@example.com',
      engine: 'claude-code',
      journalPath: '/data/department/exec-1/events.jsonl',
      nowIso: '2026-07-28T10:00:00.000Z',
      ...overrides,
    }),
  );
}

const HOME = join('C:', 'runner-home');
const INDEX = departmentIndexPath(journalRootForHome(HOME), 'dept-1');

/** The `--home` path, which never consults the environment or the probe. */
function readWithHome(fs: JournalReadFs, extra: Partial<Parameters<typeof readDepartmentJournal>[0]> = {}) {
  return readDepartmentJournal({ departmentId: 'dept-1', homeFlag: HOME, fs, env: {}, platform: 'linux', ...extra });
}

describe('journal read — the --json contract', () => {
  test('every key is present, with stated nulls rather than omissions', () => {
    const out = readWithHome(new FakeFs());
    const keys = Object.keys(out).sort();
    expect(keys).toEqual([
      'counts',
      'department_id',
      'executions',
      'home_source',
      'message',
      'path',
      'schema',
      'status',
      'supervisor',
      'tasks',
    ]);
    expect(out.schema).toBe(JOURNAL_READ_SCHEMA);
    expect(out.message).toBeNull();
    expect(out.supervisor).toBeNull();
    expect(Object.keys(out.counts).sort()).toEqual(['executions', 'limit', 'skipped', 'truncated']);
  });

  test('an execution entry carries the index line field for field', () => {
    const out = readWithHome(new FakeFs().seed(INDEX, `${line()}\n`));
    expect(out.status).toBe('ok');
    expect(out.executions).toEqual([
      {
        run_id: 'exec-1',
        task_id: 'task-1',
        context_id: 'ctx-1',
        sender: 'ada@example.com',
        engine: 'claude-code',
        ts: '2026-07-28T10:00:00.000Z',
        journal_path: '/data/department/exec-1/events.jsonl',
      },
    ]);
    expect(out.tasks['task-1']).toEqual({
      sender: 'ada@example.com',
      engine: 'claude-code',
      run_id: 'exec-1',
      ts: '2026-07-28T10:00:00.000Z',
    });
  });

  test('the LAST execution of a task wins — a retry re-ran it on another engine', () => {
    const text = [
      line({ executionId: 'exec-1', engine: 'process' }),
      line({ executionId: 'exec-2', engine: 'claude-code', sender: null }),
    ].join('\n');
    const out = readWithHome(new FakeFs().seed(INDEX, text));
    expect(out.counts.executions).toBe(2);
    expect(out.tasks['task-1']).toMatchObject({ run_id: 'exec-2', engine: 'claude-code', sender: null });
  });

  test('a schema-1 line (no sender/engine/task) still parses, as a null-filled execution', () => {
    // b4's own compatibility promise: "a schema-1 line still parses field-for-
    // field as it always did and simply reports no department/sender/engine".
    const legacy = JSON.stringify({
      schema: 1,
      ts: '2026-07-28T09:00:00.000Z',
      type: 'department.execution_started',
      department_id: 'dept-1',
      run_id: 'exec-0',
    });
    const out = readWithHome(new FakeFs().seed(INDEX, legacy));
    expect(out.status).toBe('ok');
    expect(out.executions[0]).toMatchObject({ run_id: 'exec-0', task_id: null, sender: null, engine: null });
    // No task id ⇒ it teaches nothing about a task, but it IS an execution.
    expect(out.tasks).toEqual({});
    expect(out.counts.executions).toBe(1);
  });

  test('unparseable lines are counted and skipped, never fatal (a hard kill truncates the last one)', () => {
    const out = readWithHome(new FakeFs().seed(INDEX, `${line()}\n{"schema":1,"type":"department.exec`));
    expect(out.status).toBe('ok');
    expect(out.counts.executions).toBe(1);
    expect(out.counts.skipped).toBe(1);
  });

  test('only the newest --limit lines are parsed, and truncation is reported', () => {
    const text = Array.from({ length: 5 }, (_, i) => line({ executionId: `exec-${i}`, taskId: `task-${i}` })).join('\n');
    const out = readWithHome(new FakeFs().seed(INDEX, text), { limit: 2 });
    expect(out.counts.limit).toBe(2);
    expect(out.counts.truncated).toBe(true);
    expect(out.executions.map((e) => e.run_id)).toEqual(['exec-3', 'exec-4']);
  });

  test('the default cap is applied when --limit is not given', () => {
    expect(readWithHome(new FakeFs()).counts.limit).toBe(DEFAULT_JOURNAL_LIMIT);
  });
});

describe('journal read — the four statuses, kept distinct', () => {
  test("absent: no index file, and that is NOT an error (exit 0)", () => {
    const out = readWithHome(new FakeFs());
    expect(out.status).toBe('absent');
    expect(out.path).toBe(INDEX);
    expect(journalExitCode(out)).toBe(0);
  });

  test('unreadable: the file is there and permission was refused — the different-account case, once the path is right', () => {
    const out = readWithHome(new FakeFs().fail(INDEX, Object.assign(new Error('nope'), { code: 'EACCES' })));
    expect(out.status).toBe('unreadable');
    expect(out.message).toContain('permission denied');
    expect(out.message).toContain('another OS account');
    expect(journalExitCode(out)).toBe(1);
  });

  test('unreadable is distinct from absent: a directory where the file should be', () => {
    const out = readWithHome(new FakeFs().fail(INDEX, Object.assign(new Error('nope'), { code: 'EISDIR' })));
    expect(out.status).toBe('unreadable');
    expect(out.message).toContain('directory');
  });

  test('a file that vanished between the probe and the read is ABSENT, not broken', () => {
    const out = readWithHome(new FakeFs().fail(INDEX, Object.assign(new Error('gone'), { code: 'ENOENT' })));
    expect(out.status).toBe('absent');
    expect(journalExitCode(out)).toBe(0);
  });

  test('unlocatable: no home, no LOCALAPPDATA, no HOME — there is no path to even look at', () => {
    const out = readDepartmentJournal({ departmentId: 'dept-1', fs: new FakeFs(), env: {}, platform: 'win32' });
    expect(out.status).toBe('unlocatable');
    expect(out.path).toBeNull();
    expect(out.home_source).toBe('none');
    expect(out.message).toContain('LOCALAPPDATA');
    expect(journalExitCode(out)).toBe(1);
  });

  test('ok with zero executions is still ok — an empty index is not an absent one', () => {
    const out = readWithHome(new FakeFs().seed(INDEX, ''));
    expect(out.status).toBe('ok');
    expect(out.counts.executions).toBe(0);
    expect(journalExitCode(out)).toBe(0);
  });
});

describe('journal read — home resolution, and the supervisor probe', () => {
  const observation = (over: Partial<SupervisorObservation> = {}): SupervisorObservation => ({
    backend: 'windows',
    installed: true,
    home: null,
    account: 'LocalSystem',
    systemAccount: true,
    note: null,
    ...over,
  });

  test('--home wins and is NEVER second-guessed: the probe is not even called', () => {
    let probed = false;
    const out = readWithHome(new FakeFs(), {
      probeSupervisor: () => {
        probed = true;
        return observation({ home: join('C:', 'other') });
      },
    });
    expect(out.home_source).toBe('flag');
    expect(probed).toBe(false);
    expect(out.supervisor).toBeNull();
  });

  test('an explicit PIPELINE_RUNNER_HOME is equally final — reading a different home would be the opposite of honest', () => {
    let probed = false;
    const out = readDepartmentJournal({
      departmentId: 'dept-1',
      fs: new FakeFs(),
      env: { PIPELINE_RUNNER_HOME: HOME },
      platform: 'linux',
      probeSupervisor: () => {
        probed = true;
        return observation();
      },
    });
    expect(out.home_source).toBe('env');
    expect(out.status).toBe('absent');
    expect(probed).toBe(false);
  });

  test('the happy path spawns no probe: a default location that ANSWERED is the answer', () => {
    let probed = false;
    const fs = new FakeFs().seed(
      departmentIndexPath(join('/state', 'pipeline-runner', 'department'), 'dept-1'),
      `${line()}\n`,
    );
    const out = readDepartmentJournal({
      departmentId: 'dept-1',
      fs,
      env: { XDG_STATE_HOME: '/state' },
      platform: 'linux',
      probeSupervisor: () => {
        probed = true;
        return observation();
      },
    });
    expect(out.status).toBe('ok');
    expect(out.home_source).toBe('default');
    expect(probed).toBe(false);
  });

  test("nothing at the default location ⇒ the installed definition's pinned home is read INSTEAD", () => {
    const serviceHome = join('C:', 'ProgramData', 'pipeline-runner');
    const fs = new FakeFs().seed(departmentIndexPath(journalRootForHome(serviceHome), 'dept-1'), `${line()}\n`);
    const out = readDepartmentJournal({
      departmentId: 'dept-1',
      fs,
      env: { LOCALAPPDATA: join('C:', 'Users', 'ada', 'AppData', 'Local') },
      platform: 'win32',
      probeSupervisor: () => observation({ home: serviceHome, systemAccount: false, account: null }),
    });
    expect(out.status).toBe('ok');
    expect(out.home_source).toBe('service');
    expect(out.path).toContain('ProgramData');
    expect(out.executions).toHaveLength(1);
    expect(out.supervisor).not.toBeNull();
  });

  test('an unpinned service still reports WHOSE journal it is — the fact a `?` hides', () => {
    const out = readDepartmentJournal({
      departmentId: 'dept-1',
      fs: new FakeFs(),
      env: { LOCALAPPDATA: join('C:', 'Users', 'ada', 'AppData', 'Local') },
      platform: 'win32',
      probeSupervisor: () => observation(),
    });
    expect(out.status).toBe('absent');
    // The path is NOT rewritten — nothing was found anywhere — but the reason
    // is now stated rather than left to the reader to guess.
    expect(out.home_source).toBe('default');
    expect(out.supervisor).toMatchObject({ account: 'LocalSystem', systemAccount: true });
    expect(renderJournalText(out)).toContain('MACHINE account');
  });

  test('a probe whose home resolves to the SAME path does not double-read', () => {
    const local = join('C:', 'Users', 'ada', 'AppData', 'Local');
    const fs = new FakeFs();
    const out = readDepartmentJournal({
      departmentId: 'dept-1',
      fs,
      env: { PIPELINE_RUNNER_HOME: HOME },
      platform: 'win32',
      probeSupervisor: () => observation({ home: HOME }),
    });
    expect(out.home_source).toBe('env');
    expect(local).toBeTruthy();
    expect(fs.reads).toHaveLength(0);
  });

  test('no probe supplied at all ⇒ the default answer stands, with supervisor null', () => {
    const out = readDepartmentJournal({
      departmentId: 'dept-1',
      fs: new FakeFs(),
      env: { LOCALAPPDATA: join('C:', 'x') },
      platform: 'win32',
    });
    expect(out.status).toBe('absent');
    expect(out.supervisor).toBeNull();
  });
});

describe('journal read — the human rendering', () => {
  test('a sender the offer never stated renders as an em dash, never as an invented identity', () => {
    const out = readWithHome(new FakeFs().seed(INDEX, line({ sender: null, engine: null })));
    const text = renderJournalText(out);
    expect(text).toContain('sender —');
    expect(text).toContain('engine —');
  });

  test('absent says what it means instead of printing an empty table', () => {
    expect(renderJournalText(readWithHome(new FakeFs()))).toContain('has never run a task for this department');
  });

  test('unlocatable names the environment as the cause, not the department', () => {
    const out: JournalReadOutput = readDepartmentJournal({
      departmentId: 'dept-1',
      fs: new FakeFs(),
      env: {},
      platform: 'win32',
    });
    expect(renderJournalText(out)).toContain("data directory could not be resolved");
  });
});
