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
 *
 * ── The generalized spawn seam (department-mesh, task d1) ───────────────────
 * `JobExec.run()` above is BUFFERED: `stdio: ['ignore','pipe','pipe']` — no
 * stdin, and stdout/stderr only become visible once the process exits
 * (07-runtime-contract.md §1: "no stdin ⇒ no mid-task message ⇒ no multi-turn
 * while working"). That contract stays exactly as-is for `pipeline drive`
 * (untouched here; d4 later ports it onto the adapter abstraction unchanged).
 *
 * `JobSpawn`/`ProcessHandle` below is the SIBLING, STREAMING seam a
 * bidirectional protocol needs: stdin as a live pipe the caller can write to
 * at any time, and stdout delivered incrementally, one COMPLETE line at a
 * time, as it is produced — not buffered until close. This is the seam the
 * `jsonl-process` runtime adapter (`../department/jsonl-process.ts`) spawns
 * its child through; nothing about `JobExec` changes.
 *
 * ── Process-GROUP kill (department-mesh, task d2) ───────────────────────────
 * `nodeJobSpawn()`'s child is spawned `detached: true` — on POSIX that makes
 * it the LEADER of its own process group (its pgid equals its pid), which is
 * what makes `killProcessTree()`'s `process.kill(-pid, signal)` target the
 * whole tree instead of accidentally hitting an unrelated group (or this
 * daemon's own). `ProcessHandle.killGroup()` is the seam
 * `../department/jsonl-process.ts` escalates cancellation/disposal through
 * (07-runtime-contract.md §7) — closing the historical gap where cancel was a
 * plain SIGTERM to the direct child only, and grandchildren (e.g. a shelled-
 * out tool the department runtime itself spawned) survived. This is additive
 * to `ProcessHandle`; `JobExec`/`nodeJobExec` (the pipeline-dispatch seam
 * above) is completely untouched.
 */

import { spawn, spawnSync } from 'node:child_process';
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
  /** c6: abort → the child is killed (server `cancel` / graceful-shutdown
   *  drain). The result resolves through the normal path with a null code.
   *  An already-aborted signal skips the spawn entirely. */
  signal?: AbortSignal;
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
        // c6: cancel/shutdown abort — never spawn on an already-dead signal.
        if (opts.signal?.aborted) {
          settle({ code: null, stdout, stderr, error: 'aborted before spawn' });
          return;
        }
        try {
          const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: opts.env ? { ...process.env, ...opts.env } : process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          // c6: abort → kill the child (SIGTERM; TerminateProcess on Windows —
          // drive's per-step state is durable, so a killed child is exactly
          // the crash case the resume machinery already covers).
          const onAbort = (): void => {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          };
          opts.signal?.addEventListener('abort', onAbort, { once: true });
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
          });
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
          });
          child.on('error', (err) => {
            const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : null;
            opts.signal?.removeEventListener('abort', onAbort);
            settle({ code, stdout, stderr, error: err.message });
          });
          child.on('close', (code) => {
            opts.signal?.removeEventListener('abort', onAbort);
            settle({ code, stdout, stderr });
          });
        } catch (err) {
          settle({ code: null, stdout, stderr, error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}

// ── The streaming spawn seam (stdin pipe + incremental stdout lines) ────────

/** Options for a streaming spawn — the same shape as `JobExecOptions` minus
 *  `signal` (a streaming caller kills the handle directly instead). */
export interface ProcessSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * A live child process whose stdin is a WRITABLE PIPE and whose stdout is
 * delivered as complete, already-split lines — the seam a streaming,
 * bidirectional protocol needs. Unlike `JobExec.run()`, this returns
 * SYNCHRONOUSLY with a live handle; nothing here waits for exit.
 *
 * Single-subscriber by design (deliberately tiny, mirrors `JobFs`): each
 * `on*` setter stores exactly one callback, overwriting any previous one.
 * That is enough for one adapter instance owning one handle — the only
 * caller shape this seam exists for.
 */
export interface ProcessHandle {
  readonly pid: number | null;
  /** Write one line to stdin (a trailing '\n' is appended). Returns `false`
   *  without throwing when stdin is already closed/errored/ended. */
  writeLine(line: string): boolean;
  /** Half-close stdin (EOF) without killing the process. */
  endStdin(): void;
  /** Signal the process. Windows ignores the signal name and terminates
   *  unconditionally (Node's documented `child_process.kill()` behavior). */
  kill(signal?: NodeJS.Signals): void;
  /** Signal the ENTIRE process tree rooted at this process — not just the
   *  direct child (department-mesh, task d2; 07-runtime-contract.md §7). On
   *  POSIX this is a real process-GROUP signal (`process.kill(-pid, signal)`
   *  — requires the child to have been spawned `detached: true`, which
   *  `nodeJobSpawn()` does). Windows has no process-group signal concept and
   *  `child.kill()` already terminates unconditionally regardless of the
   *  signal name, so there the whole TREE is walked and force-terminated via
   *  `taskkill /T /F` for both 'SIGTERM' and 'SIGKILL' — see
   *  `killProcessTree()`. Best-effort: a group/tree that is already gone is
   *  silently ignored, never thrown. */
  killGroup(signal?: NodeJS.Signals): void;
  /** Fires once per complete stdout line (split on '\n'; a trailing '\r' is
   *  stripped). A final unterminated line is flushed on stdout end/close. */
  onStdoutLine(cb: (line: string) => void): void;
  /** Fires once per raw stderr chunk (not line-split — stderr is diagnostic
   *  text, not a framed protocol). */
  onStderr(cb: (chunk: string) => void): void;
  /** Fires exactly once, when the process has fully exited. */
  onExit(cb: (info: { code: number | null; signal: NodeJS.Signals | null; error?: string }) => void): void;
}

export interface JobSpawn {
  spawn(cmd: string, args: string[], opts?: ProcessSpawnOptions): ProcessHandle;
}

/** Incremental line splitter: feed raw chunks, get complete lines out;
 *  `flush()` emits a final unterminated trailing line, once, at stream end. */
function makeLineBuffer(onLine: (line: string) => void): { feed(chunk: Buffer | string): void; flush(): void } {
  let buf = '';
  return {
    feed(chunk) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, idx);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    },
    flush() {
      if (buf.length > 0) {
        const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
        buf = '';
        if (line.length > 0) onLine(line);
      }
    },
  };
}

/**
 * Best-effort kill of the WHOLE process tree rooted at `pid` (department-mesh,
 * task d2 — 07-runtime-contract.md §7's process-GROUP kill). `pid` must be a
 * process spawned `detached: true` (`nodeJobSpawn()` does this) for the POSIX
 * branch to target the right group rather than this daemon's own.
 *
 *   - POSIX: `process.kill(-pid, signal)` — negative pid addresses the whole
 *     process GROUP. ESRCH (already gone) is swallowed, never thrown.
 *   - Windows: no process-group signal exists, and a plain `child.kill()`
 *     there already terminates unconditionally regardless of signal name
 *     (documented Node behavior, `ProcessHandle.kill()`'s own doc) — so both
 *     'SIGTERM' and 'SIGKILL' map to the same unconditional `taskkill /pid
 *     <pid> /t /f`, which walks and force-terminates the recorded process
 *     tree. A missing/already-exited pid (taskkill exits non-zero) is
 *     swallowed the same way.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* taskkill unavailable or the process is already gone — best-effort */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* ESRCH — the group is already gone; the goal state is already reached */
  }
}

/** The real streaming spawner (`stdio: ['pipe','pipe','pipe']`, `windowsHide`,
 *  `detached: true` — the latter for `killGroup()`'s POSIX process-group
 *  semantics, department-mesh task d2; harmless on Windows alongside
 *  `windowsHide`). */
export function nodeJobSpawn(): JobSpawn {
  return {
    spawn(cmd, args, opts = {}) {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: true,
      });

      let onLineCb: ((line: string) => void) | null = null;
      let onStderrCb: ((chunk: string) => void) | null = null;
      let onExitCb: ((info: { code: number | null; signal: NodeJS.Signals | null; error?: string }) => void) | null =
        null;
      let exited = false;

      const stdoutBuf = makeLineBuffer((line) => onLineCb?.(line));
      child.stdout.on('data', (chunk: Buffer) => stdoutBuf.feed(chunk));
      child.stdout.on('end', () => stdoutBuf.flush());

      child.stderr.on('data', (chunk: Buffer) => onStderrCb?.(chunk.toString('utf8')));

      const settleExit = (info: { code: number | null; signal: NodeJS.Signals | null; error?: string }): void => {
        if (exited) return;
        exited = true;
        stdoutBuf.flush();
        onExitCb?.(info);
      };
      child.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : null;
        settleExit({ code, signal: null, error: err.message });
      });
      child.on('close', (code, signal) => settleExit({ code, signal }));

      return {
        pid: child.pid ?? null,
        writeLine(line) {
          if (child.stdin.destroyed || child.stdin.writableEnded) return false;
          try {
            child.stdin.write(`${line}\n`);
            return true;
          } catch {
            return false;
          }
        },
        endStdin() {
          try {
            if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
          } catch {
            /* already gone */
          }
        },
        kill(signal) {
          try {
            child.kill(signal ?? 'SIGTERM');
          } catch {
            /* already gone */
          }
        },
        killGroup(signal) {
          if (child.pid != null) killProcessTree(child.pid, signal ?? 'SIGTERM');
        },
        onStdoutLine(cb) {
          onLineCb = cb;
        },
        onStderr(cb) {
          onStderrCb = cb;
        },
        onExit(cb) {
          onExitCb = cb;
        },
      };
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
