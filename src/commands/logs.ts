/** Read the runner daemon's durable JSONL log.
 *
 * `--follow` deliberately polls files rather than holding one descriptor: the
 * writer rolls to a new UTC-dated file without renaming the old one, and a
 * follower that spans midnight must automatically move with it.
 */

import { existsSync, openSync, closeSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINE_RUNNER_HOME_ENV } from '../core/config';
import { runnerLogDir, type LogLevel, type RunnerLogRecord } from '../core/log';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const FOLLOW_POLL_MS = 500;

interface LogsOptions {
  follow: boolean;
  json: boolean;
  limit: number;
  minimumLevel: LogLevel;
  sinceMs: number | null;
}

function usage(): void {
  console.log([
    'usage: pipeline-runner logs [--follow] [--json] [--limit <n>]',
    '                            [--level <debug|info|warn|error>]',
    '                            [--since <duration|ISO-time>] [--home <path>]',
    '',
    '  Reads durable runner logs. --follow continues across daily file rotation.',
    '  --since accepts 30s, 15m, 12h, 7d, or an ISO-8601 timestamp.',
    '  --limit defaults to 200; use 0 for every matching record.',
  ].join('\n'));
}

function parseSince(raw: string, now: number): number {
  const duration = /^(\d+)(s|m|h|d)$/.exec(raw);
  if (duration !== null) {
    const scale = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as 's' | 'm' | 'h' | 'd'];
    return now - Number(duration[1]) * scale;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--since must be a duration (for example 30m) or ISO timestamp — got '${raw}'`);
  return parsed;
}

function parseArgs(argv: string[], now = Date.now()): LogsOptions | null {
  const options: LogsOptions = { follow: false, json: false, limit: 200, minimumLevel: 'debug', sinceMs: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--follow' || arg === '-f') options.follow = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--home' && argv[i + 1] !== undefined) process.env[PIPELINE_RUNNER_HOME_ENV] = argv[++i]!;
    else if (arg === '--limit' && argv[i + 1] !== undefined) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) throw new Error('--limit must be a non-negative integer');
      options.limit = value;
    } else if (arg === '--level' && argv[i + 1] !== undefined) {
      const value = argv[++i] as LogLevel;
      if (!LEVELS.includes(value)) throw new Error(`--level must be one of ${LEVELS.join('|')}`);
      options.minimumLevel = value;
    } else if (arg === '--since' && argv[i + 1] !== undefined) options.sinceMs = parseSince(argv[++i]!, now);
    else throw new Error(`unknown logs argument '${arg}'`);
  }
  return options;
}

function logFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => /^runner-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .map((name) => join(dir, name));
  } catch (err) {
    // The directory can disappear between existsSync and readdir during an
    // uninstall/cleanup. A follower treats that like an empty interval.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function parseRecord(line: string): RunnerLogRecord | null {
  try {
    const value = JSON.parse(line) as Partial<RunnerLogRecord>;
    if (value.schema !== 1
      || typeof value.ts !== 'string'
      || !Number.isFinite(Date.parse(value.ts))
      || !LEVELS.includes(value.level as LogLevel)
      || typeof value.message !== 'string'
      || typeof value.pid !== 'number'
      || !Number.isInteger(value.pid)
      || value.pid < 0) return null;
    return value as RunnerLogRecord;
  } catch {
    return null; // a hard kill may leave one incomplete final line
  }
}

function matches(record: RunnerLogRecord, options: LogsOptions): boolean {
  return LEVELS.indexOf(record.level) >= LEVELS.indexOf(options.minimumLevel)
    && (options.sinceMs === null || Date.parse(record.ts) >= options.sinceMs);
}

function render(record: RunnerLogRecord, json: boolean): string {
  if (json) return JSON.stringify(record);
  const level = record.level.toUpperCase().padEnd(5);
  const colors: Record<LogLevel, string> = {
    debug: '\x1b[90m',
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
  };
  const renderedLevel = process.stdout.isTTY && process.env.NO_COLOR === undefined
    ? `${colors[record.level]}${level}\x1b[0m`
    : level;
  return `${record.ts} ${renderedLevel} [pid ${record.pid}] ${record.message}`;
}

function readPrefix(file: string, length: number): string {
  if (length === 0) return '';
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  let read = 0;
  try {
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, read);
      if (count === 0) break;
      read += count;
    }
  } finally {
    closeSync(fd);
  }
  return buffer.subarray(0, read).toString('utf8');
}

function readRecords(files: string[], options: LogsOptions, sizes?: Map<string, number>): RunnerLogRecord[] {
  const records: RunnerLogRecord[] = [];
  for (const file of files) {
    const text = sizes === undefined ? readFileSync(file, 'utf8') : readPrefix(file, sizes.get(file) ?? 0);
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      const record = parseRecord(line);
      if (record !== null && matches(record, options)) records.push(record);
    }
  }
  return options.limit === 0 ? records : records.slice(-options.limit);
}

function readAdded(file: string, offset: number): { text: string; offset: number } {
  const size = statSync(file).size;
  if (size <= offset) return { text: '', offset: size < offset ? 0 : offset };
  const length = size - offset;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  let read = 0;
  try {
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    }
  } finally {
    closeSync(fd);
  }
  return { text: buffer.subarray(0, read).toString('utf8'), offset: offset + read };
}

function trySize(file: string): number | null {
  try {
    return statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function runLogs(argv: string[]): Promise<number> {
  let options: LogsOptions | null;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`[pipeline-runner] error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  if (options === null) {
    usage();
    return 0;
  }

  try {
    const dir = runnerLogDir();
    const initialFiles = logFiles(dir);
    // Freeze the initial boundary before reading. Without this snapshot a
    // write racing between history and offset setup could be skipped forever.
    const initialSizes = options.follow ? new Map<string, number>() : undefined;
    if (initialSizes !== undefined) {
      for (const file of initialFiles) {
        const size = trySize(file);
        if (size !== null) initialSizes.set(file, size);
      }
    }
    for (const record of readRecords(initialFiles, options, initialSizes)) console.log(render(record, options.json));
    if (!options.follow) return 0;

    const offsets = new Map<string, number>();
    const tails = new Map<string, string>();
    for (const file of initialFiles) offsets.set(file, initialSizes!.get(file) ?? 0);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
      for (const file of logFiles(dir)) {
        let added: { text: string; offset: number };
        try {
          added = readAdded(file, offsets.get(file) ?? 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        offsets.set(file, added.offset);
        const combined = (tails.get(file) ?? '') + added.text;
        const lines = combined.split(/\r?\n/);
        tails.set(file, lines.pop() ?? '');
        for (const line of lines) {
          const record = parseRecord(line);
          if (record !== null && matches(record, options)) console.log(render(record, options.json));
        }
      }
    }
  } catch (err) {
    console.error(`[pipeline-runner] error: cannot read durable logs: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
