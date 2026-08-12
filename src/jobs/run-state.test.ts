import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { MemShipperFs } from '../../tests/_shipper-helpers';
import {
  captureRunState,
  classifyCursorPortability,
  fsRunStateStore,
  MACHINE_LOCAL_CURSOR_FIELDS,
  PORTABLE_RUN_STATE_FILES,
  restoreRunState,
  runStateDir,
  type RunStateBundle,
} from './run-state';

const ROOT = '/w/job-1/.pipeline/release';
const RUN = 'run-1';
const NOW = '2026-01-01T00:00:00.000Z';
const RUNTIME = runStateDir(ROOT, RUN);
const CURSOR = JSON.stringify({ index: 2, phase: 'await-step', current_step_id: '03-test' });

/** A checkout mid-run: a cursor, two finished step sessions. */
function seeded(cursor = CURSOR): MemShipperFs {
  const fs = new MemShipperFs();
  fs.writeFileText(join(RUNTIME, 'next.json'), cursor);
  fs.writeFileText(join(RUNTIME, 'sessions', '01-plan.json'), JSON.stringify({ session_id: 's1', status: 'done' }));
  fs.writeFileText(join(RUNTIME, 'sessions', '02-build.json'), JSON.stringify({ session_id: 's2', status: 'done' }));
  return fs;
}

describe('the allowlist is positive, and names exactly one file', () => {
  test('only next.json travels — sessions/ is named as machine-local, not merely omitted', () => {
    expect([...PORTABLE_RUN_STATE_FILES]).toEqual(['next.json']);
  });

  test('every guarded cursor field is one that names an absolute path', () => {
    expect([...MACHINE_LOCAL_CURSOR_FIELDS]).toEqual([
      'worktree_path',
      'worktree_env_file',
      'worktree_pipeline_root',
      'main_pipeline_root',
    ]);
  });
});

describe('classifyCursorPortability — what may cross a machine boundary', () => {
  test('an ordinary sequential cursor is portable', () => {
    expect(classifyCursorPortability(CURSOR)).toEqual({ portable: true });
  });

  test('nulls are the normal value and do not block a handoff', () => {
    const cursor = JSON.stringify({ index: 1, worktree_path: null, worktree_env_file: null, worktree_provisioned: false });
    expect(classifyCursorPortability(cursor)).toEqual({ portable: true });
  });

  test('a provisioned run-level worktree is REFUSED — machine-local substrate', () => {
    const verdict = classifyCursorPortability(JSON.stringify({ index: 1, worktree_provisioned: true }));
    expect(verdict.portable).toBe(false);
    expect((verdict as { reason: string }).reason).toContain('worktree');
  });

  test.each([...MACHINE_LOCAL_CURSOR_FIELDS])('a non-null %s is REFUSED', (field) => {
    const verdict = classifyCursorPortability(JSON.stringify({ index: 1, [field]: '/machine-a/somewhere' }));
    expect(verdict.portable).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(field);
  });

  test('an unreadable cursor is REFUSED — never hand off a guess', () => {
    expect(classifyCursorPortability('{not json').portable).toBe(false);
    expect(classifyCursorPortability('[1,2,3]').portable).toBe(false);
  });
});

describe('captureRunState — the cursor, and nothing that belongs to this machine', () => {
  test('carries the cursor verbatim and no session id', () => {
    const captured = captureRunState({ pipelineRoot: ROOT, runId: RUN, nowIso: NOW }, seeded());
    expect(captured.bundle).not.toBeNull();
    expect(captured.bundle!.cursor).toBe(CURSOR);
    expect(captured.bundle!.captured_at).toBe(NOW);
    // The session ids exist on disk right next to the cursor and still do not
    // appear anywhere in the bundle.
    expect(JSON.stringify(captured.bundle)).not.toContain('s1');
    expect(JSON.stringify(captured.bundle)).not.toContain('s2');
  });

  test('no cursor yet ⇒ nothing published, with a reason rather than a silence', () => {
    const captured = captureRunState({ pipelineRoot: ROOT, runId: RUN, nowIso: NOW }, new MemShipperFs());
    expect(captured.bundle).toBeNull();
    expect((captured as { reason: string }).reason).toContain('cursor');
  });

  test('an interrupted step (session still `running`) IS portable — it simply re-runs there', () => {
    // This is D12's funding-failure shape: the step produced no record, so the
    // cursor still names it and the receiving machine dispatches it afresh.
    const fs = seeded();
    fs.writeFileText(join(RUNTIME, 'sessions', '03-test.json'), JSON.stringify({ session_id: 's3', status: 'running' }));
    const captured = captureRunState({ pipelineRoot: ROOT, runId: RUN, nowIso: NOW }, fs);
    expect(captured.bundle).not.toBeNull();
    expect(captured.bundle!.pending_question).toBe(false);
  });

  test('an outstanding question is FLAGGED, not carried — the step will ask again', () => {
    const fs = seeded();
    fs.writeFileText(join(RUNTIME, 'sessions', '03-test.json'), JSON.stringify({ session_id: 's3', status: 'awaiting-input' }));
    const captured = captureRunState({ pipelineRoot: ROOT, runId: RUN, nowIso: NOW }, fs);
    expect(captured.bundle!.pending_question).toBe(true);
    expect(JSON.stringify(captured.bundle)).not.toContain('s3');
  });

  test('a cursor that names machine-local paths is not published at all', () => {
    const fs = seeded(JSON.stringify({ index: 2, worktree_provisioned: true }));
    expect(captureRunState({ pipelineRoot: ROOT, runId: RUN, nowIso: NOW }, fs).bundle).toBeNull();
  });
});

describe('restoreRunState — into a fresh checkout on another machine', () => {
  const BUNDLE: RunStateBundle = { run_id: RUN, cursor: CURSOR, captured_at: NOW, pending_question: false };
  const ROOT_B = '/w2/job-2/.pipeline/release';

  test('writes the cursor and DOES NOT create sessions/ — its absence is the mechanism', () => {
    const fs = new MemShipperFs();
    expect(restoreRunState(BUNDLE, { pipelineRoot: ROOT_B, runId: RUN }, fs)).toEqual({
      restored: true,
      pending_question: false,
    });
    expect(fs.readFileText(join(runStateDir(ROOT_B, RUN), 'next.json'))).toBe(CURSOR);
    expect(fs.listDir(join(runStateDir(ROOT_B, RUN), 'sessions'))).toBeNull();
  });

  test('drops a gitignore so restored state never reaches the consumer commits', () => {
    const fs = new MemShipperFs();
    restoreRunState(BUNDLE, { pipelineRoot: ROOT_B, runId: RUN }, fs);
    expect(fs.readFileText(join(ROOT_B, '.runtime', '.gitignore'))).toBe('*\n');
  });

  test('REFUSES when this machine already holds run state — local state is authoritative', () => {
    const fs = new MemShipperFs();
    fs.writeFileText(join(runStateDir(ROOT_B, RUN), 'next.json'), JSON.stringify({ index: 9 }));
    const result = restoreRunState(BUNDLE, { pipelineRoot: ROOT_B, runId: RUN }, fs);
    expect(result.restored).toBe(false);
    // And the local cursor is untouched — no silent rewind.
    expect(fs.readFileText(join(runStateDir(ROOT_B, RUN), 'next.json'))).toBe(JSON.stringify({ index: 9 }));
  });

  test('REFUSES a bundle belonging to a different run', () => {
    const result = restoreRunState({ ...BUNDLE, run_id: 'other' }, { pipelineRoot: ROOT_B, runId: RUN }, new MemShipperFs());
    expect(result.restored).toBe(false);
    expect((result as { reason: string }).reason).toContain('other');
  });

  test('re-checks portability on the way IN, not only on the way out', () => {
    // The store is shared storage; a bundle can be tampered with or written by
    // an older runner. Trusting the capture-side check alone would be trusting
    // whatever is in the directory.
    const hostile: RunStateBundle = { ...BUNDLE, cursor: JSON.stringify({ worktree_provisioned: true }) };
    expect(restoreRunState(hostile, { pipelineRoot: ROOT_B, runId: RUN }, new MemShipperFs()).restored).toBe(false);
  });
});

describe('fsRunStateStore — the handoff transport', () => {
  test('publish → fetch → restore round-trips one run between two roots', () => {
    const fs = seeded();
    const store = fsRunStateStore(fs, '/shared/runState', () => Date.parse(NOW));
    expect(store.publish({ pipelineRoot: ROOT, runId: RUN }).bundle).not.toBeNull();

    const fetched = store.fetch(RUN);
    expect(fetched).not.toBeNull();
    expect(fetched!.cursor).toBe(CURSOR);
    expect(fetched!.captured_at).toBe(NOW);

    const other = '/w2/job-2/.pipeline/release';
    expect(store.restore(fetched!, { pipelineRoot: other, runId: RUN }).restored).toBe(true);
    expect(fs.readFileText(join(runStateDir(other, RUN), 'next.json'))).toBe(CURSOR);
  });

  test('fetch of a run that never moved is null, not a throw', () => {
    expect(fsRunStateStore(new MemShipperFs(), '/shared').fetch('nope')).toBeNull();
  });

  test('a corrupt or truncated bundle reads as absent — start clean, never guess', () => {
    const fs = new MemShipperFs();
    fs.writeFileText('/shared/run-1.json', '{"run_id":"run-1"'); // truncated
    expect(fsRunStateStore(fs, '/shared').fetch(RUN)).toBeNull();
    fs.writeFileText('/shared/run-1.json', JSON.stringify({ run_id: RUN })); // no cursor
    expect(fsRunStateStore(fs, '/shared').fetch(RUN)).toBeNull();
  });

  test('discard removes the bundle; a finished run cannot be picked up elsewhere', () => {
    const fs = seeded();
    const store = fsRunStateStore(fs, '/shared/runState');
    store.publish({ pipelineRoot: ROOT, runId: RUN });
    expect(store.fetch(RUN)).not.toBeNull();
    store.discard(RUN);
    expect(store.fetch(RUN)).toBeNull();
  });

  test('publishing a non-portable run writes NOTHING to shared storage', () => {
    const fs = seeded(JSON.stringify({ index: 2, worktree_provisioned: true }));
    const store = fsRunStateStore(fs, '/shared/runState');
    expect(store.publish({ pipelineRoot: ROOT, runId: RUN }).bundle).toBeNull();
    expect(store.fetch(RUN)).toBeNull();
  });
});
