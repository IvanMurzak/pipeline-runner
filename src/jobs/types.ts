/**
 * Shared types + injectable seams for job execution (T2-03).
 *
 * Same philosophy as `../service/types.ts`: every system-touching action —
 * spawning `git` / `pipeline`, workspace directory management — sits behind an
 * injectable seam (`JobExec` for subprocesses, `JobFs` for the filesystem) so
 * tests drive the whole executor with fakes and NEVER clone a real repo, spawn
 * a real `pipeline`, or touch the network.
 *
 * Unlike the service module's synchronous exec (rare one-shot actions), the
 * job exec seam is ASYNC — a `pipeline drive` run can take hours and must not
 * block the agent's event loop (heartbeats keep the lease alive meanwhile).
 *
 * Import-inert: importing this module (and constructing the real seams) starts
 * no timers, spawns no processes, opens no sockets.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

/** Actionable, non-crashing failure surfaced by any job-execution step. */
export class JobError extends Error {}

/** Result of running one external command through the exec seam. */
export interface JobExecResult {
  /** Process exit code; null when the process died without one (killed /
   *  spawn failure — see `error`). 127 when the binary is missing. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn-level error detail (binary missing, EPERM, ...), when any. */
  error?: string;
}

export interface JobExecOptions {
  /** Working directory for the child (the job's isolated workspace). */
  cwd?: string;
  /** EXTRA environment entries merged over the parent env. */
  env?: Record<string, string | undefined>;
}

/**
 * Injectable async process-spawn seam. One method, promise-shaped: resolve
 * with the exit result, never reject — failures are data (`code`/`error`).
 */
export interface JobExec {
  run(cmd: string, args: string[], opts?: JobExecOptions): Promise<JobExecResult>;
}

/**
 * Injectable filesystem seam for workspace management. Deliberately tiny:
 * directory lifecycle + a listing (start-iteration discovery). No file writes
 * — job execution only ever writes through the spawned subprocesses.
 */
export interface JobFs {
  mkdirp(path: string): void;
  exists(path: string): boolean;
  /** Recursive, idempotent: removing a missing directory is a no-op. */
  removeDir(path: string): void;
  /** Entry NAMES of a directory; [] when it does not exist. */
  listDir(path: string): string[];
}

/** The real process spawner. Spawn errors are mapped to a non-zero result. */
export function nodeJobExec(): JobExec {
  return {
    run(cmd, args, opts = {}) {
      return new Promise((resolve) => {
        let settled = false;
        const settle = (result: JobExecResult): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        let stdout = '';
        let stderr = '';
        try {
          const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: opts.env ? { ...process.env, ...opts.env } : process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
          });
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
          });
          child.on('error', (err) => {
            const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : null;
            settle({ code, stdout, stderr, error: err.message });
          });
          child.on('close', (code) => {
            settle({ code, stdout, stderr });
          });
        } catch (err) {
          settle({ code: null, stdout, stderr, error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}

/** The real filesystem (node:fs sync API — workspace I/O is rare and tiny). */
export function nodeJobFs(): JobFs {
  return {
    mkdirp: (path) => {
      fs.mkdirSync(path, { recursive: true });
    },
    exists: (path) => fs.existsSync(path),
    removeDir: (path) => {
      fs.rmSync(path, { recursive: true, force: true });
    },
    listDir: (path) => {
      try {
        return fs.readdirSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
  };
}
