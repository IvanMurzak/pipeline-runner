/**
 * `.stats` folding seam tests: the disk source walks the stats layout
 * (skipping per-run `runs/` log dirs), the journal→stats-dir derivation, and
 * the synthetic event shape.
 */

import { describe, expect, test } from 'bun:test';
import { DiskStatsSource, isTerminalEventType, statsDirForJournal, statsRecordEvent } from '../src/shipper/stats';
import { MemShipperFs } from './_shipper-helpers';

const STATS_DIR = 'C:/proj/.claude/pipeline/.stats';

describe('DiskStatsSource', () => {
  test('finds the newest matching record across nested runs.jsonl files, skipping runs/ dirs and garbage lines', () => {
    const fs = new MemShipperFs();
    fs.appendText(
      `${STATS_DIR}/workflows/release/runs.jsonl`,
      JSON.stringify({ schema: 1, run_id: 'run-A', outcome: 'failed' }) +
        '\n' +
        'garbage-not-json\n' +
        JSON.stringify({ schema: 1, run_id: 'run-A', outcome: 'completed' }) + // newer wins
        '\n' +
        JSON.stringify({ schema: 1, run_id: 'run-B', outcome: 'completed' }) +
        '\n'
    );
    // A per-run log dir that must NOT be scanned for records.
    fs.appendText(`${STATS_DIR}/workflows/release/runs/run-A.log`, 'human log text');

    const source = new DiskStatsSource(fs, STATS_DIR);
    expect(source.findRunRecord('run-A')).toEqual({ schema: 1, run_id: 'run-A', outcome: 'completed' });
    expect(source.findRunRecord('run-B')).toEqual({ schema: 1, run_id: 'run-B', outcome: 'completed' });
    expect(source.findRunRecord('run-C')).toBeNull();
  });

  test('a missing stats dir finds nothing', () => {
    const source = new DiskStatsSource(new MemShipperFs(), STATS_DIR);
    expect(source.findRunRecord('run-A')).toBeNull();
  });
});

describe('stats helpers', () => {
  test('statsDirForJournal derives the sibling .stats dir from the journal path', () => {
    expect(statsDirForJournal('C:/proj/.claude/pipeline/.runtime/events.jsonl').replace(/\\/g, '/')).toBe(
      'C:/proj/.claude/pipeline/.stats'
    );
    expect(statsDirForJournal('/home/u/p/.claude/pipeline/.runtime/events.jsonl').replace(/\\/g, '/')).toBe(
      '/home/u/p/.claude/pipeline/.stats'
    );
  });

  test('terminal event taxonomy matches the run-lifecycle framing (G4/G6)', () => {
    for (const type of ['run.completed', 'run.halted', 'pipeline.completed', 'pipeline.halted']) {
      expect(isTerminalEventType(type)).toBe(true);
    }
    expect(isTerminalEventType('iteration.completed')).toBe(false);
    expect(isTerminalEventType(null)).toBe(false);
  });

  test('statsRecordEvent wraps the record as a journal-shaped shippable event', () => {
    const event = statsRecordEvent('run-A', { schema: 1, run_id: 'run-A', ended_at: '2026-07-11T13:00:00.000Z' }, 'C:/proj', 'fallback-ts');
    expect(event.type).toBe('stats.run_record');
    expect(event.run_id).toBe('run-A');
    expect(event.ts).toBe('2026-07-11T13:00:00.000Z'); // prefers the record's end time
    expect(event.project_root).toBe('C:/proj');
    expect(statsRecordEvent('r', {}, 'C:/proj', 'fallback-ts').ts).toBe('fallback-ts');
  });
});
