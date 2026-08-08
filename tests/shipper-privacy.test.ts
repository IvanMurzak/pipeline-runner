/**
 * Privacy-tier filter tests — THE trust-boundary suite of T1-12.
 *
 * The headline test feeds events stuffed with known CONTENT fields (question
 * text/context/options, prompt/response/transcript-like passthrough fields,
 * unknown event types, envelope-level additions, absolute machine paths) and
 * asserts NONE of that content survives the metadata-tier filter that runs
 * before anything is spooled or uploaded — allowlist-driven, unknown fields
 * dropped by default.
 *
 * ── WHAT ux-v2 `b23` CHANGED IN THIS FILE, AND WHY ──────────────────────────
 *
 * Until `b23` this suite was VACUOUS for the `keep`-classified path fields, and
 * it was vacuous in the specific way that made the SG4 defect survive three
 * weeks in production. Two habits did it, and both are corrected below rather
 * than deleted, because each was testing something real:
 *
 *   1. absolute paths were only ever planted in fields the filter ALREADY
 *      fingerprints (`project_root`, `pipeline_root`, `worktree_path`) — so the
 *      "absolute machine paths become fingerprints" test proved the
 *      `fingerprint` rule and said nothing at all about `keep`;
 *   2. `iteration_path` was planted as an ALREADY-RELATIVE `'steps/03-review.md'`
 *      and asserted to SURVIVE. That assertion is correct and is kept — a
 *      relative label must not be mangled — but on its own it encoded the
 *      filter's false assumption (that the emitter hands it relative paths) as
 *      the contract. Every absolute value went untested.
 *
 * So each is now planted BOTH ways: relative in, relative out; absolute in,
 * never out. The rule itself gets its own section at the bottom of this file.
 */

import { describe, expect, test } from 'bun:test';
import { userInfo } from 'node:os';
import {
  DEFAULT_PRIVACY_TIER,
  SG4_PATH_RE,
  collectPathRoots,
  defaultAccountNames,
  fingerprintString,
  filterEventForTier,
  filterStatsRecordMetadata,
  looksAbsolutePath,
  PRIVACY_TIER_ENV,
  QUESTION_PLACEHOLDER,
  resolvePrivacyTier,
  scrubPathString,
  STEP_IDENTITY_FIELD,
  STEP_SCOPED_EVENT_TYPES,
  stepShapedAllowlistViolations,
  SUMMARY_MAX_CHARS,
} from '../src/shipper/privacy';
import { journalEvent } from './_shipper-helpers';

/** A real CLI-minted step identity (`b4`): UUIDv7, version nibble `7`. */
const STEP_UUID = '019fded9-3a7c-7c31-9f0e-2b5a1d4e8c60';

const SECRETS = {
  questionText: 'SECRET_QUESTION_should-we-deploy-the-payment-hotfix',
  questionContext: 'SECRET_CONTEXT_the-diff-touches-billing.ts-lines-40-90',
  questionOption: 'SECRET_OPTION_deploy-to-prod-now',
  prompt: 'SECRET_PROMPT_full-step-instructions-with-code',
  response: 'SECRET_RESPONSE_assistant-transcript-chunk',
  message: 'SECRET_MESSAGE_free-text-from-a-newer-emitter',
  fileContent: 'SECRET_FILE_CONTENT_api-key=sk-live-123',
  envelopeExtra: 'SECRET_ENVELOPE_note-field-added-by-newer-peer',
  unknownTypePayload: 'SECRET_UNKNOWN_TYPE_chat-message-body',
  hookDetail: 'SECRET_HOOK_STDERR_dump-with-paths-and-code',
  projectRoot: 'C:/Users/ivan/very-secret-client-project',
  worktreePath: 'C:/Users/ivan/very-secret-client-project/.worktrees/run-1',
  // `b23`: absolute paths in `keep`-CLASSIFIED fields — the disposition this
  // suite never planted one in. One inside the run's own project root (which
  // must come back as the relative remainder) and one outside every root
  // (which must fail closed to a fingerprint).
  keepFieldPathInRoot: 'C:/Users/ivan/very-secret-client-project/.pipeline/release/steps/03-review.md',
  keepFieldPathOffRoot: 'C:/Users/ivan/Documents/another-client/hand-off.md',
} as const;

describe('privacy filter — metadata tier (the trust boundary)', () => {
  test('metadata tier leaks NO content: known content fields are stripped and unknown fields are dropped by default', () => {
    const events: Record<string, unknown>[] = [
      // The flagship content-bearing event: the needs-input question.
      journalEvent('awaiting_input', 'r1', {
        run_id: 'r1',
        iteration: 3,
        question_id: 'q-77',
        question: {
          text: SECRETS.questionText,
          context: SECRETS.questionContext,
          options: [SECRETS.questionOption],
        },
      }),
      // A known type carrying UNKNOWN (new/passthrough) content fields, and
      // (`b23`) ABSOLUTE paths in the two `keep`-classified fields whose
      // verbatim copy is the SG4 defect i1 found in production.
      journalEvent('iteration.completed', 'r1', {
        iteration_path: SECRETS.keepFieldPathInRoot,
        outcome: 'completed',
        next_iteration_path: SECRETS.keepFieldPathOffRoot,
        prompt: SECRETS.prompt,
        response: SECRETS.response,
        message: SECRETS.message,
        file_content: SECRETS.fileContent,
      }),
      // …and the same field with an ALREADY-RELATIVE value, which must survive
      // untouched. Both halves are the contract; only the first was ever
      // tested, and only the second was ever planted.
      journalEvent('iteration.started', 'r1', { iteration_path: 'steps/03-review.md', index: 3 }),
      // An UNKNOWN event type: data must be stripped entirely.
      journalEvent('chat.message', 'r1', { body: SECRETS.unknownTypePayload }),
      // Envelope-level passthrough addition: dropped.
      journalEvent('tool.called', 'r1', { tool_name: 'Bash', success: true, agent_spawn: false, tool_use_id: 't-1' }, { note: SECRETS.envelopeExtra }),
      // Free-text hook stderr on worktree events: dropped (not a FAIL summary).
      journalEvent('worktree.created', 'r1', { ok: false, detail: SECRETS.hookDetail, worktree_path: SECRETS.worktreePath }),
    ];

    const filtered = events.map((event) => filterEventForTier(event, 'metadata'));
    const wire = JSON.stringify(filtered);

    // NONE of the content survives — not as a value, not as a substring.
    for (const secret of Object.values(SECRETS)) {
      expect(wire).not.toContain(secret);
    }

    // …while the metadata the product runs on DOES survive.
    const [awaiting, completed, started, unknown, tool] = filtered as Array<Record<string, unknown>>;
    expect(awaiting.run_id).toBe('r1');
    expect((awaiting.data as Record<string, unknown>).question_id).toBe('q-77');
    expect((awaiting.data as Record<string, unknown>).iteration).toBe(3);
    // The question survives only as a schema-valid placeholder (so the
    // server's strict parse + awaiting-input derivation still work).
    expect((awaiting.data as Record<string, unknown>).question).toEqual({ text: QUESTION_PLACEHOLDER });
    expect((completed.data as Record<string, unknown>).outcome).toBe('completed');
    // `b23`: the step is STILL NAMED — relative to the run's own root, which is
    // the label `07-security.md` §4.2 grants the metadata tier and the value
    // the control plane's step correlation keys on. The fix is not "ship
    // nothing".
    expect((completed.data as Record<string, unknown>).iteration_path).toBe(
      '.pipeline/release/steps/03-review.md'
    );
    // …and the one under no known root fails CLOSED rather than shipping raw.
    expect((completed.data as Record<string, unknown>).next_iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
    // An already-relative value is untouched — the half this suite used to test
    // on its own.
    expect((started.data as Record<string, unknown>).iteration_path).toBe('steps/03-review.md');
    expect(unknown.type).toBe('chat.message');
    expect(unknown.data).toEqual({}); // unknown type: stripped, never leaked
    expect((tool.data as Record<string, unknown>).tool_name).toBe('Bash');
    expect((tool.data as Record<string, unknown>).success).toBe(true);
    expect(tool.note).toBeUndefined();
  });

  test('absolute machine paths become deterministic fingerprints (correlatable, unreadable)', () => {
    const event = journalEvent('run.started', 'r1', {
      pipeline_name: 'release',
      pipeline_root: SECRETS.worktreePath,
      // `b23`: a `keep`-classified path field in the SAME payload. Before
      // `b23` this test asserted only the two `fingerprint` fields beside it —
      // same payload, same filter, two dispositions, and only one of them was
      // ever looked at. That is precisely why a spot check passed.
      first_iteration_path: SECRETS.keepFieldPathInRoot,
    });
    const a = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    const b = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    expect(a.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(a.project_root).toBe(b.project_root); // deterministic — correlates
    expect((a.data as Record<string, unknown>).pipeline_root).toMatch(/^fp:[0-9a-f]{16}$/);
    expect((a.data as Record<string, unknown>).pipeline_name).toBe('release');
    expect((a.data as Record<string, unknown>).first_iteration_path).toBe(
      '.pipeline/release/steps/03-review.md'
    );
    expect(JSON.stringify(a)).not.toContain(SECRETS.keepFieldPathInRoot);
    // Null worktree passes through as null (parseable envelope).
    expect(a.worktree).toBeNull();
    // A salt changes the fingerprint (hardening against dictionary attacks).
    const salted = filterEventForTier(event, 'metadata', { fingerprintSalt: 's1' }) as Record<string, unknown>;
    expect(salted.project_root).not.toBe(a.project_root);
    expect(fingerprintString('x', 'a')).not.toBe(fingerprintString('x', 'b'));
  });

  test('halt_reason is the FAIL summary the metadata tier keeps — but bounded', () => {
    const long = 'x'.repeat(SUMMARY_MAX_CHARS + 100);
    const event = journalEvent('pipeline.halted', 'r1', { pipeline_name: 'p', iteration_path: 's.md', halt_reason: long });
    const filtered = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    const reason = (filtered.data as Record<string, unknown>).halt_reason as string;
    expect(reason.length).toBe(SUMMARY_MAX_CHARS + 1); // truncated + ellipsis
    expect(reason.startsWith('x'.repeat(SUMMARY_MAX_CHARS))).toBe(true);
    // Null halt_reason stays null (the schema allows it).
    const nullEvent = journalEvent('run.halted', 'r1', { halt_reason: null });
    expect(((filterEventForTier(nullEvent, 'metadata') as Record<string, unknown>).data as Record<string, unknown>).halt_reason).toBeNull();
  });

  test('numeric usage/count events pass complete at metadata (the eval measures)', () => {
    const usage = journalEvent('turn.usage', 'r1', {
      assistant_turns: 4,
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_creation_tokens: 100,
    });
    const filtered = filterEventForTier(usage, 'metadata') as Record<string, unknown>;
    expect(filtered.data).toEqual({
      assistant_turns: 4,
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_creation_tokens: 100,
    });
  });
});

describe('privacy filter — tier ordering', () => {
  test('higher tiers send progressively more: events/full pass the event verbatim', () => {
    const event = journalEvent('awaiting_input', 'r1', {
      run_id: 'r1',
      iteration: 1,
      question_id: 'q1',
      question: { text: SECRETS.questionText },
    });
    for (const tier of ['events', 'full'] as const) {
      const filtered = filterEventForTier(event, tier);
      expect(filtered).toEqual(event); // verbatim — including the content
      expect(JSON.stringify(filtered)).toContain(SECRETS.questionText);
    }
    // …and metadata is a strict subset of both.
    const metadata = JSON.stringify(filterEventForTier(event, 'metadata'));
    expect(metadata).not.toContain(SECRETS.questionText);
  });
});

describe('privacy tier resolution (fail-closed)', () => {
  test('defaults to metadata', () => {
    expect(resolvePrivacyTier(undefined, {})).toEqual({ tier: 'metadata', warning: null });
    expect(DEFAULT_PRIVACY_TIER).toBe('metadata');
  });

  test('explicit config wins over env; both accept valid tiers', () => {
    expect(resolvePrivacyTier('events', { [PRIVACY_TIER_ENV]: 'full' }).tier).toBe('events');
    expect(resolvePrivacyTier(undefined, { [PRIVACY_TIER_ENV]: 'full' }).tier).toBe('full');
  });

  test('an unrecognized tier FAILS CLOSED to metadata with a warning — never to a more permissive tier', () => {
    const fromConfig = resolvePrivacyTier('everything', {});
    expect(fromConfig.tier).toBe('metadata');
    expect(fromConfig.warning).toContain("'everything'");
    const fromEnv = resolvePrivacyTier(undefined, { [PRIVACY_TIER_ENV]: 'debug' });
    expect(fromEnv.tier).toBe('metadata');
    expect(fromEnv.warning).toContain('failing closed');
  });
});

describe('privacy filter — synthetic stats record', () => {
  test('metadata keeps measures + taxonomy, drops unknown fields, bounds halt_reason', () => {
    const record: Record<string, unknown> = {
      schema: 1,
      run_id: 'r1',
      pipeline: 'workflows/release',
      started_at: '2026-07-11T10:00:00.000Z',
      ended_at: '2026-07-11T10:30:00.000Z',
      duration_s: 1800,
      outcome: 'completed',
      halt_reason: null,
      runner: 'drive',
      mode: 'sequential',
      steps_run: 3,
      steps: [
        { id: '01-build', started_at: '2026-07-11T10:00:01.000Z', seconds: 60, outcome: 'pass', model: 'sonnet', effort: null, secret_note: SECRETS.prompt },
      ],
      improver_runs: 0,
      improver_applied: 0,
      scripts_created: 0,
      merges: 1,
      merge_conflicts: 0,
      llm_steps: 3,
      tokens: { input: 100, output: 20, cache_read: 0, cache_creation: 0, tools_called: 9, tools_failed: 1, failed_tools: { Bash: 1 }, transcript: SECRETS.response },
      transcript_text: SECRETS.fileContent,
    };
    const filtered = filterStatsRecordMetadata(record);
    const wire = JSON.stringify(filtered);
    expect(wire).not.toContain(SECRETS.prompt);
    expect(wire).not.toContain(SECRETS.response);
    expect(wire).not.toContain(SECRETS.fileContent);
    expect(filtered.pipeline).toBe('workflows/release');
    expect(filtered.duration_s).toBe(1800);
    expect((filtered.steps as Array<Record<string, unknown>>)[0]).toEqual({
      id: '01-build',
      started_at: '2026-07-11T10:00:01.000Z',
      seconds: 60,
      outcome: 'pass',
      model: 'sonnet',
      effort: null,
    });
    expect((filtered.tokens as Record<string, unknown>).failed_tools).toEqual({ Bash: 1 });
    // A null tokens (pending enrichment) stays null.
    expect(filterStatsRecordMetadata({ tokens: null }).tokens).toBeNull();
  });

  /**
   * `b23` — TRAP 1. `STATS_FAILURE_ALLOWLIST.step` is `keep`-classified and is
   * NOT `*_path`-named, so no field-name rule would ever have reached it, and
   * it is on the run-exit ship path. `steps[].id` is the same shape of value.
   * Both are checked here, with and without a root to relativize against.
   */
  test('`failures[].step` and `steps[].id` are path-scrubbed even though neither is `*_path`-named', () => {
    const root = 'C:/Users/ivan/very-secret-client-project';
    const abs = `${root}/.pipeline/release/steps/02-build.md`;
    const record: Record<string, unknown> = {
      run_id: 'r1',
      pipeline: 'workflows/release',
      outcome: 'halted',
      steps: [{ id: abs, seconds: 4, outcome: 'FAIL' }],
      failures: [{ ts: '2026-07-11T10:00:00.000Z', tool: 'Bash', step: abs }],
    };

    // With the root the caller knows: relativized, so the step is still named.
    const withRoot = filterStatsRecordMetadata(record, { pathRoots: [root] });
    expect((withRoot.failures as Array<Record<string, unknown>>)[0]).toEqual({
      ts: '2026-07-11T10:00:00.000Z',
      tool: 'Bash',
      step: '.pipeline/release/steps/02-build.md',
    });
    expect((withRoot.steps as Array<Record<string, unknown>>)[0]?.id).toBe(
      '.pipeline/release/steps/02-build.md'
    );
    expect(JSON.stringify(withRoot)).not.toContain(abs);

    // With NO root at all: fails closed to a fingerprint. Never raw.
    const noRoot = filterStatsRecordMetadata(record);
    expect((noRoot.failures as Array<Record<string, unknown>>)[0]?.step).toMatch(/^fp:[0-9a-f]{16}$/);
    expect((noRoot.steps as Array<Record<string, unknown>>)[0]?.id).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(JSON.stringify(noRoot)).not.toContain(abs);
  });

  test('the stats event routes through the nested filter at metadata tier', () => {
    const event = journalEvent('stats.run_record', 'r1', { pipeline: 'p', outcome: 'completed', transcript: SECRETS.response });
    const filtered = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    expect(JSON.stringify(filtered)).not.toContain(SECRETS.response);
    expect((filtered.data as Record<string, unknown>).outcome).toBe('completed');
  });

  test('the envelope supplies the root for a nested stats record — no caller plumbing needed', () => {
    // `statsRecordEvent` stamps the project root on the envelope, so a stats
    // record shipped through the journal path relativizes without the caller
    // having to know anything. (`journalEvent`'s root is the same one.)
    const abs = 'C:/Users/ivan/very-secret-client-project/.pipeline/release/steps/02-build.md';
    const event = journalEvent('stats.run_record', 'r1', {
      pipeline: 'release',
      outcome: 'halted',
      failures: [{ ts: '2026-07-11T10:00:00.000Z', tool: 'Bash', step: abs }],
    });
    const filtered = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    const failures = (filtered.data as Record<string, unknown>).failures as Array<Record<string, unknown>>;
    expect(failures[0]?.step).toBe('.pipeline/release/steps/02-build.md');
    expect(JSON.stringify(filtered)).not.toContain(abs);
  });
});

describe('privacy filter — v5 step-key rename', () => {
  // Journal schema v5 renamed the iteration events' step identity from
  // `step_id` to `step_name`. Both must survive the metadata tier: step
  // identity is metadata the product's per-step dashboards are built on.
  // Allowlisting only the new name would silently strip the identity out of
  // every journal written before the rename — which is most of the ones a
  // runner ships today. (`b23`: a step NAME is a name, not a path; it is not
  // path-shaped and the SG4 scrub does not touch it. The step's PATH is
  // covered in the SG4 section below.)
  // ux-v2 `b24` CORRECTED THIS TEST. It asserted the two NAME fields and
  // stopped there, so it passed green against a filter that was stripping the
  // step's ROW IDENTITY (`step_uuid`) off the same three events — the omission
  // that made the cloud write two rows per step. A conformance test that
  // enumerates an allowlist's fields by hand encodes whatever the allowlist
  // happened to contain when it was written; that is how the gap survived.
  // The identity is asserted here alongside the names, and the RULE behind it
  // gets its own section at the bottom of this file.
  test.each(['iteration.started', 'iteration.resumed', 'iteration.completed'])(
    '%s keeps step_name (v5), step_id (v4) AND step_uuid (b4 row identity)',
    (type) => {
      const event = journalEvent(type, 'r1', {
        iteration_path: 'steps/review.md',
        outcome: 'completed',
        step_name: 'review',
        step_id: 'review',
        step_uuid: STEP_UUID,
      });
      const data = (filterEventForTier(event, 'metadata') as { data: Record<string, unknown> }).data;
      expect(data.step_name).toBe('review');
      expect(data.step_id).toBe('review');
      expect(data.step_uuid).toBe(STEP_UUID);
      expect(data.iteration_path).toBe('steps/review.md');
    },
  );

  test('a sibling field that merely LOOKS like step identity is still dropped', () => {
    // `keep` is verbatim by design, so the guard is the allowlist itself.
    const event = journalEvent('iteration.started', 'r1', {
      iteration_path: 'steps/a.md',
      step_name: 'a',
      step_description: SECRETS.prompt,
    });
    const data = (filterEventForTier(event, 'metadata') as { data: Record<string, unknown> }).data;
    expect(data.step_name).toBe('a');
    expect(data.step_description).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain(SECRETS.prompt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SG4 — the RULE (ux-v2 `b23`; `07-security.md` §4.1 and gate SG4)
// ─────────────────────────────────────────────────────────────────────────────
//
// SG4 was violated in production from 2026-07-19 to 2026-08-07, and the reason
// it survived is that the leak is INCONSISTENT: the same step's
// `iteration.started` carried a relative `01-prepare.md` while its
// `iteration.completed`, eight seconds later in the same run, carried
// `C:\Users\<account>\…\steps\01-prepare.md`. A spot check finds the first one
// and concludes the filter works.
//
// So this section tests the RULE — the shape of the value — rather than the two
// fields `i1` happened to observe. `b22` proved exactly this over the CLI's
// copy of the filter; `b23` moved it INTO the filter, and these are its tests,
// retargeted at `filterEventForTier` so they exercise the filter alone.

/** Every string leaf of a payload, with its dotted location — the same walk
 *  `scripts/i1-production-e2e/check-sg4.mjs:scanStrings` performs against the
 *  production rows. */
function stringLeaves(node: unknown, at = 'payload'): Array<[string, string]> {
  if (typeof node === 'string') return [[at, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${at}.${k}`));
  }
  return [];
}

/** The SG4 verdict on a payload, as `location -> value` findings. Returned
 *  rather than asserted so a failure NAMES the field and the value. */
function sg4Findings(payload: unknown): string[] {
  return stringLeaves(payload)
    .filter(([, v]) => SG4_PATH_RE.test(v))
    .map(([at, v]) => `${at} -> ${JSON.stringify(v.slice(0, 140))}`);
}

const SALT = 'test-salt-b23';
/** The user's home, in each of the three absolute shapes, with a recognisable
 *  account name. Fixture values (not this machine's) so the sweep is
 *  deterministic; the live account is used in its own test at the end. */
const WIN_ROOT = 'C:\\Users\\IvanD\\AppData\\Local\\Temp\\claude\\proj-i1-e2e';
const POSIX_ROOT = '/home/ivand/work/proj-i1-e2e';
const UNC_ROOT = '\\\\fileserver\\team\\ivand\\proj-i1-e2e';

function sg4Envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: 5,
    ts: '2026-08-07T10:58:39.207Z',
    type,
    project_root: WIN_ROOT,
    worktree: null,
    run_id: 'r1',
    parent_run_id: null,
    session_id: null,
    data,
  };
}

describe('privacy filter — SG4: an absolute path never survives, whatever field carries it', () => {
  test('EVERY `keep`-classified path field is scrubbed — not just the two i1 saw', () => {
    // The full set of fields DATA_ALLOWLISTS maps to `keep` and whose value is
    // a path. Enumerated from the allowlist tables, not from the defect report:
    // fixing only `iteration_path`/`next_iteration_path` would leave the rest
    // leaking on day one.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['iteration.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`, index: 1 }],
      [
        'iteration.completed',
        {
          iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
          next_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\02.md`,
          outcome: 'completed',
        },
      ],
      ['iteration.resumed', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['pipeline.started', { first_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['run.started', { first_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['pipeline.halted', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['run.halted', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['improver.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['improver.completed', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      ['script_creator.started', { iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
      [
        'script_creator.completed',
        {
          iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
          script_path: `${WIN_ROOT}\\.pipeline\\p\\scripts\\build.ts`,
        },
      ],
      ['blocker.delegated', { parent_iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md` }],
    ];

    const report: string[] = [];
    for (const [type, data] of cases) {
      const filtered = filterEventForTier(sg4Envelope(type, data), 'metadata', {
        fingerprintSalt: SALT,
      });
      const findings = sg4Findings(filtered);
      report.push(`  ${findings.length ? 'LEAK  ' : 'clean '} ${type}`);
      expect(`${type}: ${findings.join(' | ') || 'clean'}`).toBe(`${type}: clean`);

      // …and not by DELETING the field: it still names the step, relative to
      // the run's own root.
      const out = filtered.data as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        if (!key.endsWith('_path')) continue;
        const expected =
          key === 'script_path'
            ? '.pipeline/p/scripts/build.ts'
            : `.pipeline/p/steps/${key === 'next_iteration_path' ? '02' : '01'}.md`;
        expect(`${type}.${key} = ${String(out[key])}`).toBe(`${type}.${key} = ${expected}`);
      }
    }
    console.log(`\n[b23 keep-field sweep]\n${report.join('\n')}\n`);
  });

  test('a path in a field NOBODY allowlisted as a path is still scrubbed — the shape is the rule', () => {
    // `halt_reason` is a `summary` field: free text, truncated but KEPT. It is
    // exactly where a stack frame or a command line drags a path onto the wire,
    // and no field-name rule would ever catch it.
    const filtered = filterEventForTier(
      sg4Envelope('iteration.completed', {
        outcome: 'halted',
        halt_reason: `build failed: cannot open ${WIN_ROOT}\\.pipeline\\p\\steps\\01.md (ENOENT)`,
      }),
      'metadata',
      { fingerprintSalt: SALT }
    );
    expect(sg4Findings(filtered)).toEqual([]);
    // The prose survives; only the path inside it is rewritten.
    expect((filtered.data as Record<string, unknown>).halt_reason).toBe(
      'build failed: cannot open .pipeline/p/steps/01.md (ENOENT)'
    );
  });

  test('all three absolute-path shapes are recognised, and a relative value is untouched', () => {
    expect(looksAbsolutePath(`${WIN_ROOT}\\x.md`)).toBe(true);
    expect(looksAbsolutePath(`${POSIX_ROOT}/x.md`)).toBe(true);
    expect(looksAbsolutePath(`${UNC_ROOT}\\x.md`)).toBe(true);
    expect(looksAbsolutePath('steps/01-prepare.md')).toBe(false);
    expect(looksAbsolutePath('01-prepare.md')).toBe(false);
    // A URL is not a path — `blocker_issue_url` is a `keep` field and must not
    // be mangled. (`https://` contains `s:/`, which is why the arbiter's
    // leading guard is load-bearing.)
    expect(looksAbsolutePath('https://github.com/IvanMurzak/pipeline/issues/1')).toBe(false);
    expect(
      scrubPathString('https://github.com/IvanMurzak/pipeline/issues/1', { fingerprintSalt: SALT })
    ).toBe('https://github.com/IvanMurzak/pipeline/issues/1');
    expect(scrubPathString('steps/01-prepare.md', { fingerprintSalt: SALT })).toBe('steps/01-prepare.md');

    for (const root of [WIN_ROOT, POSIX_ROOT, UNC_ROOT]) {
      const sep = root.includes('/') ? '/' : '\\';
      const abs = `${root}${sep}.pipeline${sep}p${sep}steps${sep}01.md`;
      expect(scrubPathString(abs, { roots: [root], fingerprintSalt: SALT })).toBe('.pipeline/p/steps/01.md');
    }
    // …and through the real filter for the UNC and POSIX shapes, since the
    // keep-field sweep above is Windows-shaped throughout.
    for (const root of [POSIX_ROOT, UNC_ROOT]) {
      const sep = root.includes('/') ? '/' : '\\';
      const event = {
        ...sg4Envelope('iteration.started', {
          iteration_path: `${root}${sep}.pipeline${sep}p${sep}steps${sep}01.md`,
        }),
        project_root: root,
      };
      const filtered = filterEventForTier(event, 'metadata', { fingerprintSalt: SALT });
      expect((filtered.data as Record<string, unknown>).iteration_path).toBe('.pipeline/p/steps/01.md');
      expect(sg4Findings(filtered)).toEqual([]);
    }
  });

  test('a path under NO known root FAILS CLOSED to a fingerprint — never passes through raw', () => {
    const orphan = 'C:\\Users\\IvanD\\Documents\\other-client\\secret.md';
    const out = scrubPathString(orphan, { roots: [POSIX_ROOT], fingerprintSalt: SALT });
    expect(out).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(SG4_PATH_RE.test(out)).toBe(false);
    // Deterministic, so telemetry still correlates on it.
    expect(scrubPathString(orphan, { roots: [], fingerprintSalt: SALT })).toBe(out);
    // …and the same through the filter: the event's own root does not contain it.
    const filtered = filterEventForTier(
      sg4Envelope('iteration.completed', { iteration_path: orphan, outcome: 'completed' }),
      'metadata',
      { fingerprintSalt: SALT }
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(sg4Findings(filtered)).toEqual([]);
  });

  test('a relativized remainder that would STILL carry the account name is refused', () => {
    // Root is the home directory itself, so the remainder would be
    // `IvanD/proj/steps/01.md` — root-free, but still naming the account.
    expect(
      scrubPathString('C:\\Users\\IvanD\\proj\\steps\\01.md', {
        roots: ['C:\\Users'],
        accountNames: ['ivand'],
        fingerprintSalt: SALT,
      })
    ).toMatch(/^fp:[0-9a-f]{16}$/);
    // Through the filter, with the account name injected so the assertion is
    // about the RULE and not about whoever happens to run the suite.
    const filtered = filterEventForTier(
      {
        ...sg4Envelope('iteration.started', { iteration_path: 'C:\\Users\\IvanD\\proj\\steps\\01.md' }),
        project_root: 'C:\\Users',
      },
      'metadata',
      { fingerprintSalt: SALT, accountNames: ['ivand'] }
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
  });

  test('the salt reaches the fingerprint through the DEEP walk, not only the single-string entry point', () => {
    // `ResolvedScrubOptions.salt` and `PathScrubOptions.fingerprintSalt` are
    // two names for one thing; a deep walk that re-entered the public entry
    // point per string would drop the salt and hash under the empty key —
    // weaker than the public constant `b15` retired.
    const orphan = 'C:\\elsewhere\\hand-off\\01.md';
    const fp = (salt: string): unknown =>
      (
        filterEventForTier(sg4Envelope('iteration.started', { iteration_path: orphan }), 'metadata', {
          fingerprintSalt: salt,
        }).data as Record<string, unknown>
      ).iteration_path;
    expect(fp('salt-a')).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(fp('salt-a')).not.toBe(fp('salt-b'));
    expect(fp('salt-a')).not.toBe(fp(''));
    // …and it is the SAME value the single-string entry point produces.
    expect(fp('salt-a')).toBe(scrubPathString(orphan, { fingerprintSalt: 'salt-a' }));
  });

  test('the scrub is IDEMPOTENT — re-filtering an already-filtered payload changes nothing', () => {
    const once = filterEventForTier(
      sg4Envelope('iteration.completed', {
        iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
        next_iteration_path: 'C:\\elsewhere\\x.md',
        outcome: 'completed',
      }),
      'metadata',
      { fingerprintSalt: SALT }
    );
    // A queue file holds `once`; a second pass re-filters it before the socket.
    // `project_root` is already `fp:…` by then, so the event's own roots are
    // gone — which must not turn a relativized label into a fingerprint.
    const twice = filterEventForTier(once, 'metadata', { fingerprintSalt: SALT, pathRoots: [WIN_ROOT] });
    expect((twice.data as Record<string, unknown>).iteration_path).toBe(
      (once.data as Record<string, unknown>).iteration_path
    );
    expect((twice.data as Record<string, unknown>).next_iteration_path).toBe(
      (once.data as Record<string, unknown>).next_iteration_path
    );
  });

  test('the most SPECIFIC root wins — a worktree nested in the project root', () => {
    const worktree = `${WIN_ROOT}\\.worktrees\\run-1`;
    const roots = collectPathRoots({ project_root: WIN_ROOT, worktree });
    expect(roots[0]).toBe(worktree); // longest-first
    expect(scrubPathString(`${worktree}\\.pipeline\\p\\steps\\01.md`, { roots, fingerprintSalt: SALT })).toBe(
      '.pipeline/p/steps/01.md'
    );
  });

  test('roots are read from the UNFILTERED event — after the allowlist `project_root` is a fingerprint', () => {
    const event = { project_root: WIN_ROOT, worktree: null, data: { pipeline_root: `${WIN_ROOT}\\.pipeline\\p` } };
    expect(collectPathRoots(event)).toEqual([`${WIN_ROOT}\\.pipeline\\p`, WIN_ROOT]);
    // What the filter leaves behind names nothing, which is why the roots are
    // collected BEFORE the allowlist runs.
    expect(collectPathRoots({ project_root: 'fp:d00eb2c5706c9640' })).toEqual([]);
  });

  test('the OS account name of the machine running this test does not ship', () => {
    const account = userInfo().username;
    expect(account.length).toBeGreaterThan(0);
    expect(defaultAccountNames().includes(account.toLowerCase())).toBe(true);

    // The production shape, with THIS machine's identity in it.
    const root = `C:\\Users\\${account}\\AppData\\Local\\Temp\\claude\\proj`;
    const planted = `${root}\\.pipeline\\probe\\steps\\01-prepare.md`;
    const filtered = filterEventForTier(
      { ...sg4Envelope('iteration.started', { iteration_path: planted }), project_root: root },
      'metadata',
      { fingerprintSalt: SALT }
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toBe(
      '.pipeline/probe/steps/01-prepare.md'
    );
    expect(JSON.stringify(filtered).toLowerCase()).not.toContain(account.toLowerCase());
    expect(sg4Findings(filtered)).toEqual([]);

    // …and with no root to relativize against, it is still gone.
    const orphaned = filterEventForTier(
      sg4Envelope('iteration.started', { iteration_path: planted }),
      'metadata',
      { fingerprintSalt: SALT }
    );
    expect((orphaned.data as Record<string, unknown>).iteration_path).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(JSON.stringify(orphaned).toLowerCase()).not.toContain(account.toLowerCase());
  });

  test('`events` and `full` still pass VERBATIM — at those tiers the TIER is the control', () => {
    // Stated rather than left to be discovered: the scrub is a metadata-tier
    // rule, exactly like the allowlist it runs after. An opt-in tier ships the
    // envelope as written, which is already how `project_root` behaves there.
    const event = sg4Envelope('iteration.started', {
      iteration_path: `${WIN_ROOT}\\.pipeline\\p\\steps\\01.md`,
    });
    for (const tier of ['events', 'full'] as const) {
      expect(filterEventForTier(event, tier)).toBe(event);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STEP-IDENTITY RULE (ux-v2 `b24`; `02` D15, `04` §2, migration 049)
// ─────────────────────────────────────────────────────────────────────────────
//
// D15 gives a step ONE identity so its TWO reporters — the `iteration.*` event
// stream and the runner's `stats.run_record` fold — name ONE `step_executions`
// row. The CLI mints it (`b4`) and writes it to both local paths correctly.
// This filter stripped it off both, because deny-by-default plus an allowlist
// that never mentioned `step_uuid` is a silent delete: `grep -c step_uuid` over
// the shipped filter returned 0. The server then derived an identity per path,
// over two different keys, and wrote a row for each — 4 rows for 2 steps in
// production, on both of `i1`'s runs.
//
// The section above ("v5 step-key rename") is where this SHOULD have been
// caught: it asserted the two NAME fields survive and never asked about the
// identity. That is the third time on this board an allowlist omission passed
// a green conformance test (`b22`'s `keep` rule, `b23`'s
// `stats.failures[].step`, now this), so the assertions below are written
// against the RULE and the live tables rather than against a hand-copied field
// list — a hand-copied field list is the thing that keeps being wrong.

describe('privacy filter — the step-identity rule (b24)', () => {
  test('THE SWEEP: no step-shaped allowlist is missing step identity', () => {
    // Computed over the live tables, so a NEW step-shaped allowlist written as
    // a bare object literal — bypassing `withStepIdentity` — fails here instead
    // of silently stripping the field in production.
    expect(stepShapedAllowlistViolations()).toEqual([]);
  });

  test.each([...STEP_SCOPED_EVENT_TYPES])('%s carries step_uuid through the metadata tier', (type) => {
    const event = journalEvent(type, 'r1', { iteration_path: 'steps/01.md', step_uuid: STEP_UUID });
    const data = (filterEventForTier(event, 'metadata') as { data: Record<string, unknown> }).data;
    expect(data[STEP_IDENTITY_FIELD]).toBe(STEP_UUID);
  });

  test('the stats fold carries step_uuid on every StepStat', () => {
    // The other half of the duplication: this is the reporter whose missing
    // identity made the server open a second row under `stats:<name>`.
    const filtered = filterStatsRecordMetadata({
      schema: 3,
      run_id: 'r1',
      pipeline: 'release',
      outcome: 'completed',
      steps: [
        { id: '01-prepare', seconds: 12, outcome: 'pass', step_uuid: STEP_UUID },
        { id: '02-finish', seconds: 5, outcome: 'pass' }, // pre-`b4`: absent, not invented
      ],
    });
    const steps = filtered.steps as Array<Record<string, unknown>>;
    expect(steps[0]?.[STEP_IDENTITY_FIELD]).toBe(STEP_UUID);
    expect(steps[0]?.id).toBe('01-prepare');
    // A record from a pre-`b4` reporter keeps behaving exactly as it does
    // today — the field is absent, never fabricated.
    expect(steps[1]).not.toHaveProperty(STEP_IDENTITY_FIELD);
  });

  test('D15: both reporters ship the SAME uuid, so the cloud sees ONE row', () => {
    // The property the whole design rests on, asserted end-to-end across the
    // two filter entry points rather than per-allowlist. If either side drops
    // or rewrites the value, the server falls back to its per-path derivation
    // and the duplicate returns.
    const fromEvent = (
      filterEventForTier(
        journalEvent('iteration.completed', 'r1', {
          iteration_path: 'steps/01-prepare.md',
          outcome: 'completed',
          step_name: '01-prepare',
          step_uuid: STEP_UUID,
        }),
        'metadata',
      ) as { data: Record<string, unknown> }
    ).data[STEP_IDENTITY_FIELD];

    const fromStats = (
      filterStatsRecordMetadata({
        run_id: 'r1',
        steps: [{ id: '01-prepare', outcome: 'pass', step_uuid: STEP_UUID }],
      }).steps as Array<Record<string, unknown>>
    )[0]?.[STEP_IDENTITY_FIELD];

    expect(fromEvent).toBe(STEP_UUID);
    expect(fromStats).toBe(STEP_UUID);
    expect(fromEvent).toBe(fromStats);
  });

  test('awaiting_input keeps the step it parked on', () => {
    // Its emitter sends `step_name`/`iteration_path` as fields ADDITIVE to
    // `AwaitingInputData`, and this table — built from the protocol schema
    // field-for-field — dropped exactly the fields the emitter added.
    const data = (
      filterEventForTier(
        journalEvent('awaiting_input', 'r1', {
          run_id: 'r1',
          iteration: 2,
          question_id: 'gate:r1:02-finish',
          question: { text: SECRETS.questionText },
          step_name: '02-finish',
          iteration_path: 'steps/02-finish.md',
          step_uuid: STEP_UUID,
        }),
        'metadata',
      ) as { data: Record<string, unknown> }
    ).data;
    expect(data.step_name).toBe('02-finish');
    expect(data.iteration_path).toBe('steps/02-finish.md');
    expect(data[STEP_IDENTITY_FIELD]).toBe(STEP_UUID);
    // The question is still CONTENT and is still placeholdered.
    expect(JSON.stringify(data)).not.toContain(SECRETS.questionText);
  });

  // ── The privacy decision, asserted rather than asserted-in-prose ──────────
  //
  // `step_uuid` is `keep`. A locally-minted UUIDv7 is a timestamp plus random
  // bits (RFC 9562 §5.7): it is not derived from and cannot be inverted to a
  // path, an account name, or any authored content, and it is the same KIND of
  // opaque correlator as `run_id`/`session_id`, which this tier already keeps.
  // `fingerprint` would buy no privacy and would BREAK the row identity, since
  // the two reporters' values must stay byte-equal to name one row.

  test('a step uuid is not path-shaped, so the SG4 scrub leaves it alone', () => {
    expect(looksAbsolutePath(STEP_UUID)).toBe(false);
    expect(SG4_PATH_RE.test(STEP_UUID)).toBe(false);
    expect(scrubPathString(STEP_UUID)).toBe(STEP_UUID);
    // Kept verbatim, NOT fingerprinted — a `fp:` value would not match the
    // other reporter's and would resurrect the duplicate.
    expect(STEP_UUID).not.toMatch(/^fp:/);
    expect(fingerprintString(STEP_UUID)).not.toBe(STEP_UUID);
  });

  test('the uuid discloses nothing about the machine that minted it', () => {
    // The account-name check the SG4 section applies to paths, applied to the
    // identity: whatever this box is called, the uuid does not say.
    const filtered = filterEventForTier(
      journalEvent('iteration.started', 'r1', { iteration_path: 'steps/01.md', step_uuid: STEP_UUID }),
      'metadata',
    );
    const wire = JSON.stringify(filtered).toLowerCase();
    for (const account of defaultAccountNames()) {
      if (account.length > 2) expect(wire).not.toContain(account.toLowerCase());
    }
    expect(sg4Findings(filtered)).toEqual([]);
  });
});
