/**
 * f4 integration — TWO TENANTS ON ONE POOLED MACHINE, over a real filesystem,
 * with a REAL child process standing in for the run.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The task's own words: *"a configuration change without this test is a claim;
 * the test is what makes it a guarantee."* A test that plants a memory file and
 * then asserts an environment variable was set proves nothing about isolation —
 * it asserts the configuration it just wrote. So nothing here asserts on the
 * overlay. Every claim below is made about **what a real process could actually
 * observe**: a child is spawned through the runner's real spawn seam, with the
 * environment the executor really built, and it resolves `~` with `os.homedir()`
 * and reads. What it could see is the finding; what it could not see is the
 * guarantee.
 *
 * ── The machine ────────────────────────────────────────────────────────────
 *
 * ONE workspace root, ONE ambient `$HOME`, several tenants — which is what
 * "pooled" means. The machine's home is PLANTED with tenant A's accumulated
 * state before anything runs:
 *
 *   ~/.claude.json                                    ← the global config
 *   ~/.claude/projects/<project>/memory/MEMORY.md     ← auto memory
 *   ~/.claude/CLAUDE.md                               ← user-scope memory
 *
 * All three are read REGARDLESS of `settingSources`, which is precisely why f1
 * could not close them and f4 must.
 *
 * ── The control is not optional ────────────────────────────────────────────
 *
 * A negative assertion is worthless until you have shown the instrument can
 * detect the thing. The first test therefore runs the SAME harness with hosted
 * isolation OFF and asserts the planted markers ARE read. Only then do the
 * negative assertions mean "isolation worked" rather than "the probe was
 * looking in the wrong place".
 *
 * ── Both directions ────────────────────────────────────────────────────────
 *
 *   forward   tenant A's memory and global config never reach tenant B's run
 *   reverse   tenant B's run leaves nothing a later tenant-A run could read —
 *             not in the machine's home, and not in a home of its own that
 *             outlives it
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentHomeFor,
  agentHomesRootFor,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CONFIG_DIR_NAME,
  DISABLE_AUTO_MEMORY_ENV,
  DISABLE_AUTO_MEMORY_VALUE,
  defaultResolveStartIteration,
  HOME_ENV,
  JobExecutor,
  nodeJobExec,
  nodeJobFs,
  USERPROFILE_ENV,
  type JobExec,
  type JobExecOptions,
  type JobExecResult,
  type JobResult,
} from '../src/jobs';
// f1's credential holder is not re-exported from `jobs/index.ts` (the hosted
// surface is constructed, not browsed) — import it from its own module.
import { HostedProviderCredential } from '../src/jobs/standalone';
import { FrameSink, makeLease, type RanJobCommand } from '../src/jobs/_helpers';
import { CaptureLogger, FakeClock } from './_helpers';

const GIT_OK: JobExecResult = { code: 0, stdout: '', stderr: '' };
const DRIVE_COMPLETED: JobExecResult = { code: 0, stdout: JSON.stringify({ status: 'completed' }), stderr: '' };

/** SYNTHETIC. Never a real credential — not in a fixture, not in a snapshot,
 *  not in a commit message (this task's standing rule). */
const ORG_KEY = 'sk-ant-ORG-synthetic-0000000000';

/** Distinctive, obviously synthetic markers. Every negative assertion below is
 *  a search for one of these in something a run could read. */
const A_MACHINE_MEMORY = 'TENANT-A-AUTO-MEMORY-4d1f0c';
const A_MACHINE_USER_MEMORY = 'TENANT-A-USER-MEMORY-4d1f0c';
const A_MACHINE_CONFIG = 'TENANT-A-GLOBAL-CONFIG-4d1f0c';
const A_RUN_MARKER = 'TENANT-A-RUN-STATE-9b72ae';
const B_RUN_MARKER = 'TENANT-B-RUN-STATE-e30d55';

/**
 * The observation instrument, written to disk and spawned as a REAL process by
 * the exec seam below.
 *
 * It does two things, in this order:
 *
 *   1. reports everything reachable from `~` — the global config at both places
 *      it can live, and a bounded recursive dump of every file under the home,
 *      so a leak through a path this test never thought of still shows up;
 *   2. writes ITS OWN tenant's marker into `~/.claude.json` and into auto
 *      memory, exactly as an accumulating run would. That is what makes the
 *      reverse direction testable at all.
 */
const PROBE_SOURCE = [
  "import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';",
  "import { homedir } from 'node:os';",
  "import { join } from 'node:path';",
  '',
  'const reportPath = process.argv[2];',
  'const marker = process.argv[3];',
  'const home = homedir();',
  "const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');",
  '',
  "const readOrNull = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };",
  '',
  '// Bounded: a misconfiguration that left HOME pointing at a real user home',
  '// must not turn this into a filesystem crawl.',
  'const MAX_FILES = 500;',
  'function walk(dir, out, depth) {',
  '  if (out.length >= MAX_FILES || depth > 8) return out;',
  '  let entries = [];',
  '  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }',
  '  for (const entry of entries) {',
  '    if (out.length >= MAX_FILES) break;',
  '    const path = join(dir, entry.name);',
  '    if (entry.isDirectory()) { walk(path, out, depth + 1); continue; }',
  "    out.push({ path, text: readOrNull(path) ?? '<<UNREADABLE>>' });",
  '  }',
  '  return out;',
  '}',
  '',
  'writeFileSync(reportPath, JSON.stringify({',
  '  home,',
  '  configDir,',
  "  homeEnv: process.env.HOME ?? '<<ABSENT>>',",
  "  userProfileEnv: process.env.USERPROFILE ?? '<<ABSENT>>',",
  "  autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '<<ABSENT>>',",
  "  globalConfig: readOrNull(join(home, '.claude.json')),",
  "  configDirGlobalConfig: readOrNull(join(configDir, '.claude.json')),",
  '  visible: walk(home, [], 0),',
  '}));',
  '',
  '// …and now accumulate, the way a real run does.',
  "writeFileSync(join(home, '.claude.json'), JSON.stringify({ marker }));",
  "const memoryDir = join(configDir, 'projects', 'the-project', 'memory');",
  'mkdirSync(memoryDir, { recursive: true });',
  "writeFileSync(join(memoryDir, 'MEMORY.md'), '# memory ' + marker);",
].join('\n');

interface ProbeReport {
  home: string;
  configDir: string;
  homeEnv: string;
  userProfileEnv: string;
  autoMemory: string;
  globalConfig: string | null;
  configDirGlobalConfig: string | null;
  visible: Array<{ path: string; text: string }>;
}

/**
 * A `pipeline drive` that is a REAL child process. `git` is scripted (a fresh
 * checkout of the same pipeline); everything else spawns the probe through the
 * runner's own `nodeJobExec`, with the environment the executor built — which
 * is the only reason any of this proves anything.
 */
class ProbingPipelineExec implements JobExec {
  calls: RanJobCommand[] = [];
  reports: ProbeReport[] = [];

  constructor(
    private readonly probePath: string,
    private readonly reportDir: string,
    private readonly marker: string
  ) {}

  of(cmd: string): RanJobCommand[] {
    return this.calls.filter((call) => call.cmd === cmd);
  }

  async run(cmd: string, args: string[], opts: JobExecOptions = {}): Promise<JobExecResult> {
    this.calls.push({ cmd, args, opts });
    if (cmd === 'git') {
      if (args.includes('checkout')) {
        const dir = args[1]!;
        mkdirSync(join(dir, '.pipeline', 'release', 'steps'), { recursive: true });
        writeFileSync(join(dir, '.pipeline', 'release', 'steps', '01-plan.md'), '# plan\n');
      }
      return GIT_OK;
    }
    const reportPath = join(this.reportDir, `${this.marker}-${this.reports.length}.json`);
    const spawned = await nodeJobExec().run(process.execPath, [this.probePath, reportPath, this.marker], {
      cwd: opts.cwd,
      env: opts.env,
    });
    if (spawned.code !== 0) {
      throw new Error(`probe exited ${spawned.code ?? 'null'}: ${spawned.stderr || spawned.error || ''}`);
    }
    this.reports.push(JSON.parse(readFileSync(reportPath, 'utf8')) as ProbeReport);
    return DRIVE_COMPLETED;
  }
}

// ── the machine ─────────────────────────────────────────────────────────────

interface Machine {
  base: string;
  /** The pooled machine's OWN home — one directory, every tenant. */
  home: string;
  /** The pooled machine's OWN job workspace root — likewise shared. */
  workspaceRoot: string;
  probePath: string;
  reportDir: string;
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file-lock stragglers — temp dir, best-effort */
    }
  }
});

/** Boot a pooled machine whose home ALREADY carries tenant A's accumulated
 *  state — the reused-machine premise, planted rather than assumed. */
function makeMachine(): Machine {
  const base = mkdtempSync(join(tmpdir(), 'f4-pooling-'));
  cleanups.push(base);
  const machine: Machine = {
    base,
    home: join(base, 'machine-home'),
    workspaceRoot: join(base, 'jobs'),
    probePath: join(base, 'probe.mjs'),
    reportDir: join(base, 'reports'),
  };
  mkdirSync(machine.reportDir, { recursive: true });
  writeFileSync(machine.probePath, PROBE_SOURCE);
  plantTenantA(machine.home);
  return machine;
}

/** The three inputs read REGARDLESS of `settingSources`, as tenant A left them. */
function plantTenantA(home: string): void {
  const claude = join(home, CLAUDE_CONFIG_DIR_NAME);
  mkdirSync(join(claude, 'projects', 'acme-secret-project', 'memory'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ marker: A_MACHINE_CONFIG }));
  writeFileSync(join(claude, 'projects', 'acme-secret-project', 'memory', 'MEMORY.md'), `# ${A_MACHINE_MEMORY}\n`);
  writeFileSync(join(claude, 'CLAUDE.md'), `# ${A_MACHINE_USER_MEMORY}\n`);
}

interface TenantRun {
  jobId: string;
  runId: string;
  marker: string;
  /** false ⇒ the CONTROL: the same harness with hosted isolation off. */
  hosted?: boolean;
}

interface TenantOutcome {
  result: JobResult;
  exec: ProbingPipelineExec;
  report: ProbeReport;
  logger: CaptureLogger;
}

async function runTenant(machine: Machine, tenant: TenantRun): Promise<TenantOutcome> {
  const exec = new ProbingPipelineExec(machine.probePath, machine.reportDir, tenant.marker);
  const logger = new CaptureLogger();
  const executor = new JobExecutor({
    lease: makeLease({ job_id: tenant.jobId, run_id: tenant.runId }),
    runnerId: 'r-1',
    send: new FrameSink().send,
    workspaceRoot: machine.workspaceRoot,
    exec,
    fs: nodeJobFs(),
    clock: new FakeClock(),
    logger,
    resolveStartIteration: defaultResolveStartIteration,
    // THE POOLED MACHINE'S OWN ENVIRONMENT: one home, shared by every tenant
    // that lands here. This is the thing f4 has to beat.
    env: { [HOME_ENV]: machine.home, [USERPROFILE_ENV]: machine.home },
    ...(tenant.hosted === false
      ? {}
      : { hostedStandalone: { credential: () => new HostedProviderCredential('deliver', ORG_KEY) } }),
  });
  const result = await executor.start();
  const report = exec.reports[0];
  if (report === undefined) throw new Error(`tenant ${tenant.marker} never ran a drive child`);
  return { result, exec, report, logger };
}

/** Every byte the run could read, as one searchable string. */
function everythingVisible(report: ProbeReport): string {
  return JSON.stringify([report.globalConfig, report.configDirGlobalConfig, report.visible]);
}

/** Every byte on disk under `dir`, as one searchable string. */
function everythingUnder(dir: string): string {
  const out: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 8) return;
    // Structurally typed: `Dirent`'s name generic differs across @types/node
    // revisions, and this walker only ever needs the two members below.
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      out.push(path);
      if (entry.isDirectory()) walk(path, depth + 1);
      else {
        try {
          out.push(readFileSync(path, 'utf8'));
        } catch {
          /* unreadable — the path is already recorded */
        }
      }
    }
  };
  walk(dir, 0);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// THE CONTROL — the instrument can detect the leak
// ---------------------------------------------------------------------------

describe('f4 CONTROL — without the isolated home, tenant A’s state IS read', () => {
  test('a run on the pooled machine reads A’s memory, A’s user memory and A’s global config', async () => {
    const machine = makeMachine();
    // The same harness, the same plants, the same probe — hosted isolation off.
    const b = await runTenant(machine, { jobId: 'job-b', runId: 'run-b', marker: B_RUN_MARKER, hosted: false });

    expect(b.result.ok).toBe(true);
    expect(b.report.home).toBe(machine.home);

    const seen = everythingVisible(b.report);
    expect(seen).toContain(A_MACHINE_MEMORY);
    expect(seen).toContain(A_MACHINE_USER_MEMORY);
    expect(seen).toContain(A_MACHINE_CONFIG);
    expect(b.report.globalConfig).toContain(A_MACHINE_CONFIG);
    // And auto memory is not disabled — the lever f4 sets is simply absent.
    expect(b.report.autoMemory).toBe('<<ABSENT>>');

    // The reverse leak, also real without f4: B wrote its own state straight
    // into the shared machine home, where the next tenant will read it.
    expect(everythingUnder(machine.home)).toContain(B_RUN_MARKER);
  });
});

// ---------------------------------------------------------------------------
// FORWARD — nothing of tenant A reaches tenant B
// ---------------------------------------------------------------------------

describe('f4 FORWARD — no memory and no global config crosses into the next tenant', () => {
  test('tenant B, hosted, on the same machine: A’s planted state is unreachable', async () => {
    const machine = makeMachine();
    const b = await runTenant(machine, { jobId: 'job-b', runId: 'run-b', marker: B_RUN_MARKER });

    expect(b.result.ok).toBe(true);

    // Where the run actually looked: its OWN home, not the machine's.
    expect(b.report.home).not.toBe(machine.home);
    expect(b.report.home).toBe(agentHomeFor(agentHomesRootFor(machine.workspaceRoot), 'run-b'));
    expect(b.report.configDir).toBe(join(b.report.home, CLAUDE_CONFIG_DIR_NAME));

    // What it could read. Not "the variable was set" — every byte reachable
    // from `~`, searched for each of A's markers.
    const seen = everythingVisible(b.report);
    expect(seen).not.toContain(A_MACHINE_MEMORY);
    expect(seen).not.toContain(A_MACHINE_USER_MEMORY);
    expect(seen).not.toContain(A_MACHINE_CONFIG);
    expect(b.report.globalConfig).toBeNull();
    expect(b.report.configDirGlobalConfig).toBeNull();

    // Belt and braces: auto memory is off in the child that actually ran.
    expect(b.report.autoMemory).toBe(DISABLE_AUTO_MEMORY_VALUE);
  });

  test('tenant A ran here first: B cannot read what A’s RUN wrote either', async () => {
    const machine = makeMachine();
    const a = await runTenant(machine, { jobId: 'job-a', runId: 'run-a', marker: A_RUN_MARKER });
    // A really did accumulate state — otherwise the next assertion is vacuous.
    expect(a.result.ok).toBe(true);

    const b = await runTenant(machine, { jobId: 'job-b', runId: 'run-b', marker: B_RUN_MARKER });
    expect(b.report.home).not.toBe(a.report.home);
    expect(everythingVisible(b.report)).not.toContain(A_RUN_MARKER);
  });
});

// ---------------------------------------------------------------------------
// REVERSE — tenant B leaves nothing a later tenant-A run could read
// ---------------------------------------------------------------------------

describe('f4 REVERSE — a finished run leaves nothing behind for the next tenant', () => {
  test('B writes nothing into the pooled machine’s home', async () => {
    const machine = makeMachine();
    await runTenant(machine, { jobId: 'job-b', runId: 'run-b', marker: B_RUN_MARKER });

    // The shared home is exactly as A left it: B's marker never landed there,
    // and B did not disturb A's files either.
    const machineState = everythingUnder(machine.home);
    expect(machineState).not.toContain(B_RUN_MARKER);
    expect(machineState).toContain(A_MACHINE_MEMORY);
    expect(readFileSync(join(machine.home, '.claude.json'), 'utf8')).toContain(A_MACHINE_CONFIG);
  });

  test('B’s own home is GONE when the job ends — nothing outlives the run', async () => {
    const machine = makeMachine();
    const b = await runTenant(machine, { jobId: 'job-b', runId: 'run-b', marker: B_RUN_MARKER });

    expect(existsSync(b.report.home)).toBe(false);
    // Nothing of B survives anywhere under the machine's job tree.
    expect(everythingUnder(machine.workspaceRoot)).not.toContain(B_RUN_MARKER);
  });

  test('a LATER tenant-A run on the same machine reads neither B’s state nor its own past', async () => {
    const machine = makeMachine();
    await runTenant(machine, { jobId: 'job-a1', runId: 'run-a1', marker: A_RUN_MARKER });
    await runTenant(machine, { jobId: 'job-b', runId: 'run-b', marker: B_RUN_MARKER });

    // The machine has now hosted both tenants. A comes back for a new run.
    const a2 = await runTenant(machine, { jobId: 'job-a2', runId: 'run-a2', marker: A_RUN_MARKER });
    const seen = everythingVisible(a2.report);
    expect(seen).not.toContain(B_RUN_MARKER);
    expect(seen).not.toContain(A_RUN_MARKER); // not even A's own previous run
    expect(seen).not.toContain(A_MACHINE_MEMORY);
    expect(a2.report.globalConfig).toBeNull();
  });

  test('three tenants, three homes — no two runs ever resolve to one directory', async () => {
    const machine = makeMachine();
    const a = await runTenant(machine, { jobId: 'job-a', runId: 'run-a', marker: A_RUN_MARKER });
    const b = await runTenant(machine, { jobId: 'job-b', runId: 'run-b', marker: B_RUN_MARKER });
    const c = await runTenant(machine, { jobId: 'job-c', runId: 'run-c', marker: 'TENANT-C-RUN-STATE-11aa22' });

    const homes = [a.report.home, b.report.home, c.report.home];
    expect(new Set(homes).size).toBe(3);
    for (const home of homes) expect(home).not.toBe(machine.home);
  });
});

// ---------------------------------------------------------------------------
// THE OVERLAY REACHES A REAL PROCESS
// ---------------------------------------------------------------------------

describe('f4 — the levers are observed by the child, not merely written by us', () => {
  test('os.homedir(), CLAUDE_CONFIG_DIR and the auto-memory switch all follow', async () => {
    const machine = makeMachine();
    const b = await runTenant(machine, { jobId: 'job-b', runId: 'run-b', marker: B_RUN_MARKER });

    // `homedir()` is the function the SDK's own `~` resolution goes through, so
    // this — not the env var — is the assertion that matters on each platform.
    expect(b.report.home).toBe(b.report.homeEnv);
    expect(b.report.home).toBe(b.report.userProfileEnv);
    expect(b.report.autoMemory).toBe(DISABLE_AUTO_MEMORY_VALUE);

    // And the runner said so, without leaking the org key while doing it.
    expect(b.logger.joined()).toContain('isolated home');
    expect(b.logger.joined()).toContain('auto memory off');
    expect(b.logger.joined()).not.toContain(ORG_KEY);

    const env = b.exec.of('pipeline')[0]!.opts.env!;
    expect(env[CLAUDE_CONFIG_DIR_ENV]).toBe(join(b.report.home, CLAUDE_CONFIG_DIR_NAME));
    expect(env[DISABLE_AUTO_MEMORY_ENV]).toBe(DISABLE_AUTO_MEMORY_VALUE);
  });
});
