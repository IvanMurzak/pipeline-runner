/**
 * The LOCAL department journal, read back — `pipeline-runner journal`
 * (simplified-onboarding x22).
 *
 * ## Why this file exists
 *
 * `b4` made the runner record, per admitted execution, who addressed the task
 * (`sender`) and which engine ran it (`engine`), and filed one line per
 * execution in a per-department index (`./events.ts`'s `departmentIndexPath`).
 * `x19` built the CONSUMER of that index — but in the `pipeline` CLI, a
 * separate package with no dependency on this one, which therefore has to
 * MIRROR this package's path knowledge and resolve the data dir **as the
 * invoking user** (`LOCALAPPDATA` / `XDG_STATE_HOME` / `HOME`).
 *
 * That is correct for a runner started by hand. It is wrong for the shape the
 * product actually steers users onto: `pipeline department serve` installs a
 * SERVICE, and on Windows `sc.exe create` with no `obj=` runs it as
 * `LocalSystem`, whose `%LOCALAPPDATA%` is
 * `C:\Windows\system32\config\systemprofile\AppData\Local` — nowhere near the
 * invoking user's. The mirror looks in the right place for the wrong account,
 * finds nothing, and `pipeline department status` honestly renders `?` for
 * every task on the happy path. Never wrong; uniformly unknown.
 *
 * This module is the read surface `x19`'s worker named as the fix: the fact
 * lives with its owner, and a caller asks for it over ARGV — the seam D26
 * already sanctions for exactly this ("another package shells out rather than
 * writing/reading this package's config store itself"). No npm dependency is
 * created in either direction.
 *
 * ## What it does about the different-account problem
 *
 * Being invoked by the `pipeline` CLI does not by itself change which account
 * the process runs as, so simply moving `x19`'s resolver here would move the
 * blind spot, not close it. Two things make this surface strictly better than
 * the mirror, and NEITHER of them is available to a package that only knows
 * path conventions:
 *
 *  1. **It can read the installed service definition.** `service install` bakes
 *     `--home <path>` into the unit/plist/binPath for a pinned instance
 *     (`../service/plan.ts`'s `resolveInvocation`), and Windows' `sc qc`
 *     additionally reports `SERVICE_START_NAME`. So when the default location
 *     is empty, this module ASKS the supervisor's own definition where it was
 *     told to live, and reads there instead (`home_source: "service"`).
 *  2. **It says which of those it did.** When the answer is still nothing, the
 *     output carries the account the service runs under, so a reader can tell
 *     "this department has never run here" apart from "its journal belongs to
 *     `LocalSystem` and this process cannot see it". Those are different facts
 *     and a `?` renders them identically.
 *
 * What it does NOT do is escalate: a journal owned by another account stays
 * unreadable, and this module reports that rather than pretending otherwise.
 *
 * ## PRIVACY POSITION (load-bearing — a new command is a new surface)
 *
 *   - **What it exposes.** Only the per-department INDEX file
 *     (`by-department/<id>/executions.jsonl`) — the admission records. Each
 *     line carries ids (`run_id`/`task_id`/`context_id`), a timestamp, the
 *     `engine` name, the `sender` string, and the path of that execution's own
 *     journal. It deliberately does NOT open those per-execution journals, so
 *     no message body, question text, artifact, or failure reason is reachable
 *     through this command at all.
 *   - **To whom.** stdout of a process the user started, on the machine that
 *     already holds the file, reading it with that process's own credentials.
 *     Nothing is sent anywhere, and this module is never wired into anything
 *     that ships.
 *   - **`sender` is shown in the clear, and that is the boundary, not a hole.**
 *     `b4` stores it plainly on disk; `../shipper/privacy.ts` maps
 *     `sender: 'fingerprint'`, so what LEAVES the machine at the metadata tier
 *     is `fp:<sha256-16>` and never the identity. That rule governs the
 *     shipping path. Reading a local file locally does not cross it — the
 *     operator can already `cat` this file — and this command must never
 *     become an input to one that ships.
 *   - **It widens nothing.** Read-only, and it stores no new field: every value
 *     it prints was already written by `b4` before this file existed.
 */

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { resolveHome } from '../core/config';
import { defaultDataDir } from '../shipper/fs';
import { departmentIndexPath, type DepartmentIndexEntry, parseDepartmentIndexLine } from './events';

/** The `<dataDir>` leaf the department journal lives under — the same join
 *  `../cli.ts`'s `runStart` performs when it constructs `DepartmentManager`
 *  (`journalRoot: join(defaultDataDir(), 'department')`). */
export const DEPARTMENT_JOURNAL_DIR = 'department';

/**
 * The output contract's version. Bumped only for a BREAKING change to the
 * shape below; adding a key is additive and does not move it (a reader that
 * understands 1 must tolerate unknown keys, the same rule `b4`'s own schema
 * bump documents).
 */
export const JOURNAL_READ_SCHEMA = 1;

/** How many index lines are parsed, from the TAIL. The index is append-only and
 *  never pruned, and a caller joins it against a RECENT task list, so the newest
 *  lines are the only ones that can match. */
export const DEFAULT_JOURNAL_LIMIT = 5000;

/** The narrow filesystem this module needs — two calls, so a test needs no
 *  temp directory and no real journal. */
export interface JournalReadFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
}

export function nodeJournalReadFs(): JournalReadFs {
  return {
    existsSync: (path) => nodeFs.existsSync(path),
    readFileSync: (path, encoding) => nodeFs.readFileSync(path, encoding),
  };
}

/**
 * Why the answer is what it is. Four values, and `absent` is a perfectly
 * ordinary state of the world (no runner has ever served this department here),
 * which is why it is NOT an error — see `journalExitCode`.
 */
export type JournalReadStatus =
  /** The index file was found and read. It may still hold zero executions. */
  | 'ok'
  /** No index file at the resolved path. Ordinary: this machine has never run
   *  this department's work, or it ran it under another account/home. */
  | 'absent'
  /** The file is there and could not be read: permissions (the different-OS-
   *  account case, once the path IS right), a directory in its place, a
   *  mid-write truncation of the whole file. */
  | 'unreadable'
  /** The runner's data directory could not be computed from the environment at
   *  all, so there is no path to even look at. */
  | 'unlocatable';

/** Which of the four candidate homes answered. Reported because "I looked in
 *  the wrong place" and "there is nothing there" are different answers. */
export type JournalHomeSource =
  /** `--home <path>` on this command line. */
  | 'flag'
  /** `PIPELINE_RUNNER_HOME` in this process's environment. */
  | 'env'
  /** `--home <path>` baked into the INSTALLED service definition. */
  | 'service'
  /** The OS default data dir for the invoking account. */
  | 'default'
  /** Nothing could be resolved (`status: "unlocatable"`). */
  | 'none';

/** What the supervisor's own definition says about itself — best-effort, and
 *  `null` throughout when a backend cannot answer. Never fatal: this is
 *  context for a reader, never the thing being asked for. */
export interface SupervisorObservation {
  /** `systemd` | `launchd` | `windows`, or null when the platform has none. */
  backend: string | null;
  /** Is there an installed definition at all? */
  installed: boolean;
  /** The home its argv pins (`--home <path>`), or null for an unpinned one. */
  home: string | null;
  /** The OS account it runs as, when the backend reports one (Windows). */
  account: string | null;
  /** True when `account` is a well-known MACHINE account — the case whose whole
   *  point is that its profile directory is not the invoking user's. */
  systemAccount: boolean;
  /** Why there is nothing more to say, when there is nothing more to say. */
  note: string | null;
}

/** One admitted execution, as the index recorded it. Field names are the
 *  index's own (snake_case) so the two can never drift into a translation. */
export interface JournalExecution {
  run_id: string;
  task_id: string | null;
  context_id: string | null;
  sender: string | null;
  engine: string | null;
  ts: string | null;
  journal_path: string | null;
}

/** The last thing this machine recorded for one task. One task can have several
 *  executions (a re-offer after a retry is a new one) and the file is
 *  append-ordered, so the LAST entry wins: the engine that most recently ran a
 *  task is the one an operator is asking about. */
export interface JournalTaskFacts {
  sender: string | null;
  engine: string | null;
  run_id: string;
  ts: string | null;
}

/**
 * THE `--json` CONTRACT. Every key below is always present (a `null` is a
 * stated absence, not a missing key), so a consumer may read any of them
 * unconditionally.
 */
export interface JournalReadOutput {
  /** {@link JOURNAL_READ_SCHEMA}. */
  schema: number;
  department_id: string;
  status: JournalReadStatus;
  /** The OS's own words for a non-`ok` status; `null` when there is nothing to
   *  explain. */
  message: string | null;
  /** The index file that was read, or that WOULD have been. `null` only when
   *  nothing could be located at all. */
  path: string | null;
  home_source: JournalHomeSource;
  /** Append-ordered, oldest first, capped to the tail (`counts.limit`). Empty
   *  for every non-`ok` status. */
  executions: JournalExecution[];
  /** `task_id` → the last execution's facts. Only entries whose line carried a
   *  usable `task_id` appear; an entry without one is still counted as an
   *  execution, because it IS one. */
  tasks: Record<string, JournalTaskFacts>;
  counts: {
    /** Valid index entries parsed. */
    executions: number;
    /** Lines that were not valid index entries and were skipped — a truncated
     *  final line after a hard kill is the common one. Never fatal. */
    skipped: number;
    /** The tail cap applied. */
    limit: number;
    /** True when the file held more lines than `limit` and the oldest were not
     *  parsed. */
    truncated: boolean;
  };
  /** Populated only when the journal could not be found where this process
   *  first looked — see the module doc. `null` otherwise (nothing was probed,
   *  and this command does not spawn a probe it does not need). */
  supervisor: SupervisorObservation | null;
}

export interface JournalReadOptions {
  departmentId: string;
  env?: Record<string, string | undefined>;
  platform?: string;
  /** `--home <path>`. Explicit, so it is never second-guessed by the probe. */
  homeFlag?: string;
  limit?: number;
  fs?: JournalReadFs;
  /**
   * The installed-service probe (`../service/inspect.ts`'s
   * `inspectInstalledService`), injected rather than imported so this module
   * stays testable without a service backend AND so the probe is only ever
   * CONSTRUCTED by a caller that wants it. Called at most once, and only when
   * the first look found nothing.
   */
  probeSupervisor?: () => SupervisorObservation;
}

/** `<home>/data/department` — `defaultDataDir`'s isolated-home branch, joined
 *  with the leaf `runStart` uses, kept explicit here because the home in
 *  question is frequently NOT this process's own. */
export function journalRootForHome(home: string): string {
  return join(home, 'data', DEPARTMENT_JOURNAL_DIR);
}

function resolveDefaultJournalRoot(
  env: Record<string, string | undefined>,
  platform: string
): { root: string; source: JournalHomeSource } | { root: null; message: string } {
  // `defaultDataDir` already resolves `PIPELINE_RUNNER_HOME` first (d7/D17), so
  // asking it once covers both branches; `resolveHome` only tells us WHICH one
  // answered, which is the part a reader needs.
  const homeSet = resolveHome(env) !== null;
  try {
    return { root: join(defaultDataDir(env, platform), DEPARTMENT_JOURNAL_DIR), source: homeSet ? 'env' : 'default' };
  } catch (err) {
    // The runner itself throws here; this reader has no standing to crash
    // because `%LOCALAPPDATA%` is unset. It reports that it cannot locate the
    // journal, which is a true answer to the question that was asked.
    return { root: null, message: err instanceof Error ? err.message : String(err) };
  }
}

interface RawReading {
  status: Exclude<JournalReadStatus, 'unlocatable'>;
  message: string | null;
  executions: JournalExecution[];
  tasks: Record<string, JournalTaskFacts>;
  parsed: number;
  skipped: number;
  truncated: boolean;
}

function emptyRaw(status: Exclude<JournalReadStatus, 'unlocatable'>, message: string | null): RawReading {
  return { status, message, executions: [], tasks: {}, parsed: 0, skipped: 0, truncated: false };
}

function describeReadError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'permission denied — the file exists but this process may not read it (a journal owned by another OS account looks exactly like this)';
  }
  if (code === 'EISDIR') return 'a directory exists where the index file should be';
  if (code !== undefined && code !== null) return String(code);
  return err instanceof Error ? err.message : String(err);
}

function toExecution(entry: DepartmentIndexEntry): JournalExecution {
  // `parseDepartmentIndexLine` guarantees `type`/`run_id`/`department_id` and
  // is deliberately tolerant about the rest ("an index is a convenience for a
  // reader, never the source of truth"), so every other field is re-checked
  // here rather than trusted. A schema-1 line carries none of them.
  const raw = entry as unknown as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = raw[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    run_id: entry.run_id,
    task_id: str('task_id'),
    context_id: str('context_id'),
    sender: str('sender'),
    engine: str('engine'),
    ts: str('ts'),
    journal_path: str('journal_path'),
  };
}

/** Read one department's index file. Never throws — every failure collapses
 *  into a status a caller renders as "unknown". */
function readIndexFile(fs: JournalReadFs, path: string, limit: number): RawReading {
  let exists: boolean;
  try {
    exists = fs.existsSync(path);
  } catch {
    // A probe that throws means the path could not even be inspected (an
    // unreadable parent) — indistinguishable from absent, and equally not an
    // error worth failing a read-only command over.
    return emptyRaw('absent', null);
  }
  if (!exists) return emptyRaw('absent', null);

  let text: string;
  try {
    text = fs.readFileSync(path, 'utf-8');
  } catch (err) {
    // Vanished between the probe and the read: a user's `rm` is allowed to
    // race us, and that is absent rather than broken.
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return emptyRaw('absent', null);
    return emptyRaw('unreadable', describeReadError(err));
  }

  const all = text.split('\n');
  const truncated = all.length > limit;
  const lines = truncated ? all.slice(all.length - limit) : all;
  const executions: JournalExecution[] = [];
  const tasks: Record<string, JournalTaskFacts> = {};
  let skipped = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const entry = parseDepartmentIndexLine(line);
    if (entry === null) {
      skipped++;
      continue;
    }
    const execution = toExecution(entry);
    executions.push(execution);
    // An entry with no `task_id` is still a real execution and is counted as
    // one; it simply teaches nothing about any TASK, so it cannot enter the map.
    if (execution.task_id !== null) {
      tasks[execution.task_id] = {
        sender: execution.sender,
        engine: execution.engine,
        run_id: execution.run_id,
        ts: execution.ts,
      };
    }
  }
  return { status: 'ok', message: null, executions, tasks, parsed: executions.length, skipped, truncated };
}

function outputFrom(
  departmentId: string,
  raw: RawReading,
  path: string | null,
  homeSource: JournalHomeSource,
  limit: number,
  supervisor: SupervisorObservation | null
): JournalReadOutput {
  return {
    schema: JOURNAL_READ_SCHEMA,
    department_id: departmentId,
    status: raw.status,
    message: raw.message,
    path,
    home_source: homeSource,
    executions: raw.executions,
    tasks: raw.tasks,
    counts: { executions: raw.parsed, skipped: raw.skipped, limit, truncated: raw.truncated },
    supervisor,
  };
}

/**
 * Read what THIS machine recorded for one department.
 *
 * Resolution order, and the reason for it: an EXPLICIT home always wins and is
 * never second-guessed (`--home`, then `PIPELINE_RUNNER_HOME`). Only when
 * neither was given, and the default location turned up nothing, does this ask
 * the installed service definition where the supervisor was told to live — the
 * one question this package can answer and a mirror in another package cannot.
 */
export function readDepartmentJournal(opts: JournalReadOptions): JournalReadOutput {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const fs = opts.fs ?? nodeJournalReadFs();
  const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : DEFAULT_JOURNAL_LIMIT;

  if (opts.homeFlag !== undefined && opts.homeFlag.trim().length > 0) {
    const path = departmentIndexPath(journalRootForHome(opts.homeFlag), opts.departmentId);
    return outputFrom(opts.departmentId, readIndexFile(fs, path, limit), path, 'flag', limit, null);
  }

  const resolved = resolveDefaultJournalRoot(env, platform);
  if (resolved.root === null) {
    const unlocatable = outputFrom(opts.departmentId, emptyRaw('absent', resolved.message), null, 'none', limit, null);
    return { ...unlocatable, status: 'unlocatable' };
  }

  const path = departmentIndexPath(resolved.root, opts.departmentId);
  const first = readIndexFile(fs, path, limit);
  // A read that ANSWERED — found the file, whatever it held — is the answer.
  // An explicit `PIPELINE_RUNNER_HOME` is also final: the caller named a home,
  // and quietly reading a different one would be the opposite of honest.
  if (first.status !== 'absent' || resolved.source === 'env' || opts.probeSupervisor === undefined) {
    return outputFrom(opts.departmentId, first, path, resolved.source, limit, null);
  }

  const supervisor = opts.probeSupervisor();
  if (supervisor.home === null || supervisor.home.trim().length === 0) {
    // Nothing to re-read — but the observation still goes out, because
    // "installed, runs as LocalSystem" is the difference between "never ran
    // here" and "ran here, under an account this process cannot read".
    return outputFrom(opts.departmentId, first, path, resolved.source, limit, supervisor);
  }
  const servicePath = departmentIndexPath(journalRootForHome(supervisor.home), opts.departmentId);
  if (servicePath === path) return outputFrom(opts.departmentId, first, path, resolved.source, limit, supervisor);
  const second = readIndexFile(fs, servicePath, limit);
  return outputFrom(opts.departmentId, second, servicePath, 'service', limit, supervisor);
}

/**
 * The process exit code for a reading.
 *
 * `absent` is 0 on purpose: no runner has ever served this department on this
 * machine is an ORDINARY state, not a failure, and a caller that shells this
 * out must be able to tell it apart from "the command itself did not work"
 * (`x11`'s rule — an unknown verb exits 1, so 1 has to keep meaning that).
 * `unreadable`/`unlocatable` are genuine failures to answer and exit 1; the
 * JSON is printed either way, so the reason is always machine-readable.
 */
export function journalExitCode(output: JournalReadOutput): number {
  return output.status === 'ok' || output.status === 'absent' ? 0 : 1;
}

// ── Human rendering ─────────────────────────────────────────────────────────

function describeSupervisor(s: SupervisorObservation): string[] {
  const lines: string[] = [];
  if (!s.installed) {
    lines.push(`supervisor: no ${s.backend ?? 'OS'} service is installed on this machine`);
  } else {
    const account = s.account !== null ? `, running as ${s.account}` : '';
    lines.push(`supervisor: ${s.backend ?? 'service'} service installed${account}`);
    if (s.home !== null) lines.push(`  its definition pins PIPELINE_RUNNER_HOME=${s.home}`);
    if (s.systemAccount) {
      lines.push(
        '  that is a MACHINE account — its journal lives under its own profile directory, not yours, and this',
        '  process cannot read it. Re-run this command as that account, or reinstall the service pinned to a',
        '  shared home: `pipeline-runner service install --home <path>`.'
      );
    }
  }
  if (s.note !== null) lines.push(`  ${s.note}`);
  return lines;
}

/** The default (non-`--json`) rendering. Deliberately plain: this is an
 *  operator's read of a local file, not a dashboard. */
export function renderJournalText(output: JournalReadOutput): string {
  const lines: string[] = [`department: ${output.department_id}`];
  lines.push(`index: ${output.path ?? '(could not be located)'} [${output.home_source}]`);
  switch (output.status) {
    case 'ok':
      break;
    case 'absent':
      lines.push('no executions recorded here — this machine has never run a task for this department');
      break;
    case 'unreadable':
      lines.push(`the index could not be read: ${output.message ?? 'unknown reason'}`);
      break;
    case 'unlocatable':
      lines.push(`the runner's data directory could not be resolved: ${output.message ?? 'unknown reason'}`);
      break;
  }
  if (output.status === 'ok') {
    lines.push(
      `${output.counts.executions} execution(s)` +
        (output.counts.skipped > 0 ? `, ${output.counts.skipped} unparseable line(s) skipped` : '') +
        (output.counts.truncated ? `, showing the newest ${output.counts.limit}` : '')
    );
    for (const e of output.executions) {
      lines.push(
        `  ${e.ts ?? '?'}  task ${e.task_id ?? '?'}  engine ${e.engine ?? '—'}  sender ${e.sender ?? '—'}  run ${e.run_id}`
      );
    }
  }
  if (output.supervisor !== null) lines.push(...describeSupervisor(output.supervisor));
  return lines.join('\n');
}
