import { describe, expect, test } from 'bun:test';
import { CaptureLogger } from '../../tests/_helpers';
import {
  DEFAULT_QUARANTINE_GC_MS,
  parseRetentionDuration,
  quarantineGcMs,
  resolveRetentionPolicy,
} from './retention';

describe('parseRetentionDuration', () => {
  test('units: ms/s/m/h/d, plain number = seconds', () => {
    expect(parseRetentionDuration('500ms')).toBe(500);
    expect(parseRetentionDuration('45s')).toBe(45_000);
    expect(parseRetentionDuration('15m')).toBe(900_000);
    expect(parseRetentionDuration('12h')).toBe(43_200_000);
    expect(parseRetentionDuration('7d')).toBe(604_800_000);
    expect(parseRetentionDuration('30')).toBe(30_000);
    expect(parseRetentionDuration(' 3D ')).toBe(3 * 86_400_000); // case/space tolerant
  });

  test('garbage → null', () => {
    expect(parseRetentionDuration('soon')).toBeNull();
    expect(parseRetentionDuration('-5m')).toBeNull();
    expect(parseRetentionDuration('')).toBeNull();
  });
});

describe('resolveRetentionPolicy (D15 env contract)', () => {
  test('default: immediate delete (the E6 fix)', () => {
    expect(resolveRetentionPolicy({})).toEqual({ keepForever: false, retentionMs: null });
  });

  test('PIPELINE_RUNNER_WORKSPACE_RETENTION sets the window', () => {
    expect(resolveRetentionPolicy({ PIPELINE_RUNNER_WORKSPACE_RETENTION: '3d' })).toEqual({
      keepForever: false,
      retentionMs: 3 * 86_400_000,
    });
  });

  test('PIPELINE_RUNNER_KEEP_WORKSPACES=1 = infinite, and wins over a window', () => {
    expect(
      resolveRetentionPolicy({ PIPELINE_RUNNER_KEEP_WORKSPACES: '1', PIPELINE_RUNNER_WORKSPACE_RETENTION: '3d' })
    ).toEqual({ keepForever: true, retentionMs: null });
  });

  test('unparseable retention warns and falls back to immediate delete', () => {
    const logger = new CaptureLogger();
    expect(resolveRetentionPolicy({ PIPELINE_RUNNER_WORKSPACE_RETENTION: 'whenever' }, logger)).toEqual({
      keepForever: false,
      retentionMs: null,
    });
    expect(logger.joined()).toContain('unparseable');
  });
});

describe('quarantineGcMs', () => {
  test('default 14d; an operator retention LONGER than that governs', () => {
    expect(quarantineGcMs({ keepForever: false, retentionMs: null })).toBe(DEFAULT_QUARANTINE_GC_MS);
    expect(quarantineGcMs({ keepForever: false, retentionMs: 60_000 })).toBe(DEFAULT_QUARANTINE_GC_MS);
    expect(quarantineGcMs({ keepForever: false, retentionMs: 30 * 86_400_000 })).toBe(30 * 86_400_000);
  });
});
