import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { defaultDataDir, ShipperFsError } from '../src/shipper/fs';

// defaultDataDir had no dedicated coverage before department-mesh d7 (D17)
// made it home-aware (mirroring core/config.ts's defaultConfigDir tests) —
// this locks in both the pre-existing OS-default behavior and the new
// PIPELINE_RUNNER_HOME override.
describe('defaultDataDir', () => {
  test('win32 uses %LOCALAPPDATA%', () => {
    const dir = defaultDataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32');
    expect(dir).toBe(join('C:\\Users\\u\\AppData\\Local', 'pipeline-runner'));
  });

  test('win32 falls back to %USERPROFILE%\\AppData\\Local', () => {
    const dir = defaultDataDir({ USERPROFILE: 'C:\\Users\\u' }, 'win32');
    expect(dir).toBe(join('C:\\Users\\u', 'AppData', 'Local', 'pipeline-runner'));
  });

  test('POSIX prefers $XDG_STATE_HOME', () => {
    const dir = defaultDataDir({ XDG_STATE_HOME: '/home/u/.state', HOME: '/home/u' }, 'linux');
    expect(dir).toBe(join('/home/u/.state', 'pipeline-runner'));
  });

  test('POSIX falls back to ~/.local/state', () => {
    const dir = defaultDataDir({ HOME: '/home/u' }, 'linux');
    expect(dir).toBe(join('/home/u', '.local', 'state', 'pipeline-runner'));
  });

  test('throws ShipperFsError when nothing is resolvable', () => {
    expect(() => defaultDataDir({}, 'linux')).toThrow(ShipperFsError);
    expect(() => defaultDataDir({}, 'win32')).toThrow(ShipperFsError);
  });

  // department-mesh d7 (D17): PIPELINE_RUNNER_HOME roots the data dir at
  // <home>/data — mirrors defaultConfigDir's <home>/config in core/config.ts.
  test('PIPELINE_RUNNER_HOME roots data dir at <home>/data, on every platform', () => {
    expect(defaultDataDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a' }, 'linux')).toBe(join('/srv/runner-a', 'data'));
    expect(defaultDataDir({ PIPELINE_RUNNER_HOME: 'C:\\homes\\a' }, 'win32')).toBe(join('C:\\homes\\a', 'data'));
  });

  test('PIPELINE_RUNNER_HOME wins even when the OS-default env vars are ALSO set', () => {
    const dir = defaultDataDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a', XDG_STATE_HOME: '/home/u/.state', HOME: '/home/u' }, 'linux');
    expect(dir).toBe(join('/srv/runner-a', 'data'));
  });

  test('a blank PIPELINE_RUNNER_HOME is treated as unset', () => {
    const dir = defaultDataDir({ PIPELINE_RUNNER_HOME: '  ', HOME: '/home/u' }, 'linux');
    expect(dir).toBe(join('/home/u', '.local', 'state', 'pipeline-runner'));
  });

  test('config dir and data dir for the SAME home never collide', () => {
    // Cross-check against core/config.ts's defaultConfigDir without importing
    // it here (keeps this file scoped to shipper/fs) — just the raw joins.
    const configDir = join('/srv/runner-a', 'config');
    const dataDir = defaultDataDir({ PIPELINE_RUNNER_HOME: '/srv/runner-a' }, 'linux');
    expect(dataDir).not.toBe(configDir);
    expect(dataDir).toBe(join('/srv/runner-a', 'data'));
  });
});
