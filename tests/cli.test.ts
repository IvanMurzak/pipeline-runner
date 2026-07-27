/**
 * x11: `pipeline-runner <verb>` dispatch, exercised as a REAL subprocess —
 * this is exit-code behavior, and the whole point of the regression is that
 * a caller which merely inspects the child's exit code (the `pipeline` CLI's
 * `department serve`, shelling out to `bind`) must be able to tell "ran"
 * apart from "this build has never heard of that verb". A unit test against
 * an in-process function couldn't pin that — `cli.ts` runs its dispatch as
 * top-level module code and calls `process.exit` directly.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('cli dispatch', () => {
  test('an unknown subcommand exits non-zero with the error on stderr, not stdout', () => {
    const { exitCode, stdout, stderr } = run(['totally-fake-subcommand']);
    expect(exitCode).not.toBe(0);
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain("unknown command 'totally-fake-subcommand'");
  });

  test('a near-miss typo of a real verb is ALSO an unknown subcommand, not a silent no-op', () => {
    const { exitCode, stderr } = run(['binds']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command 'binds'");
  });

  test('--help prints usage to stdout and exits 0 — asking for help is not an error', () => {
    const { exitCode, stdout, stderr } = run(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('usage: pipeline-runner <command>');
    expect(stderr).toBe('');
  });

  test('-h behaves the same as --help', () => {
    const { exitCode, stdout } = run(['-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('usage: pipeline-runner <command>');
  });

  test('no arguments at all also prints usage and exits 0', () => {
    const { exitCode, stdout } = run([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('usage: pipeline-runner <command>');
  });
});
