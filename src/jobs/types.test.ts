/**
 * `nodeJobSpawn()` — the generalized streaming spawn seam (department-mesh,
 * task d1): stdin as a live pipe, stdout delivered as complete, incrementally
 * parsed lines. `JobExec`/`nodeJobExec` (the pre-existing buffered seam
 * `pipeline drive` still uses) is untouched and not re-tested here.
 *
 * Uses REAL child processes (`bun -e`) — this is the one seam whose whole
 * point is real OS pipe behavior (partial chunks, CRLF, backpressure-free
 * writes), so a fake would test nothing.
 */

import { describe, expect, test } from 'bun:test';
import type { ProcessHandle } from './types';
import { nodeJobSpawn } from './types';

function waitForExit(proc: ProcessHandle): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }> {
  return new Promise((resolve) => proc.onExit((info) => resolve(info)));
}

describe('nodeJobSpawn — real subprocess streaming', () => {
  test('stdout is delivered as complete lines, including a partial write flushed across two chunks', async () => {
    const spawner = nodeJobSpawn();
    // Two separate writes forming ONE line together, then a normal line —
    // proves the line buffer holds a partial write until its newline.
    const script = "process.stdout.write('partial-'); process.stdout.write('line\\n'); process.stdout.write('second\\n');";
    const proc = spawner.spawn(process.execPath, ['-e', script]);
    const lines: string[] = [];
    proc.onStdoutLine((line) => lines.push(line));
    await waitForExit(proc);
    expect(lines).toEqual(['partial-line', 'second']);
  });

  test('a trailing CRLF line has its \\r stripped', async () => {
    const spawner = nodeJobSpawn();
    const proc = spawner.spawn(process.execPath, ['-e', "process.stdout.write('crlf-line\\r\\n');"]);
    const lines: string[] = [];
    proc.onStdoutLine((line) => lines.push(line));
    await waitForExit(proc);
    expect(lines).toEqual(['crlf-line']);
  });

  test('an unterminated final line (no trailing newline) is still flushed at exit', async () => {
    const spawner = nodeJobSpawn();
    const proc = spawner.spawn(process.execPath, ['-e', "process.stdout.write('no-newline-at-eof');"]);
    const lines: string[] = [];
    proc.onStdoutLine((line) => lines.push(line));
    await waitForExit(proc);
    expect(lines).toEqual(['no-newline-at-eof']);
  });

  test('writeLine delivers to the child’s stdin over a real pipe (echo round trip)', async () => {
    const spawner = nodeJobSpawn();
    // A tiny cat-like echo: read one line, write it back prefixed, then exit.
    const script =
      "const rl = require('node:readline').createInterface({input: process.stdin}); rl.on('line', (l) => { process.stdout.write('echo:' + l + '\\n'); process.exit(0); });";
    const proc = spawner.spawn(process.execPath, ['-e', script]);
    const lines: string[] = [];
    proc.onStdoutLine((line) => lines.push(line));
    const wrote = proc.writeLine('ping');
    expect(wrote).toBe(true);
    await waitForExit(proc);
    expect(lines).toEqual(['echo:ping']);
  });

  test('writeLine returns false after endStdin(), never throws', async () => {
    const spawner = nodeJobSpawn();
    const proc = spawner.spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 50);']);
    proc.endStdin();
    expect(proc.writeLine('too late')).toBe(false);
    await waitForExit(proc);
  });

  test('kill() terminates the process; onExit still fires', async () => {
    const spawner = nodeJobSpawn();
    const proc = spawner.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000);']);
    const exitPromise = waitForExit(proc);
    proc.kill();
    const info = await exitPromise;
    expect(info.code === null || info.code !== 0).toBe(true);
  });

  test('a missing binary resolves onExit with code 127 and an error, not a throw', async () => {
    const spawner = nodeJobSpawn();
    const proc = spawner.spawn('this-binary-does-not-exist-xyz', []);
    const info = await new Promise<{ code: number | null; error?: string }>((resolve) => proc.onExit((i) => resolve(i)));
    expect(info.code).toBe(127);
    expect(info.error).toBeTruthy();
  });

  test('stderr is delivered separately from stdout, unsplit', async () => {
    const spawner = nodeJobSpawn();
    const proc = spawner.spawn(process.execPath, ['-e', "process.stderr.write('oops\\n'); process.stdout.write('ok\\n');"]);
    const stdoutLines: string[] = [];
    const stderrChunks: string[] = [];
    proc.onStdoutLine((l) => stdoutLines.push(l));
    proc.onStderr((c) => stderrChunks.push(c));
    await waitForExit(proc);
    expect(stdoutLines).toEqual(['ok']);
    expect(stderrChunks.join('')).toContain('oops');
  });
});
