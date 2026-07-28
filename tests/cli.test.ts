/**
 * x11: `pipeline-runner <verb>` dispatch, exercised as a REAL subprocess —
 * this is exit-code behavior, and the whole point of the regression is that
 * a caller which merely inspects the child's exit code (the `pipeline` CLI's
 * `department serve`, shelling out to `bind`) must be able to tell "ran"
 * apart from "this build has never heard of that verb". A unit test against
 * an in-process function couldn't pin that — `cli.ts` runs its dispatch as
 * top-level module code and calls `process.exit` directly.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function run(args: string[], env: Record<string, string> = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * An ISOLATED `PIPELINE_RUNNER_HOME` per suite — every command below writes to
 * (or reads from) the runner's own config/data dirs, and a test that touched
 * the developer's real ones would be both flaky and rude.
 */
const HOME = mkdtempSync(join(tmpdir(), 'runner-cli-test-'));
const HOME_ENV = { PIPELINE_RUNNER_HOME: HOME };
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

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

/**
 * x11 follow-up: `pipeline-runner service <sub>` is a SECOND, nested
 * dispatcher with the identical unknown-verb shape as the top-level one
 * above — and it sits on the same false-success path that produced the
 * original bug report. The plugin's `runner-enrol.ts` shells out to
 * `pipeline-runner service install` as `department serve`'s supervisor
 * step and checks the exit code; an unrecognized `service` verb exiting 0
 * would let `serve` report the supervisor installed when it never ran.
 */
describe('cli dispatch — service subcommand', () => {
  test('an unknown service verb exits non-zero with the error on stderr, not stdout', () => {
    const { exitCode, stdout, stderr } = run(['service', 'totally-fake-verb']);
    expect(exitCode).not.toBe(0);
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain("unknown service command 'totally-fake-verb'");
  });

  test('service --help prints usage to stdout and exits 0', () => {
    const { exitCode, stdout, stderr } = run(['service', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('usage: pipeline-runner service <install|uninstall|status|start|stop|restart>');
    expect(stderr).toBe('');
  });

  test('service -h behaves the same as service --help', () => {
    const { exitCode, stdout } = run(['service', '-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('usage: pipeline-runner service <install|uninstall|status|start|stop|restart>');
  });

  test('service with no sub-verb also prints usage and exits 0', () => {
    const { exitCode, stdout } = run(['service']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('usage: pipeline-runner service <install|uninstall|status|start|stop|restart>');
  });

  test('x24: the usage line advertises the three new verbs', () => {
    const { stdout } = run(['service', '--help']);
    for (const verb of ['start', 'stop', 'restart']) expect(stdout).toContain(`\n  ${verb}`);
  });
});

/**
 * x14 — `bind` validates `--adapter` against this build's own engine registry.
 *
 * Before this, `bind` stored ANY string: `narrowRuntimeConfig` validates the
 * SHAPE of a runtime spec, never the existence of the adapter behind it. So a
 * caller guessing at an id got a stored binding, a success line, and exit 0 —
 * and the mistake surfaced only as a `capability` reject on the first offer
 * that ever arrived for that department. Verified against this exact build
 * before the change: `bind --adapter totally-not-an-adapter` exited 0 and wrote
 * the id to `departments.json`.
 *
 * These run as real subprocesses because the refusal is exit-code behaviour and
 * the plugin's `department serve` shells this verb out (`buildBindArgs`).
 */
describe('x14 — bind refuses an adapter this build has no module for', () => {
  test('an unknown --adapter exits 1, names it, and names what IS registered', () => {
    const { exitCode, stdout, stderr } = run(
      ['bind', '--department', 'd-unknown', '--command', 'echo', '--adapter', 'totally-not-an-adapter'],
      HOME_ENV,
    );
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain("unknown --adapter 'totally-not-an-adapter'");
    // The message has to carry the answer, not just the complaint.
    for (const id of ['claude-code', 'container', 'jsonl-process', 'pipeline-drive']) {
      expect(stderr).toContain(id);
    }
    // …and the engine names a user actually types, for the two where the
    // internal id and the `engine:` name differ.
    expect(stderr).toContain('engine: process');
    expect(stderr).toContain('engine: pipeline');
  });

  test('nothing is written for a refused bind — the refusal happens BEFORE the store', () => {
    // The regression this replaces: the same command used to exit 0 AND leave
    // `{"adapterId":"totally-not-an-adapter"}` in departments.json.
    expect(
      run(['bind', '--department', 'd-not-written', '--command', 'echo', '--adapter', 'nope'], HOME_ENV).exitCode,
    ).toBe(1);
    const { exitCode, stdout } = run(['bindings', '--json'], HOME_ENV);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).departments['d-not-written']).toBeUndefined();
  });

  test('an unknown adapterId inside --spec is refused by the SAME gate as the flag', () => {
    const { exitCode, stderr } = run(
      ['bind', '--department', 'd-spec', '--spec', '{"adapterId":"nope","command":"echo"}'],
      HOME_ENV,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown --adapter 'nope'");
  });

  test.each(['claude-code', 'container', 'jsonl-process', 'pipeline-drive'])(
    'every adapter the plugin can send (%s) is still accepted — existing callers unaffected',
    (adapter) => {
      // These four are exactly what `department-manifest.ts`'s ENGINES maps
      // `engine:` onto, i.e. everything `buildBindArgs` can ever put on this
      // command line. If this test fails, x14 broke a shipped caller.
      const { exitCode, stdout } = run(
        ['bind', '--department', `d-${adapter}`, '--command', 'echo', '--adapter', adapter],
        HOME_ENV,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain(`bound d-${adapter} -> ${adapter}`);
    },
  );

  test('the default adapter (no --adapter at all) still passes the gate', () => {
    const { exitCode, stdout } = run(['bind', '--department', 'd-default', '--command', 'echo'], HOME_ENV);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('-> jsonl-process');
  });

  test('the top-level usage names the registered adapters, so nobody has to guess', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('checked against this build');
    expect(stdout).toContain('jsonl-process (engine: process)');
  });
});

/**
 * x22 — `journal`, the machine-readable read surface.
 *
 * The `--json` shape itself is unit-tested in
 * `src/department/journal-read.test.ts`; what only a subprocess can pin is the
 * argv/exit-code contract a shelling caller depends on.
 */
describe('x22 — journal', () => {
  const DEPT = 'dept-cli-test';

  test('--department is required', () => {
    const { exitCode, stderr } = run(['journal'], HOME_ENV);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--department <id> is required');
  });

  test('--limit must be a positive integer', () => {
    const { exitCode, stderr } = run(['journal', '--department', DEPT, '--limit', 'lots'], HOME_ENV);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--limit must be a positive integer');
  });

  test('an absent journal is EXIT 0 with a machine-readable reason — never having served here is normal', () => {
    const { exitCode, stdout } = run(['journal', '--department', DEPT, '--json'], HOME_ENV);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({ schema: 1, department_id: DEPT, status: 'absent', home_source: 'env' });
    expect(out.executions).toEqual([]);
    expect(out.tasks).toEqual({});
  });

  test('a seeded index round-trips through the CLI with sender + engine intact', () => {
    const dir = join(HOME, 'data', 'department', 'by-department', DEPT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'executions.jsonl'),
      [
        JSON.stringify({
          schema: 1,
          ts: '2026-07-28T10:00:00.000Z',
          type: 'department.execution_started',
          department_id: DEPT,
          run_id: 'exec-1',
          task_id: 'task-1',
          context_id: 'ctx-1',
          engine: 'claude-code',
          sender: 'ada@example.com',
          journal_path: '/x/exec-1/events.jsonl',
        }),
        'a truncated line from a hard kill',
        '',
      ].join('\n'),
    );
    const { exitCode, stdout } = run(['journal', '--department', DEPT, '--json'], HOME_ENV);
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.status).toBe('ok');
    expect(out.counts).toMatchObject({ executions: 1, skipped: 1 });
    expect(out.tasks['task-1']).toMatchObject({ sender: 'ada@example.com', engine: 'claude-code' });
  });

  test('the default rendering is human text, not JSON', () => {
    const { exitCode, stdout } = run(['journal', '--department', DEPT], HOME_ENV);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`department: ${DEPT}`);
    expect(stdout).toContain('engine claude-code');
    expect(() => JSON.parse(stdout)).toThrow();
  });

  test('--home reads THAT home, and never consults the environment', () => {
    const other = mkdtempSync(join(tmpdir(), 'runner-cli-other-'));
    try {
      const { exitCode, stdout } = run(['journal', '--department', DEPT, '--json', '--home', other], HOME_ENV);
      expect(exitCode).toBe(0);
      const out = JSON.parse(stdout);
      expect(out.home_source).toBe('flag');
      expect(out.status).toBe('absent');
      expect(out.path).toContain(other);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('`journal` is a KNOWN verb — an older build must fail loudly rather than no-op (x11)', () => {
    const { stdout } = run(['--help']);
    expect(stdout).toContain('journal --department <id>');
  });
});
