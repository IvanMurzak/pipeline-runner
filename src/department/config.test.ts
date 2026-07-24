import { describe, expect, test } from 'bun:test';
import { CaptureLogger } from '../../tests/_helpers';
import { parseDepartmentRuntimesEnv } from './config';

describe('parseDepartmentRuntimesEnv', () => {
  test('unset/blank fails closed to an empty map', () => {
    expect(parseDepartmentRuntimesEnv(undefined).size).toBe(0);
    expect(parseDepartmentRuntimesEnv('').size).toBe(0);
    expect(parseDepartmentRuntimesEnv('   ').size).toBe(0);
  });

  test('invalid JSON fails closed and logs a warning', () => {
    const logger = new CaptureLogger();
    const map = parseDepartmentRuntimesEnv('{not json', logger);
    expect(map.size).toBe(0);
    expect(logger.lines.some((l) => l.includes('warn:') && l.includes('not valid JSON'))).toBe(true);
  });

  test('a well-formed entry parses with defaults applied by the adapter, not here', () => {
    const map = parseDepartmentRuntimesEnv(
      JSON.stringify({
        'unity-department': { adapterId: 'jsonl-process', command: 'unity-department', args: ['--stdio'], lifecycle: 'per-context' },
      })
    );
    expect(map.get('unity-department')).toEqual({
      adapterId: 'jsonl-process',
      command: 'unity-department',
      args: ['--stdio'],
      lifecycle: 'per-context',
    });
  });

  test('an entry missing command is skipped, others still parse', () => {
    const logger = new CaptureLogger();
    const map = parseDepartmentRuntimesEnv(
      JSON.stringify({
        broken: { adapterId: 'jsonl-process' },
        ok: { adapterId: 'jsonl-process', command: 'ok-department' },
      }),
      logger
    );
    expect(map.has('broken')).toBe(false);
    expect(map.get('ok')?.command).toBe('ok-department');
    expect(logger.lines.some((l) => l.includes("entry 'broken'"))).toBe(true);
  });

  test('an unrecognized lifecycle value is dropped, not passed through', () => {
    const map = parseDepartmentRuntimesEnv(JSON.stringify({ d: { adapterId: 'jsonl-process', command: 'd', lifecycle: 'forever' } }));
    expect(map.get('d')?.lifecycle).toBeUndefined();
  });

  test('parkExpirySeconds parses alongside gracefulShutdownSeconds (d2)', () => {
    const map = parseDepartmentRuntimesEnv(
      JSON.stringify({ d: { adapterId: 'jsonl-process', command: 'd', gracefulShutdownSeconds: 20, parkExpirySeconds: 3600 } })
    );
    expect(map.get('d')?.gracefulShutdownSeconds).toBe(20);
    expect(map.get('d')?.parkExpirySeconds).toBe(3600);
  });

  test('a non-numeric parkExpirySeconds is dropped, not passed through', () => {
    const map = parseDepartmentRuntimesEnv(JSON.stringify({ d: { adapterId: 'jsonl-process', command: 'd', parkExpirySeconds: 'a week' } }));
    expect(map.get('d')?.parkExpirySeconds).toBeUndefined();
  });
});
