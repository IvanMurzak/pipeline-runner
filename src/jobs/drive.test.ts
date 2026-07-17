import { describe, expect, test } from 'bun:test';
import {
  buildDriveArgs,
  classifyDriveOutcome,
  defaultProviderLimitDetector,
  parseDriveFinalJson,
} from './drive';
import { DRIVE_COMPLETED, DRIVE_HALTED, DRIVE_PROVIDER_LIMIT, driveAwaiting } from './_helpers';

const TARGET = { pipelineRoot: '/ws/.claude/pipeline/release', runId: 'run-1' };

describe('buildDriveArgs', () => {
  test('initial start', () => {
    expect(buildDriveArgs(TARGET, { kind: 'start', startIteration: 'steps/01-plan.md' })).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'run-1',
      '--start',
      'steps/01-plan.md',
      '--json',
    ]);
  });

  test('plain resume (pause / crash recovery re-entry)', () => {
    expect(buildDriveArgs(TARGET, { kind: 'resume' })).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'run-1',
      '--resume',
      '--json',
    ]);
  });

  test('answer delivery resumes the SAME iteration with --answer', () => {
    expect(buildDriveArgs(TARGET, { kind: 'answer', startIteration: 'steps/02-deploy.md', answer: 'host-a' })).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'run-1',
      '--resume',
      '--start',
      'steps/02-deploy.md',
      '--answer',
      'host-a',
      '--json',
    ]);
  });

  // T3-06: matrix-cell execution overrides ride as run-level drive defaults,
  // BEFORE the mode-specific flags, on every invocation.
  test('a matrix-cell model+effort override emits --default-model / --default-effort', () => {
    expect(
      buildDriveArgs(
        { ...TARGET, defaultModel: 'opus', defaultEffort: 'high' },
        { kind: 'start', startIteration: 'steps/01-plan.md' }
      )
    ).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'run-1',
      '--default-model',
      'opus',
      '--default-effort',
      'high',
      '--start',
      'steps/01-plan.md',
      '--json',
    ]);
  });

  test('a model-only override emits ONLY --default-model (partial override)', () => {
    expect(buildDriveArgs({ ...TARGET, defaultModel: 'sonnet' }, { kind: 'resume' })).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'run-1',
      '--default-model',
      'sonnet',
      '--resume',
      '--json',
    ]);
  });

  test('an effort-only override emits ONLY --default-effort (partial override)', () => {
    expect(buildDriveArgs({ ...TARGET, defaultEffort: 'max' }, { kind: 'resume' })).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'run-1',
      '--default-effort',
      'max',
      '--resume',
      '--json',
    ]);
  });

  test('overrides persist on an answer resume so the cell keeps its model+effort', () => {
    expect(
      buildDriveArgs(
        { ...TARGET, defaultModel: 'opus', defaultEffort: 'high' },
        { kind: 'answer', startIteration: 'steps/02-deploy.md', answer: 'host-a' }
      )
    ).toEqual([
      'drive',
      '--root',
      '/ws/.claude/pipeline/release',
      '--run-id',
      'run-1',
      '--default-model',
      'opus',
      '--default-effort',
      'high',
      '--resume',
      '--start',
      'steps/02-deploy.md',
      '--answer',
      'host-a',
      '--json',
    ]);
  });

  test('blank / whitespace override values emit no flag (byte-identical to no-override)', () => {
    const noFlags = buildDriveArgs(TARGET, { kind: 'resume' });
    expect(buildDriveArgs({ ...TARGET, defaultModel: '', defaultEffort: '   ' }, { kind: 'resume' })).toEqual(noFlags);
  });

  // env-variables design (task d1, D11 corollary): lease `variables` map to
  // `--var NAME=value` — but ONLY on the START invocation, never on
  // resume/answer (D11 makes --var on an already-frozen resume a loud exit-2
  // usage error; the runner must never trip it).
  describe('lease variables (env-variables d1)', () => {
    test('a START invocation emits one --var NAME=value per entry, sorted by name, each a single argv element', () => {
      const args = buildDriveArgs(
        { ...TARGET, variables: { PP_SERVICE: 'payments', PP_CHANNEL: '#releases' } },
        { kind: 'start', startIteration: 'steps/01-plan.md' }
      );
      expect(args).toEqual([
        'drive',
        '--root',
        '/ws/.claude/pipeline/release',
        '--run-id',
        'run-1',
        '--start',
        'steps/01-plan.md',
        '--var',
        'PP_CHANNEL=#releases',
        '--var',
        'PP_SERVICE=payments',
        '--json',
      ]);
    });

    test('a value containing spaces/metacharacters stays ONE argv element (no shell, no re-splitting)', () => {
      const args = buildDriveArgs(
        { ...TARGET, variables: { PP_SERVICE: 'hello world; rm -rf / && echo $(whoami)' } },
        { kind: 'start', startIteration: 'steps/01-plan.md' }
      );
      const varIndex = args.indexOf('--var');
      expect(varIndex).toBeGreaterThanOrEqual(0);
      expect(args[varIndex + 1]).toBe('PP_SERVICE=hello world; rm -rf / && echo $(whoami)');
      // Exactly two elements for this one entry — flag + single combined value.
      expect(args.filter((a) => a === '--var')).toHaveLength(1);
    });

    test('a PLAIN RESUME never carries --var even though the target still holds variables', () => {
      const args = buildDriveArgs({ ...TARGET, variables: { PP_SERVICE: 'payments' } }, { kind: 'resume' });
      expect(args).toEqual(['drive', '--root', '/ws/.claude/pipeline/release', '--run-id', 'run-1', '--resume', '--json']);
      expect(args).not.toContain('--var');
    });

    test('an ANSWER invocation never carries --var either', () => {
      const args = buildDriveArgs(
        { ...TARGET, variables: { PP_SERVICE: 'payments' } },
        { kind: 'answer', startIteration: 'steps/02-deploy.md', answer: 'host-a' }
      );
      expect(args).not.toContain('--var');
      expect(args).toEqual([
        'drive',
        '--root',
        '/ws/.claude/pipeline/release',
        '--run-id',
        'run-1',
        '--resume',
        '--start',
        'steps/02-deploy.md',
        '--answer',
        'host-a',
        '--json',
      ]);
    });

    test('an ABSENT variables map on a START invocation is byte-identical to today (regression)', () => {
      expect(buildDriveArgs(TARGET, { kind: 'start', startIteration: 'steps/01-plan.md' })).toEqual([
        'drive',
        '--root',
        '/ws/.claude/pipeline/release',
        '--run-id',
        'run-1',
        '--start',
        'steps/01-plan.md',
        '--json',
      ]);
    });

    test('an EMPTY variables map emits no --var flags', () => {
      const args = buildDriveArgs({ ...TARGET, variables: {} }, { kind: 'start', startIteration: 'steps/01-plan.md' });
      expect(args).not.toContain('--var');
    });

    test('variables ride alongside a matrix-cell execution override (both features compose)', () => {
      const args = buildDriveArgs(
        { ...TARGET, defaultModel: 'opus', variables: { PP_SERVICE: 'payments' } },
        { kind: 'start', startIteration: 'steps/01-plan.md' }
      );
      expect(args).toEqual([
        'drive',
        '--root',
        '/ws/.claude/pipeline/release',
        '--run-id',
        'run-1',
        '--default-model',
        'opus',
        '--start',
        'steps/01-plan.md',
        '--var',
        'PP_SERVICE=payments',
        '--json',
      ]);
    });
  });
});

describe('parseDriveFinalJson', () => {
  test('parses a clean pretty-printed object', () => {
    expect(parseDriveFinalJson('{\n  "status": "completed"\n}\n')).toEqual({ status: 'completed' });
  });

  test('tolerates stray output around the object', () => {
    expect(parseDriveFinalJson('leaked line\n{ "status": "halted" }\ntrailer')).toEqual({ status: 'halted' });
  });

  test('null on empty / non-JSON / non-object output', () => {
    expect(parseDriveFinalJson('')).toBeNull();
    expect(parseDriveFinalJson('no json here')).toBeNull();
    expect(parseDriveFinalJson('[1,2]')).toBeNull();
  });
});

describe('classifyDriveOutcome', () => {
  test('exit 0 → completed with the reported status', () => {
    expect(classifyDriveOutcome(DRIVE_COMPLETED)).toEqual({ kind: 'completed', outcome: 'completed' });
  });

  test('exit 0 without parseable JSON still completes', () => {
    expect(classifyDriveOutcome({ code: 0, stdout: '', stderr: '' })).toEqual({ kind: 'completed', outcome: 'completed' });
  });

  test('exit 1 → halted with the reported reason', () => {
    expect(classifyDriveOutcome(DRIVE_HALTED)).toEqual({ kind: 'halted', reason: 'step 02 halted: tests failed' });
  });

  test('exit 1 without a reason falls back to the status, then "halted"', () => {
    expect(classifyDriveOutcome({ code: 1, stdout: '{"status":"depth-exhausted"}', stderr: '' })).toEqual({
      kind: 'halted',
      reason: 'depth-exhausted',
    });
    expect(classifyDriveOutcome({ code: 1, stdout: '', stderr: '' })).toEqual({ kind: 'halted', reason: 'halted' });
  });

  test('exit 3 (blocked) maps to halted with the blocker pointer', () => {
    const result = {
      code: 3,
      stdout: '{"status":"blocked","blocker_record_file":"/ws/.runtime/run-1/records/step.json"}',
      stderr: '',
    };
    expect(classifyDriveOutcome(result)).toEqual({
      kind: 'halted',
      reason: 'blocked on a nested blocker (/ws/.runtime/run-1/records/step.json)',
    });
  });

  test('exit 4 → awaiting_input with the parked question narrowed', () => {
    const outcome = classifyDriveOutcome(driveAwaiting('steps/02-deploy.md', 'Which host?'));
    expect(outcome).toEqual({
      kind: 'awaiting_input',
      parked: {
        step_id: '02-deploy',
        iteration_path: 'steps/02-deploy.md',
        session_id: 'sess-1',
        question: { text: 'Which host?', context: 'ctx', options: ['a', 'b'] },
      },
    });
  });

  test('exit 4 without an iteration_path cannot resume → failed', () => {
    const outcome = classifyDriveOutcome({ code: 4, stdout: '{"status":"awaiting-input"}', stderr: '' });
    expect(outcome.kind).toBe('failed');
  });

  test('exit 4 with a malformed question still parks with a fallback text', () => {
    const outcome = classifyDriveOutcome({
      code: 4,
      stdout: '{"status":"awaiting-input","iteration_path":"steps/01.md","question":"not-an-object"}',
      stderr: '',
    });
    expect(outcome.kind).toBe('awaiting_input');
    if (outcome.kind === 'awaiting_input') {
      expect(outcome.parked.question.text).toContain('no question text');
      expect(outcome.parked.step_id).toBeNull();
    }
  });

  test('exit 2 → failed as a usage error with stderr detail', () => {
    const outcome = classifyDriveOutcome({ code: 2, stdout: '', stderr: 'pipeline drive: --start is required' });
    expect(outcome).toEqual({ kind: 'failed', reason: 'pipeline drive usage error (exit 2): pipeline drive: --start is required' });
  });

  test('an unknown exit code → failed', () => {
    expect(classifyDriveOutcome({ code: 137, stdout: '', stderr: '' })).toEqual({
      kind: 'failed',
      reason: 'pipeline drive exited 137',
    });
  });

  test('a spawn failure (code null) → failed with the spawn detail', () => {
    const outcome = classifyDriveOutcome({ code: null, stdout: '', stderr: '', error: 'spawn pipeline ENOENT' });
    expect(outcome).toEqual({ kind: 'failed', reason: 'pipeline drive did not run: spawn pipeline ENOENT' });
  });
});

describe('defaultProviderLimitDetector', () => {
  test('detects a usage-limit message on a non-zero exit', () => {
    expect(defaultProviderLimitDetector(DRIVE_PROVIDER_LIMIT)).toEqual({ reason: 'usage limit' });
  });

  test.each(['rate limit exceeded', 'RateLimit hit', 'overloaded_error', 'Too Many Requests'])(
    'detects %p',
    (text) => {
      expect(defaultProviderLimitDetector({ code: 1, stdout: '', stderr: text })).not.toBeNull();
    }
  );

  test('never fires on a completed run, even with limit-looking text', () => {
    expect(defaultProviderLimitDetector({ code: 0, stdout: 'discussed the usage limit design', stderr: '' })).toBeNull();
  });

  test('null on an unrelated failure', () => {
    expect(defaultProviderLimitDetector({ code: 1, stdout: '', stderr: 'tests failed' })).toBeNull();
  });
});
