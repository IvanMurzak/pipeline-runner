/**
 * READ-ONLY inspection of the INSTALLED service definition (simplified-
 * onboarding x22).
 *
 * `serviceStatus` answers "is it up?". This answers a different question that
 * nothing could ask before: **where was the supervisor told to live, and as
 * whom does it run?** Both facts are baked into the definition this package
 * itself generates — `../service/plan.ts`'s `resolveInvocation` appends
 * `--home <path>` to the argv (uniformly on all three backends, including
 * Windows, whose service definitions cannot carry environment variables) — and
 * both are invisible to anything that only knows the OS's path conventions.
 *
 * That is exactly x22's gap. `pipeline department status` renders `sender` and
 * `engine` from the runner's local journal, resolving the data dir AS THE
 * INVOKING USER; when the runner runs as a service under another OS account
 * (the shape `serve` installs, and on Windows `sc.exe create` with no `obj=`
 * means `LocalSystem`) it looks in the right place for the wrong account. This
 * module lets `../department/journal-read.ts` look in the RIGHT place when the
 * definition names one, and — when it cannot — say whose journal it is instead
 * of rendering an unexplained `?`.
 *
 * Everything here is BEST-EFFORT and total: every backend failure resolves to
 * "installed: false" plus a stated `note`. It mutates nothing, needs no
 * elevation (`sc qc` is a query; a unit file / plist is a plain read), and no
 * caller may fail because of it.
 */

import { consoleLogger, type Logger } from '../core/log';
import { launchdPlistPath } from './launchd';
import { buildServicePlan, type PlanInputs } from './plan';
import { systemdUnitPath } from './systemd';
import { nodeServiceExec, nodeServiceFs, type ServiceExec, type ServiceFs } from './types';

/**
 * What the installed definition says about itself. `null` everywhere a backend
 * genuinely cannot answer — never a guess.
 *
 * Structurally identical to `../department/journal-read.ts`'s
 * `SupervisorObservation`, which is its only consumer. The two are kept as
 * separate declarations on purpose: this module owns SERVICE knowledge and that
 * one owns the JSON contract, and neither should have to import the other's
 * whole world to name a shape they agree on.
 */
export interface InstalledServiceObservation {
  backend: string | null;
  installed: boolean;
  home: string | null;
  account: string | null;
  systemAccount: boolean;
  note: string | null;
}

/**
 * Windows machine accounts. The whole point of the case: their profile
 * directory — and therefore `%LOCALAPPDATA%`, and therefore the runner's data
 * dir — is not the invoking user's, so the journal is real, present, and
 * unreadable from an ordinary session.
 *
 * Matched case-insensitively and with the `NT AUTHORITY\` prefix optional,
 * because `sc qc` reports whichever spelling the service was created with.
 */
const SYSTEM_ACCOUNTS = ['localsystem', 'system', 'localservice', 'networkservice'];

/** True when `sc qc`'s SERVICE_START_NAME names a machine account. */
export function isSystemAccount(account: string): boolean {
  const bare = account.trim().replace(/^nt authority\\/i, '').replace(/^\.\\/, '').toLowerCase();
  return SYSTEM_ACCOUNTS.includes(bare) || bare === 'local system' || bare === 'local service' || bare === 'network service';
}

/**
 * Pull `--home <path>` out of a rendered argv/command line.
 *
 * Tolerant by construction: it is fed a systemd `ExecStart=` line, a plist's
 * `ProgramArguments` block, or an `sc qc` `BINARY_PATH_NAME`, and the only
 * thing those share is that a pinned home appears as the token `--home`
 * followed by the path. Quotes around either token are stripped; a `--home`
 * with nothing after it yields null rather than an empty home.
 */
export function parseHomeFromCommandLine(text: string): string | null {
  // Tokens are whitespace-separated except inside double quotes — the one
  // quoting rule all three renderings share (`systemdQuote` / `winQuote` /
  // XML text). A quoted path with spaces must survive intact.
  const tokens = text.match(/"[^"]*"|\S+/g);
  if (tokens === null) return null;
  const unquote = (t: string): string => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t);
  for (let i = 0; i < tokens.length; i++) {
    if (unquote(tokens[i]!) !== '--home') continue;
    const next = tokens[i + 1];
    if (next === undefined) return null;
    const value = unquote(next);
    return value.trim().length > 0 ? value : null;
  }
  return null;
}

/** Pull `--home <path>` out of a launchd plist's `ProgramArguments` array. */
export function parseHomeFromPlist(xml: string): string | null {
  const args = [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1] ?? '');
  for (let i = 0; i < args.length; i++) {
    if (args[i]?.trim() !== '--home') continue;
    const value = args[i + 1]?.trim();
    return value !== undefined && value.length > 0 ? value : null;
  }
  return null;
}

/** Pull one `KEY : value` field out of `sc qc` / `sc query` output. */
export function parseScField(stdout: string, field: string): string | null {
  const re = new RegExp(`^\\s*${field}\\s*:\\s*(.+)$`, 'im');
  const m = re.exec(stdout);
  const value = m?.[1]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

export interface InspectOptions extends PlanInputs {
  platform?: string;
  env?: Record<string, string | undefined>;
  exec?: ServiceExec;
  fs?: ServiceFs;
  logger?: Logger;
}

/**
 * Observe this machine's installed supervisor definition. Never throws.
 *
 * Note what each backend can and cannot say, because the asymmetry is the
 * finding rather than an omission:
 *
 *  - **systemd / launchd** install a PER-USER unit/agent, so the account is
 *    already the invoking one by construction and there is no other account to
 *    report. What they CAN carry is a pinned `--home`.
 *  - **Windows** installs a machine-wide service whose account is chosen at
 *    create time and defaults to `LocalSystem`. That is the case x22 is about,
 *    and `sc qc` reports it.
 */
export function inspectInstalledService(opts: InspectOptions = {}): InstalledServiceObservation {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? consoleLogger;
  let plan;
  try {
    plan = buildServicePlan(opts, platform, env);
  } catch (err) {
    return unobservable(null, `the service plan could not be resolved: ${text(err)}`);
  }

  try {
    if (platform === 'linux') {
      const fs = opts.fs ?? nodeServiceFs();
      const unitPath = systemdUnitPath(plan, env);
      const unit = fs.readFileText(unitPath);
      if (unit === null) return unobservable('systemd', `no user unit at ${unitPath}`);
      const execStart = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? '';
      return {
        backend: 'systemd',
        installed: true,
        home: parseHomeFromCommandLine(execStart),
        account: null,
        systemAccount: false,
        note: 'a systemd --user unit runs as the account that installed it',
      };
    }
    if (platform === 'darwin') {
      const fs = opts.fs ?? nodeServiceFs();
      const plistPath = launchdPlistPath(plan, env);
      const plist = fs.readFileText(plistPath);
      if (plist === null) return unobservable('launchd', `no LaunchAgent at ${plistPath}`);
      return {
        backend: 'launchd',
        installed: true,
        home: parseHomeFromPlist(plist),
        account: null,
        systemAccount: false,
        note: 'a LaunchAgent runs as the account that installed it',
      };
    }
    if (platform === 'win32') {
      const exec = opts.exec ?? nodeServiceExec();
      const name = plan.identity.serviceName;
      const qc = exec.run('sc.exe', ['qc', name]);
      const combined = `${qc.stdout}\n${qc.stderr}`;
      if (qc.code !== 0 || /1060|does not exist/i.test(combined)) {
        return unobservable('windows', `sc.exe qc ${name} reports no such service`);
      }
      const account = parseScField(qc.stdout, 'SERVICE_START_NAME');
      return {
        backend: 'windows',
        installed: true,
        home: parseHomeFromCommandLine(parseScField(qc.stdout, 'BINARY_PATH_NAME') ?? ''),
        account,
        systemAccount: account !== null && isSystemAccount(account),
        note: null,
      };
    }
    return unobservable(null, `no service backend for platform ${platform}`);
  } catch (err) {
    // Best-effort means best-effort: a caller asked about a journal, not about
    // a service, and must never fail because this could not answer.
    logger.warn(`could not inspect the installed service definition: ${text(err)}`);
    return unobservable(null, `the installed service could not be inspected: ${text(err)}`);
  }
}

function unobservable(backend: string | null, note: string): InstalledServiceObservation {
  return { backend, installed: false, home: null, account: null, systemAccount: false, note };
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
