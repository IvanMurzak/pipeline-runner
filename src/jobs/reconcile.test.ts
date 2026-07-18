import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { MemShipperFs } from '../../tests/_shipper-helpers';
import { makeProbe, makeRecord } from './_helpers';
import {
  claudeTranscriptPath,
  classifyRecord,
  encodeClaudeProjectDir,
  fsSubstrateProbe,
} from './reconcile';

const NOW = Date.parse('2026-01-01T00:01:00.000Z'); // records' updated_at + 60s

describe('classifyRecord — the 04 classification matrix', () => {
  test('checkout missing → UNRECOVERABLE', () => {
    const verdict = classifyRecord(makeRecord(), NOW, makeProbe({ checkoutExists: () => false }));
    expect(verdict).toEqual({ kind: 'unrecoverable', reason: 'checkout missing' });
  });

  test('crashed during prep (no pipeline_root recorded) → UNRECOVERABLE (fresh attempt is correct)', () => {
    const record = makeRecord({ phase: 'preparing', pipeline_root: null, start_iteration: null });
    const verdict = classifyRecord(record, NOW, makeProbe());
    expect(verdict.kind).toBe('unrecoverable');
  });

  test('next.json missing → UNRECOVERABLE', () => {
    const verdict = classifyRecord(makeRecord(), NOW, makeProbe({ nextJsonExists: () => false }));
    expect(verdict).toEqual({ kind: 'unrecoverable', reason: 'next.json missing' });
  });

  test('pinned step-session transcript missing → UNRECOVERABLE', () => {
    const verdict = classifyRecord(makeRecord(), NOW, makeProbe({ transcriptsPresent: () => false }));
    expect(verdict.kind).toBe('unrecoverable');
    expect((verdict as { reason: string }).reason).toContain('transcript');
  });

  test('substrate intact + younger than TTL → FRESH (resume now)', () => {
    // updated_at 60s ago, TTL 90s.
    expect(classifyRecord(makeRecord(), NOW, makeProbe())).toEqual({ kind: 'fresh' });
  });

  test('substrate intact + older than TTL → STALE (quarantine)', () => {
    const record = makeRecord({ lease_ttl_s: 30 }); // updated_at 60s ago > 30s TTL
    expect(classifyRecord(record, NOW, makeProbe())).toEqual({ kind: 'stale' });
  });

  test('exactly at the TTL boundary → STALE (strict <)', () => {
    const record = makeRecord({ lease_ttl_s: 60 });
    expect(classifyRecord(record, NOW, makeProbe())).toEqual({ kind: 'stale' });
  });

  test('unparseable updated_at → STALE (never resume optimistically)', () => {
    const record = makeRecord({ updated_at: 'not-a-date' });
    expect(classifyRecord(record, NOW, makeProbe())).toEqual({ kind: 'stale' });
  });

  test('phase matrix: paused and awaiting_input classify like running (substrate-driven, not phase-driven)', () => {
    for (const phase of ['running', 'paused_provider_limit', 'awaiting_input'] as const) {
      expect(classifyRecord(makeRecord({ phase }), NOW, makeProbe())).toEqual({ kind: 'fresh' });
      expect(classifyRecord(makeRecord({ phase, lease_ttl_s: 10 }), NOW, makeProbe())).toEqual({ kind: 'stale' });
    }
  });
});

describe('claude transcript path encoding (step-transcripts rule)', () => {
  test('every non-alphanumeric character becomes a dash', () => {
    expect(encodeClaudeProjectDir('C:\\w\\job-1')).toBe('C--w-job-1');
    expect(encodeClaudeProjectDir('/home/ivan/jobs/job_1.x')).toBe('-home-ivan-jobs-job-1-x');
  });

  test('transcript path is home-scoped: ~/.claude/projects/<encoded cwd>/<session>.jsonl', () => {
    expect(claudeTranscriptPath('/home/u', '/w/job-1', 'sess-9')).toBe(
      join('/home/u', '.claude', 'projects', '-w-job-1', 'sess-9.jsonl')
    );
  });
});

describe('fsSubstrateProbe — the real-layout probe over the fs seam', () => {
  const HOME = '/home/u';
  const record = makeRecord(); // checkout /w/job-old, root /w/job-old/.claude/pipeline/release
  const runtime = join('/w/job-old/.claude/pipeline/release', '.runtime', 'run-1');

  function seededFs(): MemShipperFs {
    const fs = new MemShipperFs();
    fs.mkdirp(record.checkout_dir);
    fs.writeFileText(join(runtime, 'next.json'), '{}');
    return fs;
  }

  test('all present, no sessions dir → recoverable (transcripts vacuously true)', () => {
    const probe = fsSubstrateProbe(seededFs(), HOME);
    expect(probe.checkoutExists(record)).toBe(true);
    expect(probe.nextJsonExists(record)).toBe(true);
    expect(probe.transcriptsPresent(record)).toBe(true);
  });

  test('running session with its transcript on disk → present', () => {
    const fs = seededFs();
    fs.writeFileText(join(runtime, 'sessions', '02-deploy.json'), JSON.stringify({ session_id: 's1', status: 'running' }));
    fs.writeFileText(claudeTranscriptPath(HOME, record.checkout_dir, 's1'), '{}');
    expect(fsSubstrateProbe(fs, HOME).transcriptsPresent(record)).toBe(true);
  });

  test('running session whose transcript was cleaned up → missing', () => {
    const fs = seededFs();
    fs.writeFileText(join(runtime, 'sessions', '02-deploy.json'), JSON.stringify({ session_id: 's1', status: 'running' }));
    expect(fsSubstrateProbe(fs, HOME).transcriptsPresent(record)).toBe(false);
  });

  test('CONCURRENT LAYER: several running sessions — ALL transcripts must exist', () => {
    const fs = seededFs();
    fs.writeFileText(join(runtime, 'sessions', '03-a.json'), JSON.stringify({ session_id: 'sa', status: 'running' }));
    fs.writeFileText(join(runtime, 'sessions', '03-b.json'), JSON.stringify({ session_id: 'sb', status: 'running' }));
    fs.writeFileText(claudeTranscriptPath(HOME, record.checkout_dir, 'sa'), '{}');
    // sb's transcript is gone.
    expect(fsSubstrateProbe(fs, HOME).transcriptsPresent(record)).toBe(false);
    fs.writeFileText(claudeTranscriptPath(HOME, record.checkout_dir, 'sb'), '{}');
    expect(fsSubstrateProbe(fs, HOME).transcriptsPresent(record)).toBe(true);
  });

  test('awaiting-input session needs its transcript too (the answer resumes THAT session)', () => {
    const fs = seededFs();
    fs.writeFileText(join(runtime, 'sessions', '02.json'), JSON.stringify({ session_id: 's1', status: 'awaiting-input' }));
    expect(fsSubstrateProbe(fs, HOME).transcriptsPresent(record)).toBe(false);
  });

  test('done sessions do not require a transcript', () => {
    const fs = seededFs();
    fs.writeFileText(join(runtime, 'sessions', '01.json'), JSON.stringify({ session_id: 's0', status: 'done' }));
    expect(fsSubstrateProbe(fs, HOME).transcriptsPresent(record)).toBe(true);
  });

  test('a malformed session file is broken substrate — never resume over a guess', () => {
    const fs = seededFs();
    fs.writeFileText(join(runtime, 'sessions', '02.json'), '{not json');
    expect(fsSubstrateProbe(fs, HOME).transcriptsPresent(record)).toBe(false);
  });

  test('null pipeline_root → next.json and transcripts both report missing', () => {
    const bare = makeRecord({ pipeline_root: null });
    const probe = fsSubstrateProbe(seededFs(), HOME);
    expect(probe.nextJsonExists(bare)).toBe(false);
    expect(probe.transcriptsPresent(bare)).toBe(false);
  });
});
