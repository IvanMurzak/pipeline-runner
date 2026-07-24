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

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { ProcessHandle } from './types';
import { nodeJobSpawn } from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

describe('nodeJobSpawn — killGroup() process-tree kill (department-mesh d2)', () => {
  test('killGroup() reaches a GRANDCHILD the spawned process itself spawned — not just the direct child', async () => {
    const spawner = nodeJobSpawn();
    const heartbeatPath = join(tmpdir(), `pipeline-runner-d2-heartbeat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

    // The grandchild: writes a fresh timestamp every 50ms and IGNORES
    // SIGTERM, so it can ONLY be reaped by SIGKILL (POSIX) or an
    // unconditional forceful terminate (Windows) — proving the kill reaches
    // it directly, not merely because its parent happened to exit.
    const grandchildScript =
      "process.on('SIGTERM',()=>{});" +
      "const fs=require('node:fs');" +
      'const p=process.env.HEARTBEAT_PATH;' +
      "const beat=()=>{try{fs.writeFileSync(p,String(Date.now()))}catch{}};" +
      'beat();setInterval(beat,50);';

    // The direct child: ALSO ignores SIGTERM, spawns the grandchild as an
    // ordinary (non-detached) child of itself — inheriting this process's
    // process group, exactly the tree `killGroup()` must reach — then idles.
    const parentScript =
      "process.on('SIGTERM',()=>{});" +
      "const {spawn}=require('node:child_process');" +
      `spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:'ignore',env:process.env,windowsHide:true});` +
      'setTimeout(()=>{},30000);';

    const proc = spawner.spawn(process.execPath, ['-e', parentScript], { env: { HEARTBEAT_PATH: heartbeatPath } });

    try {
      const readBeat = (): string | null => {
        try {
          return readFileSync(heartbeatPath, 'utf8');
        } catch {
          return null;
        }
      };

      // Wait for the grandchild's first heartbeat (proves it's alive).
      const spawnDeadline = Date.now() + 10_000;
      while (readBeat() === null && Date.now() < spawnDeadline) await sleep(25);
      expect(readBeat()).not.toBeNull();

      proc.killGroup('SIGTERM'); // ignored by both on POSIX; unconditional on Windows
      await sleep(300);
      proc.killGroup('SIGKILL'); // the only signal neither process can ignore

      // Give the (now-dead) grandchild a moment to prove it never beats again.
      await sleep(500);
      const afterKillA = readBeat();
      await sleep(400);
      const afterKillB = readBeat();
      expect(afterKillA).toBe(afterKillB); // no further heartbeats — it's dead
    } finally {
      rmSync(heartbeatPath, { force: true });
    }
  }, 15_000);
});
