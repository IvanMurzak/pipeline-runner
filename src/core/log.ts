import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from '../shipper/fs';

/**
 * Minimal injectable logger seam. Every core module takes a `Logger` so tests
 * can capture output and assert — most importantly — that the runner token
 * NEVER appears in any log line. Never pass raw frames or the identity object
 * into a log call; log type names and redacted views only (see
 * `describeIdentity` in `config.ts`).
 */

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Stable on-disk record read by `pipeline-runner logs`. One JSON object per
 * line means a hard kill can damage at most the final line. */
export interface RunnerLogRecord {
  schema: 1;
  ts: string;
  level: LogLevel;
  message: string;
  pid: number;
}

export const LOG_DIR_NAME = 'logs';
export const LOG_FILE_PREFIX = 'runner-';
export const DEFAULT_LOG_RETENTION_DAYS = 30;

interface PersistentLogState {
  dir: string;
  now: () => Date;
  retentionDays: number;
  lastPrunedDay: string;
}

let persistent: PersistentLogState | null = null;
let persistenceFailureReported = false;

export function runnerLogDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  return join(defaultDataDir(env, platform), LOG_DIR_NAME);
}

export function runnerLogFile(dir: string, date: Date): string {
  return join(dir, `${LOG_FILE_PREFIX}${date.toISOString().slice(0, 10)}.jsonl`);
}

function pruneExpiredFiles(dir: string, now: Date, retentionDays: number): void {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Retention counts UTC calendar files including today: 1 keeps only today's
  // file, 30 keeps today plus the preceding 29 date labels.
  const cutoff = today - (retentionDays - 1) * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(dir)) {
    const match = /^runner-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (match === null) continue;
    const stamp = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (Number.isFinite(stamp) && stamp < cutoff) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // Retention is maintenance, not a reason to lose current logs. A file
        // temporarily held by antivirus/backup software is retried next day.
      }
    }
  }
}

/** A killed append can leave a partial last JSON object. Put the next valid
 * object on a fresh line so the reader loses only that partial object. */
function repairAppendBoundary(file: string): void {
  if (!existsSync(file) || statSync(file).size === 0) return;
  const fd = openSync(file, 'r');
  const finalByte = Buffer.alloc(1);
  try {
    readSync(fd, finalByte, 0, 1, statSync(file).size - 1);
  } finally {
    closeSync(fd);
  }
  if (finalByte[0] !== 0x0a) appendFileSync(file, '\n', 'utf8');
}

/** Enable the daemon's durable log before it starts any long-lived work.
 * Daily files avoid rename races on Windows; expiry runs at startup and each
 * UTC day transition, while normal logging remains one append per record. */
export function configurePersistentLogging(options: {
  env?: Record<string, string | undefined>;
  platform?: string;
  now?: () => Date;
  retentionDays?: number;
} = {}): string {
  const retentionDays = options.retentionDays ?? DEFAULT_LOG_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`log retentionDays must be a positive integer — got '${retentionDays}'`);
  }
  const dir = runnerLogDir(options.env ?? process.env, options.platform ?? process.platform);
  mkdirSync(dir, { recursive: true });
  const nowFn = options.now ?? (() => new Date());
  const now = nowFn();
  pruneExpiredFiles(dir, now, retentionDays);
  repairAppendBoundary(runnerLogFile(dir, now));
  persistent = {
    dir,
    now: nowFn,
    retentionDays,
    lastPrunedDay: now.toISOString().slice(0, 10),
  };
  persistenceFailureReported = false;
  return dir;
}

/** Test/reset seam; a normal process configures logging once. */
export function disablePersistentLogging(): void {
  persistent = null;
  persistenceFailureReported = false;
}

function writePersistent(level: LogLevel, message: string): void {
  if (persistent === null) return;
  try {
    const now = persistent.now();
    const day = now.toISOString().slice(0, 10);
    if (day !== persistent.lastPrunedDay) {
      pruneExpiredFiles(persistent.dir, now, persistent.retentionDays);
      repairAppendBoundary(runnerLogFile(persistent.dir, now));
      persistent.lastPrunedDay = day;
    }
    const record: RunnerLogRecord = {
      schema: 1,
      ts: now.toISOString(),
      level,
      message,
      pid: process.pid,
    };
    appendFileSync(runnerLogFile(persistent.dir, now), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    // Logging must never take the runner down. Report once to the inherited
    // stderr (visible in a foreground run / system journal) and keep serving.
    if (!persistenceFailureReported) {
      persistenceFailureReported = true;
      console.error(`[pipeline-runner] error: durable logging disabled by write failure: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function emit(level: LogLevel, message: string): void {
  writePersistent(level, message);
  const rendered = `[pipeline-runner] ${level === 'warn' || level === 'error' ? `${level}: ` : ''}${message}`;
  if (level === 'debug') console.debug(rendered);
  else if (level === 'info') console.log(rendered);
  else if (level === 'warn') console.warn(rendered);
  else console.error(rendered);
}

/** Default logger: console for foreground/system-journal compatibility plus a
 * durable JSONL copy once `runStart()` configures it. */
export const consoleLogger: Logger = {
  debug: (message) => emit('debug', message),
  info: (message) => emit('info', message),
  warn: (message) => emit('warn', message),
  error: (message) => emit('error', message),
};

/** Silent logger (default for library use in tests). */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
