import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configurePersistentLogging,
  consoleLogger,
  disablePersistentLogging,
  runnerLogDir,
  runnerLogFile,
  type RunnerLogRecord,
} from './log';

const roots: string[] = [];
afterEach(() => {
  disablePersistentLogging();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-runner-log-'));
  roots.push(root);
  return root;
}

describe('durable runner log', () => {
  test('writes one structured record to the isolated home data directory', () => {
    const root = home();
    const now = new Date('2026-09-13T12:34:56.789Z');
    const dir = configurePersistentLogging({ env: { PIPELINE_RUNNER_HOME: root }, now: () => now });
    consoleLogger.info('runner online');

    expect(dir).toBe(join(root, 'data', 'logs'));
    const record = JSON.parse(readFileSync(runnerLogFile(dir, now), 'utf8')) as RunnerLogRecord;
    expect(record).toEqual({
      schema: 1,
      ts: now.toISOString(),
      level: 'info',
      message: 'runner online',
      pid: process.pid,
    });
  });

  test('writes every level as one JSONL record, including multiline and Unicode messages', () => {
    const root = home();
    const now = new Date('2026-09-13T12:34:56.789Z');
    const dir = configurePersistentLogging({ env: { PIPELINE_RUNNER_HOME: root }, now: () => now });
    const debug = spyOn(console, 'debug').mockImplementation(() => {});
    const info = spyOn(console, 'log').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      consoleLogger.debug('details');
      consoleLogger.info('line one\nline two');
      consoleLogger.warn('предупреждение');
      consoleLogger.error('failed');
    } finally {
      debug.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }

    const lines = readFileSync(runnerLogFile(dir, now), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    const records = lines.map((line) => JSON.parse(line) as RunnerLogRecord);
    expect(records.map((record) => record.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(records[1]!.message).toBe('line one\nline two');
    expect(records[2]!.message).toBe('предупреждение');
  });

  test('daily rotation is filename-based and startup removes expired files', () => {
    const root = home();
    const env = { PIPELINE_RUNNER_HOME: root };
    const dir = runnerLogDir(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runner-2026-07-01.jsonl'), 'old\n');
    writeFileSync(join(dir, 'runner-2026-09-12.jsonl'), 'recent\n');
    writeFileSync(join(dir, 'keep-me.txt'), 'unrelated\n');

    configurePersistentLogging({ env, now: () => new Date('2026-09-13T00:00:00.000Z'), retentionDays: 30 });
    expect(readdirSync(dir).sort()).toEqual(['keep-me.txt', 'runner-2026-09-12.jsonl']);
  });

  test('retention keeps exactly the configured UTC date window at its boundary', () => {
    const root = home();
    const env = { PIPELINE_RUNNER_HOME: root };
    const dir = runnerLogDir(env);
    mkdirSync(dir, { recursive: true });
    for (const day of ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2099-01-01']) {
      writeFileSync(join(dir, `runner-${day}.jsonl`), `${day}\n`);
    }

    configurePersistentLogging({ env, now: () => new Date('2026-09-13T23:59:59.999Z'), retentionDays: 3 });
    expect(readdirSync(dir).sort()).toEqual([
      'runner-2026-09-11.jsonl',
      'runner-2026-09-12.jsonl',
      'runner-2026-09-13.jsonl',
      'runner-2099-01-01.jsonl',
    ]);
  });

  test('a long-running process rotates and prunes again when the UTC day changes', () => {
    const root = home();
    const env = { PIPELINE_RUNNER_HOME: root };
    let now = new Date('2026-09-13T23:59:59.999Z');
    const dir = configurePersistentLogging({ env, now: () => now, retentionDays: 2 });
    consoleLogger.info('before midnight');
    writeFileSync(join(dir, 'runner-2026-09-11.jsonl'), 'expired after rotation\n');

    now = new Date('2026-09-14T00:00:00.000Z');
    consoleLogger.info('after midnight');

    expect(readdirSync(dir).sort()).toEqual(['runner-2026-09-13.jsonl', 'runner-2026-09-14.jsonl']);
    expect(readFileSync(join(dir, 'runner-2026-09-14.jsonl'), 'utf8')).toContain('after midnight');
  });

  test('a restart separates the next record from a crash-truncated tail', () => {
    const root = home();
    const env = { PIPELINE_RUNNER_HOME: root };
    const now = new Date('2026-09-13T12:34:56.789Z');
    const dir = runnerLogDir(env);
    mkdirSync(dir, { recursive: true });
    const file = runnerLogFile(dir, now);
    writeFileSync(file, '{"schema":1,"ts":"incomplete');

    configurePersistentLogging({ env, now: () => now });
    consoleLogger.warn('recovered');

    const lines = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0]!)).toThrow();
    expect(JSON.parse(lines[1]!).message).toBe('recovered');
  });

  test('a clean newline boundary is not padded with an empty record on restart', () => {
    const root = home();
    const env = { PIPELINE_RUNNER_HOME: root };
    const now = new Date('2026-09-13T12:34:56.789Z');
    const dir = runnerLogDir(env);
    mkdirSync(dir, { recursive: true });
    const file = runnerLogFile(dir, now);
    writeFileSync(file, '{"already":"complete"}\n');

    configurePersistentLogging({ env, now: () => now });
    consoleLogger.info('next');

    expect(readFileSync(file, 'utf8').split('\n')).toHaveLength(3);
  });

  test('invalid retention policies fail configuration explicitly', () => {
    for (const retentionDays of [0, -1, 1.5, Number.NaN]) {
      expect(() => configurePersistentLogging({
        env: { PIPELINE_RUNNER_HOME: home() },
        retentionDays,
      })).toThrow(/positive integer/);
    }
  });

  test('an unusable log path fails configuration instead of pretending persistence is enabled', () => {
    const root = home();
    const blockedHome = join(root, 'not-a-directory');
    writeFileSync(blockedHome, 'file');
    expect(() => configurePersistentLogging({ env: { PIPELINE_RUNNER_HOME: blockedHome } })).toThrow();
  });

  test('a later write failure never crashes the runner and is reported only once', () => {
    const root = home();
    const env = { PIPELINE_RUNNER_HOME: root };
    const dir = configurePersistentLogging({ env });
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'blocks the former directory');
    const diagnostic = spyOn(console, 'error').mockImplementation(() => {});
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(() => consoleLogger.info('first failed append')).not.toThrow();
      expect(() => consoleLogger.info('second failed append')).not.toThrow();
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(String(diagnostic.mock.calls[0]?.[0])).toContain('durable logging disabled by write failure');
    } finally {
      diagnostic.mockRestore();
      output.mockRestore();
    }
  });
});
