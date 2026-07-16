/**
 * Privacy-tier filter tests — THE trust-boundary suite of T1-12.
 *
 * The headline test feeds events stuffed with known CONTENT fields (question
 * text/context/options, prompt/response/transcript-like passthrough fields,
 * unknown event types, envelope-level additions, absolute machine paths) and
 * asserts NONE of that content survives the metadata-tier filter that runs
 * before anything is spooled or uploaded — allowlist-driven, unknown fields
 * dropped by default.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PRIVACY_TIER,
  fingerprintString,
  filterEventForTier,
  filterStatsRecordMetadata,
  PRIVACY_TIER_ENV,
  QUESTION_PLACEHOLDER,
  resolvePrivacyTier,
  SUMMARY_MAX_CHARS,
} from '../src/shipper/privacy';
import { journalEvent } from './_shipper-helpers';

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
      // A known type carrying UNKNOWN (new/passthrough) content fields.
      journalEvent('iteration.completed', 'r1', {
        iteration_path: 'steps/03-review.md',
        outcome: 'completed',
        next_iteration_path: null,
        prompt: SECRETS.prompt,
        response: SECRETS.response,
        message: SECRETS.message,
        file_content: SECRETS.fileContent,
      }),
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
    const [awaiting, completed, unknown, tool] = filtered as Array<Record<string, unknown>>;
    expect(awaiting.run_id).toBe('r1');
    expect((awaiting.data as Record<string, unknown>).question_id).toBe('q-77');
    expect((awaiting.data as Record<string, unknown>).iteration).toBe(3);
    // The question survives only as a schema-valid placeholder (so the
    // server's strict parse + awaiting-input derivation still work).
    expect((awaiting.data as Record<string, unknown>).question).toEqual({ text: QUESTION_PLACEHOLDER });
    expect((completed.data as Record<string, unknown>).outcome).toBe('completed');
    expect((completed.data as Record<string, unknown>).iteration_path).toBe('steps/03-review.md');
    expect(unknown.type).toBe('chat.message');
    expect(unknown.data).toEqual({}); // unknown type: stripped, never leaked
    expect((tool.data as Record<string, unknown>).tool_name).toBe('Bash');
    expect((tool.data as Record<string, unknown>).success).toBe(true);
    expect(tool.note).toBeUndefined();
  });

  test('absolute machine paths become deterministic fingerprints (correlatable, unreadable)', () => {
    const event = journalEvent('run.started', 'r1', { pipeline_name: 'release', pipeline_root: SECRETS.worktreePath });
    const a = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    const b = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    expect(a.project_root).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(a.project_root).toBe(b.project_root); // deterministic — correlates
    expect((a.data as Record<string, unknown>).pipeline_root).toMatch(/^fp:[0-9a-f]{16}$/);
    expect((a.data as Record<string, unknown>).pipeline_name).toBe('release');
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

  test('the stats event routes through the nested filter at metadata tier', () => {
    const event = journalEvent('stats.run_record', 'r1', { pipeline: 'p', outcome: 'completed', transcript: SECRETS.response });
    const filtered = filterEventForTier(event, 'metadata') as Record<string, unknown>;
    expect(JSON.stringify(filtered)).not.toContain(SECRETS.response);
    expect((filtered.data as Record<string, unknown>).outcome).toBe('completed');
  });
});
