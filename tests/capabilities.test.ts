import { describe, expect, test } from 'bun:test';
import { detectCapabilities, ISOLATION_TIERS, narrowRunnerCapabilities, type RunnerCapabilities } from '../src/core/capabilities';

describe('detectCapabilities', () => {
  test('defaults: process-only isolation, gpu false, injected platform/hardware', () => {
    const caps = detectCapabilities({ platform: 'linux', cpuCount: 8, totalMemoryBytes: 16 * 1024 * 1024 * 1024 });
    expect(caps).toEqual({
      isolation: ['process'],
      gpu: false,
      os: 'linux',
      resources: { cpu_count: 8, total_memory_mb: 16 * 1024 },
    });
  });

  test('gpu is operator-declared via the gpu input', () => {
    expect(detectCapabilities({ gpu: true, platform: 'win32' }).gpu).toBe(true);
    expect(detectCapabilities({ gpu: false, platform: 'win32' }).gpu).toBe(false);
  });

  test('os maps through detectOs', () => {
    expect(detectCapabilities({ platform: 'win32' }).os).toBe('windows');
    expect(detectCapabilities({ platform: 'darwin' }).os).toBe('darwin');
    expect(detectCapabilities({ platform: 'linux' }).os).toBe('linux');
  });

  test('isolation is overridable (future container tier, d8) but defaults to process-only', () => {
    expect(detectCapabilities().isolation).toEqual(['process']);
    expect(detectCapabilities({ isolation: ['process', 'container'] }).isolation).toEqual(['process', 'container']);
  });

  test('resources round total memory to whole MiB', () => {
    const caps = detectCapabilities({ totalMemoryBytes: 1_500_000, cpuCount: 1 });
    expect(caps.resources.total_memory_mb).toBe(Math.round(1_500_000 / (1024 * 1024)));
  });

  test('falls back to the real machine when nothing is injected (still returns a well-formed shape)', () => {
    const caps = detectCapabilities();
    expect(caps.isolation).toEqual(['process']);
    expect(typeof caps.gpu).toBe('boolean');
    expect(typeof caps.os).toBe('string');
    expect(caps.resources.cpu_count).toBeGreaterThan(0);
    expect(caps.resources.total_memory_mb).toBeGreaterThan(0);
  });
});

describe('ISOLATION_TIERS', () => {
  test('is exactly [process, container] — container reserved for task d8', () => {
    expect([...ISOLATION_TIERS]).toEqual(['process', 'container']);
  });
});

describe('narrowRunnerCapabilities (tolerant load from disk)', () => {
  const valid: RunnerCapabilities = {
    isolation: ['process'],
    gpu: true,
    os: 'linux',
    resources: { cpu_count: 4, total_memory_mb: 8192 },
  };

  test('round-trips a well-formed capabilities object', () => {
    expect(narrowRunnerCapabilities(valid)).toEqual(valid);
  });

  test('undefined/null/non-object/array all narrow to undefined', () => {
    expect(narrowRunnerCapabilities(undefined)).toBeUndefined();
    expect(narrowRunnerCapabilities(null)).toBeUndefined();
    expect(narrowRunnerCapabilities('nope')).toBeUndefined();
    expect(narrowRunnerCapabilities([])).toBeUndefined();
  });

  test('missing/malformed required fields narrow to undefined', () => {
    expect(narrowRunnerCapabilities({ ...valid, isolation: 'process' })).toBeUndefined();
    expect(narrowRunnerCapabilities({ ...valid, gpu: 'yes' })).toBeUndefined();
    expect(narrowRunnerCapabilities({ ...valid, os: 5 })).toBeUndefined();
    expect(narrowRunnerCapabilities({ ...valid, resources: undefined })).toBeUndefined();
    expect(narrowRunnerCapabilities({ ...valid, resources: { cpu_count: 4 } })).toBeUndefined();
  });

  test('filters unknown isolation tier values rather than rejecting the whole object', () => {
    const withJunk = { ...valid, isolation: ['process', 'quantum', 'container'] };
    expect(narrowRunnerCapabilities(withJunk)?.isolation).toEqual(['process', 'container']);
  });
});
