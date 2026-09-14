import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];

interface RecordInput { schema: number; ts: string; level: string; message: string; pid: number }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'runner-logs-cli-'));
  roots.push(root);
  return root;
}

function record(level: string, message: string, ts = '2026-09-13T12:00:00.000Z', pid = 10): RecordInput {
  return { schema: 1, ts, level, message, pid };
}

function writeRecords(root: string, day: string, records: unknown[], suffix = ''): string {
  const dir = join(root, 'data', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `runner-${day}.jsonl`);
  writeFileSync(file, `${records.map((value) => JSON.stringify(value)).join('\n')}${records.length > 0 ? '\n' : ''}${suffix}`);
  return file;
}

function run(root: string, args: string[], env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync(
    [process.execPath, CLI, 'logs', '--home', root, ...args],
    { stdout: 'pipe', stderr: 'pipe', env },
  );
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function follow(root: string, mutate: () => void | Promise<void>, args: string[] = []) {
  const child = Bun.spawn(
    [process.execPath, CLI, 'logs', '--home', root, '--follow', ...args],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    await Bun.sleep(200);
    await mutate();
    await Bun.sleep(1_100);
  } finally {
    child.kill();
    await child.exited;
  }
  return { stdout: await stdout, stderr: await stderr };
}

describe('pipeline-runner logs — history', () => {
  test('an absent or empty log directory is a successful empty result', () => {
    const absent = home();
    expect(run(absent, [])).toEqual({ code: 0, stdout: '', stderr: '' });
    const empty = home();
    mkdirSync(join(empty, 'data', 'logs'), { recursive: true });
    expect(run(empty, [])).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  test('renders columns and ignores malformed, truncated, and wrong-schema records', () => {
    const root = home();
    writeRecords(root, '2026-09-13', [
      record('info', 'online', '2026-09-13T11:00:00.000Z'),
      { ...record('warn', 'bad timestamp'), ts: 'not-a-time' },
      { ...record('warn', 'bad pid'), pid: -1 },
      { ...record('warn', 'future schema'), schema: 2 },
    ], 'truncated {');
    writeFileSync(join(root, 'data', 'logs', 'runner-not-a-date.jsonl'), `${JSON.stringify(record('error', 'wrong filename'))}\n`);

    const result = run(root, ['--limit', '0']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^2026-09-13T11:00:00\.000Z INFO\s+\[pid 10\] online\r?$/m);
    for (const excluded of ['bad timestamp', 'bad pid', 'future schema', 'truncated', 'wrong filename']) {
      expect(result.stdout).not.toContain(excluded);
    }
  });

  test('defaults to newest 200; explicit limits select newest N or all', () => {
    const root = home();
    writeRecords(root, '2026-09-13', Array.from({ length: 205 }, (_, index) => record('info', `entry-${index.toString().padStart(3, '0')}`)));
    const defaultLines = run(root, []).stdout.trim().split(/\r?\n/);
    expect(defaultLines).toHaveLength(200);
    expect(defaultLines[0]).toContain('entry-005');
    expect(defaultLines.at(-1)).toContain('entry-204');
    const two = run(root, ['--limit', '2']).stdout;
    expect(two).not.toContain('entry-202');
    expect(two).toContain('entry-203');
    expect(run(root, ['--limit', '0']).stdout.trim().split(/\r?\n/)).toHaveLength(205);
  });

  test('minimum severity filtering works at every threshold', () => {
    const root = home();
    writeRecords(root, '2026-09-13', [
      record('debug', 'debug-message'), record('info', 'info-message'),
      record('warn', 'warn-message'), record('error', 'error-message'),
    ]);
    for (const [minimum, expected] of [['debug', 4], ['info', 3], ['warn', 2], ['error', 1]] as const) {
      const lines = run(root, ['--level', minimum]).stdout.trim().split(/\r?\n/);
      expect(lines).toHaveLength(expected);
      expect(lines.at(-1)).toContain('error-message');
    }
  });

  test('ISO timestamps are inclusive and duration windows are relative to now', () => {
    const root = home();
    const now = Date.now();
    writeRecords(root, '2026-09-13', [
      record('info', 'before-boundary', '2026-09-13T10:29:59.999Z'),
      record('info', 'at-boundary', '2026-09-13T10:30:00.000Z'),
      record('info', 'inside', new Date(now - 30 * 60_000).toISOString()),
      record('info', 'too-old', new Date(now - 2 * 60 * 60_000).toISOString()),
    ]);
    const iso = run(root, ['--since', '2026-09-13T10:30:00.000Z']).stdout;
    expect(iso).not.toContain('before-boundary');
    expect(iso).toContain('at-boundary');
    const duration = run(root, ['--since', '1h']).stdout;
    expect(duration).toContain('inside');
    expect(duration).not.toContain('too-old');
  });

  test('--json stays parseable and uncoloured with combined filters', () => {
    const root = home();
    const selected = record('error', 'offline', '2026-09-13T12:00:00.000Z', 11);
    writeRecords(root, '2026-09-13', [
      record('error', 'old error', '2026-09-13T09:00:00.000Z'),
      record('info', 'recent info', '2026-09-13T11:00:00.000Z'), selected,
    ]);
    const result = run(root, ['--since', '2026-09-13T10:00:00.000Z', '--level', 'warn', '--json']);
    expect(result.stdout).not.toContain('\x1b[');
    expect(result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))).toEqual([selected]);
  });

  test('--home overrides an ambient home and never reads another instance', () => {
    const selected = home();
    const ambient = home();
    writeRecords(selected, '2026-09-13', [record('info', 'selected-home')]);
    writeRecords(ambient, '2026-09-13', [record('error', 'ambient-home')]);
    const result = run(selected, [], { ...process.env, PIPELINE_RUNNER_HOME: ambient });
    expect(result.stdout).toContain('selected-home');
    expect(result.stdout).not.toContain('ambient-home');
  });
});

describe('pipeline-runner logs — follow', () => {
  test('streams current-file appends without replaying history', async () => {
    const root = home();
    const file = writeRecords(root, '2026-09-13', [record('info', 'history')]);
    const result = await follow(root, () => appendFileSync(file, `${JSON.stringify(record('warn', 'streamed live'))}\n`), ['--limit', '0']);
    expect(result.stderr).toBe('');
    expect(result.stdout.match(/history/g)).toHaveLength(1);
    expect(result.stdout).toContain('streamed live');
  });

  test('discovers a new daily file created after monitoring starts', async () => {
    const root = home();
    writeRecords(root, '2026-09-13', [record('info', 'day one')]);
    const result = await follow(root, () => {
      writeRecords(root, '2026-09-14', [record('info', 'day two', '2026-09-14T00:00:00.000Z')]);
    });
    expect(result.stdout).toContain('day one');
    expect(result.stdout).toContain('day two');
  });

  test('starts before the directory exists and picks up the first record', async () => {
    const root = home();
    const result = await follow(root, () => {
      writeRecords(root, '2026-09-13', [record('error', 'first ever record')]);
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('first ever record');
  });

  test('survives the log directory disappearing and being recreated', async () => {
    const root = home();
    writeRecords(root, '2026-09-13', [record('info', 'before removal')]);
    const result = await follow(root, async () => {
      rmSync(join(root, 'data', 'logs'), { recursive: true, force: true });
      await Bun.sleep(600);
      writeRecords(root, '2026-09-14', [record('warn', 'after recreation', '2026-09-14T00:00:00.000Z')]);
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('before removal');
    expect(result.stdout).toContain('after recreation');
  });

  test('recovers when a followed file is truncated and rewritten', async () => {
    const root = home();
    const file = writeRecords(root, '2026-09-13', [record('info', 'a much longer historical message')]);
    const result = await follow(root, () => {
      writeFileSync(file, `${JSON.stringify(record('error', 'rewritten'))}\n`);
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('rewritten');
  });
});

describe('pipeline-runner logs — invalid input', () => {
  test('help is successful and documents filters and follow mode', () => {
    for (const flag of ['--help', '-h']) {
      const result = run(home(), [flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--follow');
      expect(result.stdout).toContain('--since');
    }
  });

  test('bad and missing values are usage errors, never silently defaulted', () => {
    for (const args of [
      ['--level', 'verbose'], ['--level'], ['--limit', '-1'], ['--limit', '1.5'],
      ['--limit', 'many'], ['--limit'], ['--since', 'yesterday-ish'], ['--since'],
      ['--home'], ['--unknown'],
    ]) {
      const result = run(home(), args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('[pipeline-runner] error:');
    }
  });

  test('an unreadable log location is an operational error without a stack trace', () => {
    const root = home();
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'logs'), 'not a directory');
    const result = run(root, []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('cannot read durable logs:');
    expect(result.stderr).not.toContain('\n    at ');
  });
});

describe('pipeline-runner start — durable startup diagnostics', () => {
  test('an early configuration failure is persisted before the daemon exits', () => {
    const root = home();
    const result = Bun.spawnSync(
      [process.execPath, CLI, 'start', '--home', root],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(result.exitCode).toBe(1);

    const dir = join(root, 'data', 'logs');
    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const records = readFileSync(join(dir, files[0]!), 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as RecordInput);
    expect(records.map((entry) => entry.message)).toEqual([
      `durable log enabled: ${dir}`,
      expect.stringContaining('home lock acquired:'),
      'no agent identity configured — run `pipeline-runner register` first',
    ]);
    expect(records.at(-1)?.level).toBe('error');
  });
});
