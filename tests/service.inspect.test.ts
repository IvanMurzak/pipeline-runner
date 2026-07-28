/**
 * x22 — `inspectInstalledService`: the read-only look at the INSTALLED service
 * definition that `pipeline-runner journal` uses to find a journal owned by
 * another OS account.
 *
 * This is the capability the plugin's mirrored resolver structurally cannot
 * have. `pipeline department status` mirrors this package's path knowledge and
 * resolves the data dir as the INVOKING user; when `serve` installs a Windows
 * service it runs as `LocalSystem`, whose `%LOCALAPPDATA%` is not the user's,
 * so the mirror looks in the right place for the wrong account, finds nothing,
 * and renders `?` for every task. Reading the definition answers both halves of
 * why — the home it was pinned to, and the account it runs as.
 *
 * Everything here must also be TOTAL: a caller asked about a journal, not about
 * a service, and may never fail because this could not answer.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeExec, FakeServiceFs } from './_service-helpers';
import {
  inspectInstalledService,
  isSystemAccount,
  parseHomeFromCommandLine,
  parseHomeFromPlist,
  parseScField,
} from '../src/service/inspect';
import { renderLaunchdPlist, renderSystemdUnit } from '../src/service';
import { buildServicePlan } from '../src/service/plan';

const LINUX_ENV = { HOME: '/home/ada', XDG_CONFIG_HOME: '/home/ada/.config' };
const UNIT_PATH = join('/home/ada/.config', 'systemd', 'user', 'pipeline-runner.service');
const MAC_ENV = { HOME: '/Users/ada' };
const PLIST_PATH = join('/Users/ada', 'Library', 'LaunchAgents', 'com.ivanmurzak.pipeline-runner.plist');
const WIN_ENV = { APPDATA: join('C:', 'Users', 'ada', 'AppData', 'Roaming') };

describe('parsing a pinned --home out of a rendered definition', () => {
  test('plain argv', () => {
    expect(parseHomeFromCommandLine('/usr/bin/bun /pkg/src/cli.ts start --home /srv/runner')).toBe('/srv/runner');
  });

  test('a quoted path with spaces survives intact (the Windows binPath case)', () => {
    expect(parseHomeFromCommandLine('"C:\\Program Files\\bun.exe" "C:\\pkg\\cli.ts" start --home "C:\\Run ner\\home"')).toBe(
      'C:\\Run ner\\home',
    );
  });

  test('no --home at all is null, not an empty string', () => {
    expect(parseHomeFromCommandLine('/usr/bin/bun /pkg/src/cli.ts start')).toBeNull();
  });

  test('a trailing --home with nothing after it is null, never an empty home', () => {
    expect(parseHomeFromCommandLine('/usr/bin/bun cli.ts start --home')).toBeNull();
  });

  test('it reads back what THIS package renders — systemd', () => {
    // The round trip is the point: `resolveInvocation` writes the flag and this
    // reads it, so a change to either side has to break a test.
    const plan = buildServicePlan({ home: '/srv/runner one' }, 'linux', LINUX_ENV);
    const execStart = /^ExecStart=(.*)$/m.exec(renderSystemdUnit(plan))?.[1] ?? '';
    expect(parseHomeFromCommandLine(execStart)).toBe('/srv/runner one');
  });

  test('it reads back what THIS package renders — launchd', () => {
    const plan = buildServicePlan({ home: '/srv/runner' }, 'darwin', MAC_ENV);
    expect(parseHomeFromPlist(renderLaunchdPlist(plan, MAC_ENV))).toBe('/srv/runner');
  });

  test('a plist with no --home is null', () => {
    const plan = buildServicePlan({}, 'darwin', MAC_ENV);
    expect(parseHomeFromPlist(renderLaunchdPlist(plan, MAC_ENV))).toBeNull();
  });
});

describe('sc qc field parsing + machine accounts', () => {
  const QC = [
    '[SC] QueryServiceConfig SUCCESS',
    '',
    'SERVICE_NAME: pipeline-runner',
    '        TYPE               : 10  WIN32_OWN_PROCESS',
    '        START_TYPE         : 2   AUTO_START',
    '        BINARY_PATH_NAME   : "C:\\bun\\bun.exe" "C:\\pkg\\src\\cli.ts" start --home C:\\srv\\runner',
    '        DISPLAY_NAME       : Pipeline Runner',
    '        SERVICE_START_NAME : LocalSystem',
  ].join('\n');

  test('pulls the binary path and the account', () => {
    expect(parseScField(QC, 'SERVICE_START_NAME')).toBe('LocalSystem');
    expect(parseHomeFromCommandLine(parseScField(QC, 'BINARY_PATH_NAME')!)).toBe('C:\\srv\\runner');
  });

  test('an absent field is null', () => {
    expect(parseScField(QC, 'NOT_A_FIELD')).toBeNull();
  });

  test.each([
    ['LocalSystem', true],
    ['NT AUTHORITY\\SYSTEM', true],
    ['NT AUTHORITY\\LocalService', true],
    ['NT AUTHORITY\\NetworkService', true],
    ['localsystem', true],
    ['.\\ada', false],
    ['DOMAIN\\ada', false],
  ])('isSystemAccount(%s) === %s', (account, expected) => {
    expect(isSystemAccount(account as string)).toBe(expected);
  });
});

describe('inspectInstalledService — per backend', () => {
  test('systemd: reads the unit and reports that a --user unit runs as its installer', () => {
    const plan = buildServicePlan({ home: '/srv/runner' }, 'linux', LINUX_ENV);
    const fs = new FakeServiceFs().seed(UNIT_PATH, renderSystemdUnit(plan));
    const o = inspectInstalledService({ platform: 'linux', env: LINUX_ENV, fs, exec: new FakeExec() });
    expect(o).toMatchObject({ backend: 'systemd', installed: true, home: '/srv/runner', account: null, systemAccount: false });
    expect(o.note).toContain('installed it');
  });

  test('systemd: no unit file ⇒ installed false, with the path it looked at', () => {
    const o = inspectInstalledService({ platform: 'linux', env: LINUX_ENV, fs: new FakeServiceFs(), exec: new FakeExec() });
    expect(o).toMatchObject({ backend: 'systemd', installed: false, home: null });
    expect(o.note).toContain(UNIT_PATH);
  });

  test('launchd: reads the plist', () => {
    const plan = buildServicePlan({ home: '/srv/runner' }, 'darwin', MAC_ENV);
    const fs = new FakeServiceFs().seed(PLIST_PATH, renderLaunchdPlist(plan, MAC_ENV));
    const o = inspectInstalledService({ platform: 'darwin', env: MAC_ENV, fs, exec: new FakeExec() });
    expect(o).toMatchObject({ backend: 'launchd', installed: true, home: '/srv/runner', systemAccount: false });
  });

  test('windows: LocalSystem is reported AND flagged — this is the x22 case', () => {
    const exec = new FakeExec(() => ({
      stdout: 'BINARY_PATH_NAME   : "C:\\bun.exe" "C:\\cli.ts" start\nSERVICE_START_NAME : LocalSystem',
    }));
    const o = inspectInstalledService({ platform: 'win32', env: WIN_ENV, exec, fs: new FakeServiceFs() });
    expect(o).toMatchObject({ backend: 'windows', installed: true, account: 'LocalSystem', systemAccount: true, home: null });
    expect(exec.sequence).toEqual(['sc.exe qc pipeline-runner']);
  });

  test('windows: an ordinary user account is NOT flagged as a machine account', () => {
    const exec = new FakeExec(() => ({ stdout: 'SERVICE_START_NAME : DOMAIN\\ada' }));
    const o = inspectInstalledService({ platform: 'win32', env: WIN_ENV, exec, fs: new FakeServiceFs() });
    expect(o).toMatchObject({ account: 'DOMAIN\\ada', systemAccount: false });
  });

  test('windows: 1060 (no such service) is installed:false, not a crash', () => {
    const exec = new FakeExec(() => ({ code: 1060, stderr: 'The specified service does not exist' }));
    const o = inspectInstalledService({ platform: 'win32', env: WIN_ENV, exec, fs: new FakeServiceFs() });
    expect(o).toMatchObject({ backend: 'windows', installed: false });
  });

  test('a named instance inspects THAT instance (D17), not the default one', () => {
    const exec = new FakeExec(() => ({ stdout: 'SERVICE_START_NAME : LocalSystem' }));
    inspectInstalledService({ platform: 'win32', env: WIN_ENV, exec, fs: new FakeServiceFs(), name: 'alpha' });
    expect(exec.sequence).toEqual(['sc.exe qc pipeline-runner@alpha']);
  });
});

describe('inspectInstalledService — total, never fatal', () => {
  test('an unsupported platform answers instead of throwing', () => {
    const o = inspectInstalledService({ platform: 'aix', env: LINUX_ENV, fs: new FakeServiceFs(), exec: new FakeExec() });
    expect(o).toMatchObject({ backend: null, installed: false });
    expect(o.note).toContain('aix');
  });

  test('an unresolvable plan (no HOME at all) answers instead of throwing', () => {
    const o = inspectInstalledService({ platform: 'linux', env: {}, fs: new FakeServiceFs(), exec: new FakeExec() });
    expect(o.installed).toBe(false);
    expect(o.note).not.toBeNull();
  });

  test('an fs that throws is swallowed into a stated note', () => {
    const fs = new FakeServiceFs();
    fs.readFileText = () => {
      throw new Error('disk on fire');
    };
    const o = inspectInstalledService({
      platform: 'linux',
      env: LINUX_ENV,
      fs,
      exec: new FakeExec(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    expect(o.installed).toBe(false);
    expect(o.note).toContain('disk on fire');
  });

  test('a bad instance name is refused by the plan, not by a crash in the caller', () => {
    const o = inspectInstalledService({
      platform: 'linux',
      env: LINUX_ENV,
      fs: new FakeServiceFs(),
      exec: new FakeExec(),
      name: 'not a valid name',
    });
    expect(o.installed).toBe(false);
    expect(o.note).toContain('invalid instance name');
  });
});
