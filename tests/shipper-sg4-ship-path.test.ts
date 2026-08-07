/**
 * SG4 through the RUNNER'S OWN SHIP PATH (ux-v2 `b23`; `07-security.md` gate
 * SG4: "Request bodies **and outbox files** contain no prohibited field, on a
 * real run").
 *
 * `tests/shipper-privacy.test.ts` proves the RULE against `filterEventForTier`.
 * This file proves the runner actually applies it, by driving the real
 * `EventShipper` over a real journal and reading back BOTH surfaces SG4 names:
 *
 *   - every byte the shipper wrote to its state dir (the spool chunks — the
 *     runner's "outbox files", where an offline machine keeps telemetry at
 *     rest, and the cursor beside them), and
 *   - every batch that reached the upload transport (the request body).
 *
 * ux-v2 `b22` could not do this: it fixed the CLI's two seams and could only
 * INFER runner-side exposure by reading the shipper's code, because the shipper
 * lives in this repository and `b22` did not touch it. Its task specification
 * asked `b23` to measure it instead of inferring it, so this file measures it.
 *
 * The journal envelopes are the shapes ux-v2 `i1` read back out of the
 * production `events` table on 2026-08-07 — an `iteration.started` whose
 * `iteration_path` came from the plan (absolute) and the `iteration.completed`
 * eight seconds later carrying the same absolute value plus an absolute
 * `next_iteration_path`. Verbatim account name and layout, because a
 * paraphrased fixture would not be evidence.
 */

import { describe, expect, test } from 'bun:test';
import { userInfo } from 'node:os';
import { EventShipper } from '../src/shipper/shipper';
import { SG4_PATH_RE } from '../src/shipper/privacy';
import type { StatsSource } from '../src/shipper/stats';
import { CaptureLogger, FakeClock } from './_helpers';
import { FakeUploadTransport, MemShipperFs, settle, validRunRecord } from './_shipper-helpers';

// ── The production shapes ────────────────────────────────────────────────────

const PROD_ACCOUNT = 'IvanD';
const PROJECT_ROOT = `C:\\Users\\${PROD_ACCOUNT}\\AppData\\Local\\Temp\\claude\\proj-i1-e2e`;
const STEPS = `${PROJECT_ROOT}\\.pipeline\\i1-e2e-probe\\steps`;
const OFF_ROOT = `C:\\Users\\${PROD_ACCOUNT}\\Documents\\another-client\\hand-off.md`;
const RUN_ID = '019fdbdf-822f-7006-8fae-200bec3ae07c';

const JOURNAL = 'C:/proj/.pipeline/.runtime/events.jsonl';
const STATE = 'C:/state/agent/shipper/j1';

function envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: 5,
    ts: '2026-08-07T10:58:39.207Z',
    type,
    project_root: PROJECT_ROOT,
    worktree: null,
    run_id: RUN_ID,
    parent_run_id: null,
    session_id: null,
    data,
  };
}

function productionJournal(): string {
  return (
    [
      envelope('run.started', {
        pipeline_name: 'i1-e2e-probe',
        pipeline_root: `${PROJECT_ROOT}\\.pipeline\\i1-e2e-probe`,
        first_iteration_path: `${STEPS}\\01-prepare.md`,
      }),
      envelope('iteration.started', {
        index: 1,
        step_name: '01-prepare',
        iteration_path: `${STEPS}\\01-prepare.md`,
      }),
      envelope('iteration.completed', {
        outcome: 'completed',
        terminal: false,
        iteration_path: `${STEPS}\\01-prepare.md`,
        next_iteration_path: `${STEPS}\\02-finish.md`,
      }),
      // A path under NO known root — must fail closed, not relativize.
      envelope('improver.completed', { iteration_path: OFF_ROOT, applied: false }),
      // A FAIL summary quoting a path inside free text: no field-name rule
      // could see this one.
      envelope('pipeline.halted', {
        pipeline_name: 'i1-e2e-probe',
        iteration_path: `${STEPS}\\02-finish.md`,
        halt_reason: `cannot open ${STEPS}\\02-finish.md (ENOENT)`,
      }),
      // A clean control, so a "fix" that dropped every data field would fail.
      envelope('tool.called', {
        success: true,
        tool_name: 'Read',
        agent_spawn: false,
        tool_use_id: 'toolu_015HYTu95fgxM8L2yTjCAiWV',
      }),
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join('')
  );
}

// ── The SG4 check, as `check-sg4.mjs` performs it ────────────────────────────

function stringLeaves(node: unknown, at = 'payload'): Array<[string, string]> {
  if (typeof node === 'string') return [[at, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${at}.${k}`));
  }
  return [];
}

function sg4Findings(payload: unknown, label: string): string[] {
  return stringLeaves(payload)
    .filter(([, v]) => SG4_PATH_RE.test(v))
    .map(([at, v]) => `${label}: raw absolute path at ${at} -> ${JSON.stringify(v.slice(0, 140))}`);
}

/** Every file the shipper wrote under its STATE dir — the spool chunks (the
 *  runner's outbox files) and the cursor — read back as the raw text on disk,
 *  NOT as parsed objects. */
function stateFiles(fs: MemShipperFs): Array<{ name: string; text: string }> {
  return [...fs.files.entries()]
    .filter(([name]) => name.startsWith(STATE.replace(/\\/g, '/')))
    .map(([name, bytes]) => ({ name, text: new TextDecoder().decode(bytes) }));
}

interface Rig {
  fs: MemShipperFs;
  transport: FakeUploadTransport;
  shipper: EventShipper;
}

function makeRig(overrides: Partial<ConstructorParameters<typeof EventShipper>[0]> = {}): Rig {
  const fs = new MemShipperFs();
  const transport = new FakeUploadTransport();
  const shipper = new EventShipper({
    journalPath: JOURNAL,
    stateDir: STATE,
    transport,
    fs,
    clock: new FakeClock(),
    logger: new CaptureLogger(),
    env: {}, // never the real process env
    projectRoot: PROJECT_ROOT,
    fingerprintSalt: 'ship-path-salt',
    ...overrides,
  });
  return { fs, transport, shipper };
}

// ── The measurement ──────────────────────────────────────────────────────────

describe('EventShipper — SG4 on the real ship path', () => {
  test('neither the spool files nor the upload bodies carry an absolute path or the account name', async () => {
    const { fs, transport, shipper } = makeRig();
    fs.appendText(JOURNAL, productionJournal());

    // OFFLINE FIRST. A confirmed chunk is deleted from the spool the moment it
    // uploads, so an online run leaves nothing at rest to inspect — and the
    // offline buffer IS the normal path here (spool-first). This is the state
    // T20 describes: telemetry sitting on the user's disk.
    transport.mode = 'offline';
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    const spooled = stateFiles(fs).filter((f) => f.name.includes('/spool/'));
    expect(spooled.length).toBeGreaterThan(0); // the check must not be vacuous
    const diskFindings = spooled.flatMap((f) =>
      sg4Findings(JSON.parse(f.text) as unknown, `disk:${f.name}`)
    );
    console.log(
      `\n[b23 ship path — spool files AT REST] files checked: ${spooled.length}\n` +
        (diskFindings.length === 0
          ? 'SG4: PASS — no prohibited field found'
          : `SG4: ${diskFindings.length} problem(s)\n  - ${diskFindings.join('\n  - ')}`) +
        '\n'
    );
    expect(diskFindings).toEqual([]);
    for (const f of stateFiles(fs)) {
      expect(`${f.name}: ${f.text.includes(PROD_ACCOUNT)}`).toBe(`${f.name}: false`);
    }

    // …then let it drain and read the REQUEST BODIES.
    transport.mode = 'ok';
    await shipper.drain();
    await settle();

    const uploaded = transport.confirmed.flatMap((b) => b.events);
    expect(uploaded).toHaveLength(6);
    const wireFindings = uploaded.flatMap((e) => sg4Findings(e.payload, `wire#${e.seq}`));
    console.log(
      `\n[b23 ship path — upload bodies] payloads checked: ${uploaded.length}\n` +
        (wireFindings.length === 0
          ? 'SG4: PASS — no prohibited field found'
          : `SG4: ${wireFindings.length} problem(s)\n  - ${wireFindings.join('\n  - ')}`) +
        '\n'
    );
    expect(wireFindings).toEqual([]);
    for (const batch of transport.confirmed) {
      const body = JSON.stringify(batch);
      expect(body.includes(PROD_ACCOUNT)).toBe(false);
      expect(body.toLowerCase().includes('c:\\\\users')).toBe(false);
    }
  });

  test('the labels SURVIVE the ship path — relativized, fingerprinted where rootless, never dropped', async () => {
    const { fs, transport, shipper } = makeRig();
    fs.appendText(JOURNAL, productionJournal());
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    const data = (seq: number): Record<string, unknown> =>
      (
        transport.confirmed.flatMap((b) => b.events).find((e) => e.seq === seq)!.payload as {
          data: Record<string, unknown>;
        }
      ).data;

    // run.started (1): the pipeline root is a `fingerprint` field; the
    // `first_iteration_path` beside it is a `keep` field and relativizes —
    // against `pipeline_root`, the MOST SPECIFIC of this event's two roots,
    // not against the project root.
    expect(data(1).pipeline_root).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(data(1).first_iteration_path).toBe('steps/01-prepare.md');
    // iteration.started (2) and iteration.completed (3) now agree on one label,
    // which is the v4 sequential fold's own pairing key.
    expect(data(2).iteration_path).toBe('.pipeline/i1-e2e-probe/steps/01-prepare.md');
    expect(data(3).iteration_path).toBe(data(2).iteration_path);
    expect(data(3).next_iteration_path).toBe('.pipeline/i1-e2e-probe/steps/02-finish.md');
    // Under no known root: fingerprinted, correlatable, disclosing nothing.
    expect(data(4).iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
    // The FAIL summary keeps its prose and loses only the path inside it.
    expect(data(5).halt_reason).toBe(
      'cannot open .pipeline/i1-e2e-probe/steps/02-finish.md (ENOENT)'
    );
    // Nothing else about the payload changed.
    expect(data(6).tool_name).toBe('Read');
  });

  test('`b21`\'s run-exit STATS fold is clean too — including `failures[].step`, which is not `*_path`-named', async () => {
    // The stats record is the one payload whose path fields are NOT
    // `*_path`-named: `failures[].step` and `steps[].id` are `keep`-classified
    // plain identifiers that the engine can hand an absolute path.
    const record = validRunRecord(RUN_ID, {
      pipeline: 'i1-e2e-probe',
      outcome: 'halted',
      steps: [{ id: `${STEPS}\\01-prepare.md`, started_at: null, seconds: 4, outcome: 'FAIL', model: null, effort: null }],
      failures: [{ ts: '2026-08-07T10:58:20.000Z', tool: 'Bash', step: `${STEPS}\\01-prepare.md` }],
    });
    const statsSource: StatsSource = { findRunRecord: (id) => (id === RUN_ID ? record : null) };

    const { fs, transport, shipper } = makeRig({ statsSource });
    fs.appendText(
      JOURNAL,
      `${JSON.stringify(envelope('run.halted', { pipeline_name: 'i1-e2e-probe', halt_reason: 'failed' }))}\n`
    );
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    const uploaded = transport.confirmed.flatMap((b) => b.events);
    const stats = uploaded.filter(
      (e) => (e.payload as Record<string, unknown>).type === 'stats.run_record'
    );
    expect(stats).toHaveLength(1); // the fold happened — the check is not vacuous

    const findings = sg4Findings(stats[0]!.payload, 'stats#1');
    console.log(
      `\n[b23 ship path — stats fold]\n` +
        (findings.length === 0
          ? 'SG4: PASS — no prohibited field found'
          : `SG4: ${findings.length} problem(s)\n  - ${findings.join('\n  - ')}`) +
        '\n'
    );
    expect(findings).toEqual([]);

    const statsData = (stats[0]!.payload as { data: Record<string, unknown> }).data;
    expect((statsData.failures as Array<Record<string, unknown>>)[0]).toEqual({
      ts: '2026-08-07T10:58:20.000Z',
      tool: 'Bash',
      step: '.pipeline/i1-e2e-probe/steps/01-prepare.md',
    });
    expect((statsData.steps as Array<Record<string, unknown>>)[0]?.id).toBe(
      '.pipeline/i1-e2e-probe/steps/01-prepare.md'
    );
    // …and the spool files that carried it.
    for (const f of stateFiles(fs)) {
      expect(`${f.name}: ${f.text.includes(PROD_ACCOUNT)}`).toBe(`${f.name}: false`);
    }
  });

  test('the OS account name of the machine running this test never reaches the transport or the spool', async () => {
    // The fixture above names `IvanD`; this one names whoever is running the
    // suite, so the assertion is about a real identity rather than a string.
    const account = userInfo().username;
    const root = `C:\\Users\\${account}\\AppData\\Local\\Temp\\claude\\proj`;
    const { fs, transport, shipper } = makeRig({ projectRoot: root });
    fs.appendText(
      JOURNAL,
      `${JSON.stringify({
        schema: 5,
        ts: '2026-08-07T10:58:39.207Z',
        type: 'iteration.started',
        project_root: root,
        worktree: null,
        run_id: RUN_ID,
        parent_run_id: null,
        session_id: null,
        data: { index: 1, step_name: '01-prepare', iteration_path: `${root}\\.pipeline\\probe\\steps\\01-prepare.md` },
      })}\n`
    );
    shipper.pollOnce();
    shipper.flushNow();
    await settle();

    const bodies = transport.confirmed.map((b) => JSON.stringify(b));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.toLowerCase()).not.toContain(account.toLowerCase());
    for (const f of stateFiles(fs)) {
      expect(`${f.name}: ${f.text.toLowerCase().includes(account.toLowerCase())}`).toBe(
        `${f.name}: false`
      );
    }
    const shipped = transport.confirmed.flatMap((b) => b.events)[0]!.payload as {
      data: Record<string, unknown>;
    };
    expect(shipped.data.iteration_path).toBe('.pipeline/probe/steps/01-prepare.md');
  });
});
