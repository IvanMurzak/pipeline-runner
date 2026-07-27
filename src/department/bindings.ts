/**
 * The file-backed, RELOADABLE runtime-binding store (simplified-onboarding
 * task b1; design 05 §5 step 6, 07 §8, D14).
 *
 * ## What a "binding" is
 *
 * A binding maps one `department_id` to the `RuntimeConfig` this machine will
 * start when the cloud offers that department a task. It is the LOCAL half of
 * a department: the cloud stores the advertised manifest and structurally
 * refuses to store `command`/`args`/`workingDirectory`/`environment`, so a
 * remote caller cannot mutate what executes here. This file is the other side
 * of that boundary, and 07 §8 is explicit that the property "must not be given
 * away locally".
 *
 * ## Why a file, and why reloadable
 *
 * `PIPELINE_RUNNER_DEPARTMENTS` (`./config.ts`) is parsed ONCE at boot and the
 * resulting Map is closed over for the process lifetime, so a running
 * supervisor could never learn about a department created after it started —
 * and `department.config_update` is not an escape hatch (it carries
 * `limits.parkExpiry` only and drops frames for departments the boot-time map
 * does not know, `./manager.ts`). That made `pipeline department serve` on a
 * machine that is already serving end in "restart the supervisor" rather than
 * `● online`. This store closes that: the supervisor re-reads the file on a
 * filesystem watch, on `SIGHUP`, and on a slow safety-net poll.
 *
 * ## Security posture (07 §8) — this file decides WHAT EXECUTES
 *
 *   - It lives under the supervisor's OWN config dir, home-aware via
 *     `PIPELINE_RUNNER_HOME` (`../core/config.ts`'s `defaultConfigDir`), so
 *     multi-home instances never share one.
 *   - It is written mode `0600` inside a `0700` dir (POSIX; on Windows modes
 *     are a no-op and the per-user `%APPDATA%` ACL is the control — the same
 *     posture `../core/config.ts` documents for the credential file).
 *   - The supervisor REFUSES to load a group- or world-writable file, and
 *     refuses one owned by an account other than its own (root excepted —
 *     root can already do anything to this process). "Refuses" means it states
 *     the reason and serves NOTHING, never that it loads it anyway.
 *
 * ## Fail-closed, always
 *
 * Every failure mode — missing, unreadable, not JSON, wrong shape, unknown
 * `apiVersion`, refused permissions — resolves to ZERO bindings, which makes
 * every department offer a `capability` reject. A malformed or half-written
 * file can therefore never WIDEN what this runner will run; the worst it can
 * do is narrow it to nothing. Individual malformed ENTRIES are skipped with a
 * warning and the rest of the file still applies (same rule the env parser has
 * always had) — skipping an entry is also narrowing, never widening.
 *
 * Note that a reload never touches an execution that is already running:
 * `./manager.ts` consults `resolveRuntimeConfig` at ADMISSION only and each
 * `ExecutionState` keeps the runtime it started with. Unbinding a department
 * stops new offers being accepted; it does not kill in-flight work.
 *
 * ## File format
 *
 * ```json
 * {
 *   "apiVersion": "runner.ai-pipeline.dev/v1",
 *   "departments": {
 *     "018f…-uuid": { "adapterId": "jsonl-process", "command": "…", "args": ["--stdio"] }
 *   }
 * }
 * ```
 *
 * Unknown top-level keys warn (a newer writer stays readable). An unknown
 * `apiVersion` is REFUSED rather than warned: unlike the user-authored
 * `department.yml` (D22), this file is machine-written and decides what
 * executes, so guessing at a format we do not understand is not a tolerable
 * default.
 *
 * Writers MUST replace the file atomically (`writeFileAtomic` below: temp file
 * in the same directory, then rename). The reload path is debounced anyway, so
 * a non-atomic writer degrades to a transient fail-closed rather than to a
 * wrong binding.
 */

import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Clock } from '../core/clock';
import { systemClock } from '../core/clock';
import { defaultConfigDir } from '../core/config';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { RuntimeConfig } from './adapter';
import { DEPARTMENT_RUNTIMES_ENV, narrowRuntimeConfig, parseDepartmentRuntimesEnv } from './config';

export const BINDINGS_FILE_NAME = 'departments.json';
/** Directory mode for the config dir (POSIX; ignored on Windows). */
export const BINDINGS_DIR_MODE = 0o700;
/** File mode for the binding file (POSIX; ignored on Windows). */
export const BINDINGS_FILE_MODE = 0o600;
/** The only document version this runner knows how to interpret. */
export const BINDINGS_API_VERSION = 'runner.ai-pipeline.dev/v1';
/** Coalescing window for watch-triggered reloads — long enough that a
 *  truncate-then-write sequence from a non-atomic writer settles into ONE
 *  read, short enough that `serve` still ends in `● online`. */
export const DEFAULT_RELOAD_DEBOUNCE_MS = 150;
/** Safety-net re-read cadence. `fs.watch` is documented as not reliable on
 *  every platform/filesystem (network mounts, some container overlays), and a
 *  supervisor that silently stops noticing bindings is exactly the failure
 *  this task exists to remove. 0 disables it. */
export const DEFAULT_RELOAD_POLL_MS = 30_000;

/** Raised by the WRITE side (`bind`/`unbind`/`writeBindings`). The READ side
 *  never throws — it fails closed. */
export class BindingStoreError extends Error {}

/** Where this instance's binding file lives — home-aware, so two runners with
 *  different `PIPELINE_RUNNER_HOME` values never share bindings. */
export function resolveBindingsPath(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform
): string {
  return join(defaultConfigDir(env, platform), BINDINGS_FILE_NAME);
}

export interface BindingFileStat {
  /** POSIX mode bits (meaningless on Windows — see the module doc). */
  mode: number;
  /** Owning uid (0 on Windows). */
  uid: number;
}

/** Injectable filesystem seam — deliberately narrow, mirroring
 *  `ConfigFileSystem`/`HomeLockFs`'s testability philosophy. */
export interface BindingFileSystem {
  /** Metadata for an existing file, or null when it does not exist. */
  statFile(path: string): BindingFileStat | null;
  /** The file's text, or null when it does not exist. */
  readFileText(path: string): string | null;
  mkdirp(path: string, mode: number): void;
  /** Create-or-REPLACE atomically: write a temp file in the SAME directory
   *  with `mode`, then rename over `path`. A reader therefore only ever sees
   *  a complete document. */
  writeFileAtomic(path: string, data: string, mode: number): void;
  /** Watch a DIRECTORY (not the file — an atomic replace unlinks the inode a
   *  file-watch is bound to). `onChange` receives the changed entry's name, or
   *  null on platforms that do not report one. Returns an unwatch function. */
  watchDir(path: string, onChange: (filename: string | null) => void): () => void;
}

/** The real filesystem (node:fs sync API — binding I/O is tiny and rare). */
export function nodeBindingFs(): BindingFileSystem {
  return {
    statFile: (path) => {
      try {
        const stat = fs.statSync(path);
        return { mode: stat.mode, uid: stat.uid };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    readFileText: (path) => {
      try {
        return fs.readFileSync(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    mkdirp: (path, mode) => {
      fs.mkdirSync(path, { recursive: true, mode });
    },
    writeFileAtomic: (path, data, mode) => {
      const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        fs.writeFileSync(tmp, data, { mode });
        // `mode` only applies at creation; re-tighten defensively (umask).
        try {
          fs.chmodSync(tmp, mode);
        } catch {
          // Windows has no POSIX modes; the per-user ACL applies instead.
        }
        fs.renameSync(tmp, path);
      } catch (err) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // Best-effort cleanup only — the original error is what matters.
        }
        throw err;
      }
    },
    watchDir: (path, onChange) => {
      // `persistent: false` — the daemon is kept alive by its socket and
      // timers; a watcher must never be the reason a CLI process hangs.
      const watcher = fs.watch(path, { persistent: false }, (_event, filename) => {
        onChange(typeof filename === 'string' ? filename : null);
      });
      return () => watcher.close();
    },
  };
}

/**
 * 07 §8: refuse a binding file anyone else can write, and say why. Returns the
 * stated reason, or null when the file is acceptable.
 *
 * On Windows POSIX modes are meaningless (`statSync().mode` is synthesised),
 * so the check is skipped there and the per-user `%APPDATA%`/home ACL is the
 * control — the identical posture `../core/config.ts` documents for the
 * credential file, which is a strictly more sensitive file than this one.
 */
export function bindingFilePermissionRefusal(
  stat: BindingFileStat,
  path: string,
  platform: string,
  uid: number | null
): string | null {
  if (platform === 'win32') return null;
  const writableByOthers = stat.mode & 0o022;
  if (writableByOthers !== 0) {
    const who = (stat.mode & 0o002) !== 0 ? 'world-writable' : 'group-writable';
    return (
      `${path} is ${who} (mode ${(stat.mode & 0o777).toString(8).padStart(3, '0')}) — anyone who can write it ` +
      `chooses what this runner executes. Fix it with \`chmod 600 ${path}\` and the supervisor will pick it up.`
    );
  }
  // uid 0 is exempt: root can already do anything to this process, so a
  // root-owned binding file is not a privilege the attacker did not have.
  if (uid !== null && stat.uid !== uid && stat.uid !== 0) {
    return (
      `${path} is owned by uid ${stat.uid}, not by the account this runner runs as (uid ${uid}) — ` +
      `only the supervisor's own account may decide what it executes. Fix it with \`chown ${uid} ${path}\`.`
    );
  }
  return null;
}

/** Where the live bindings came from. `'none'` is a legitimate steady state:
 *  a runner that serves cloud pipeline dispatch and no department. */
export type BindingSource = 'file' | 'env' | 'none';

export interface BindingSnapshot {
  readonly source: BindingSource;
  /** The binding file's path — reported even when the file is absent, because
   *  "where do I write it" is the question an operator is actually asking. */
  readonly path: string;
  readonly bindings: ReadonlyMap<string, RuntimeConfig>;
  /** Non-null when the file was REFUSED or could not be interpreted. Bindings
   *  are empty in that case — fail closed, never partially applied. */
  readonly refusal: string | null;
}

/**
 * Interpret a binding document. Returns null when the document must be
 * refused wholesale (fail closed); `reason` carries the stated cause.
 *
 * Malformed individual entries are skipped with a warning rather than
 * refusing the document: dropping an entry narrows what runs, and one
 * hand-broken department should not take the other nine offline.
 */
export function parseBindingsDocument(
  text: string,
  path: string,
  logger: Logger = nullLogger
): { bindings: Map<string, RuntimeConfig> } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: `${path} is not valid JSON` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { reason: `${path} is not a JSON object` };
  }
  const doc = parsed as Record<string, unknown>;

  if (doc.apiVersion !== undefined) {
    if (typeof doc.apiVersion !== 'string' || doc.apiVersion !== BINDINGS_API_VERSION) {
      return {
        reason:
          `${path} declares apiVersion ${JSON.stringify(doc.apiVersion)}, which this runner does not understand ` +
          `(expected ${BINDINGS_API_VERSION}) — refusing to guess at what it means`,
      };
    }
  }

  const departments = doc.departments;
  if (typeof departments !== 'object' || departments === null || Array.isArray(departments)) {
    return { reason: `${path} has no \`departments\` object (found ${describeType(departments)})` };
  }

  for (const key of Object.keys(doc)) {
    if (key !== 'apiVersion' && key !== 'departments') {
      logger.warn(`department bindings: unknown top-level key '${key}' in ${path} — ignored`);
    }
  }

  const bindings = new Map<string, RuntimeConfig>();
  for (const [departmentId, value] of Object.entries(departments as Record<string, unknown>)) {
    const config = narrowRuntimeConfig(value);
    if (config === null) {
      logger.warn(`department bindings: entry '${departmentId}' in ${path} is malformed — skipped (that department will not be served)`);
      continue;
    }
    bindings.set(departmentId, config);
  }
  return { bindings };
}

function describeType(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

export interface DepartmentBindingStoreOptions {
  /** Override the config directory (tests, or a future --config-dir flag). */
  dir?: string;
  /** Override the full file path — wins over `dir`. */
  path?: string;
  fs?: BindingFileSystem;
  env?: Record<string, string | undefined>;
  platform?: string;
  logger?: Logger;
  /** This process's effective uid; `null` on platforms without one. */
  uid?: number | null;
  clock?: Clock;
  debounceMs?: number;
  /** Safety-net re-read cadence; 0 disables it. */
  pollMs?: number;
}

/**
 * The live binding set, re-readable at any time.
 *
 * Read side: `reload()` + `get()`. Wire `get` straight into
 * `DepartmentManager`'s `resolveRuntimeConfig` — it is a live accessor, not a
 * captured Map, which is the whole point of this task.
 *
 * Write side: `bind()` / `unbind()` / `writeBindings()`, used by
 * `pipeline-runner bind` so another package (the `pipeline` CLI's
 * `department serve`) can shell out instead of writing this package's config
 * store directly (design 05 §5, D26's rule applied to the binding as well as
 * the identity).
 */
export class DepartmentBindingStore {
  readonly path: string;
  private readonly fsys: BindingFileSystem;
  private readonly env: Record<string, string | undefined>;
  private readonly platform: string;
  private readonly logger: Logger;
  private readonly uid: number | null;
  private readonly clock: Clock;
  private readonly debounceMs: number;
  private readonly pollMs: number;

  private current: BindingSnapshot;
  /** Dedupes the log line: a watch can fire several times per write, and a
   *  poll fires forever — an operator should see a line when the ANSWER
   *  changes, not once per tick. */
  private lastSignature: string | null = null;

  constructor(options: DepartmentBindingStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.path =
      options.path ??
      (options.dir !== undefined ? join(options.dir, BINDINGS_FILE_NAME) : resolveBindingsPath(this.env, this.platform));
    this.fsys = options.fs ?? nodeBindingFs();
    this.logger = options.logger ?? nullLogger;
    this.uid =
      options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null;
    this.clock = options.clock ?? systemClock;
    this.debounceMs = options.debounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS;
    this.pollMs = options.pollMs ?? DEFAULT_RELOAD_POLL_MS;
    this.current = { source: 'none', path: this.path, bindings: new Map(), refusal: null };
  }

  /** The live snapshot (no I/O). */
  snapshot(): BindingSnapshot {
    return this.current;
  }

  /** The resolver to hand `DepartmentManager` — reads the LIVE snapshot on
   *  every call, so a reload is visible to the very next offer. */
  get(departmentId: string): RuntimeConfig | null {
    return this.current.bindings.get(departmentId) ?? null;
  }

  get size(): number {
    return this.current.bindings.size;
  }

  ids(): string[] {
    return [...this.current.bindings.keys()].sort();
  }

  /**
   * Re-read the store. Never throws: every failure resolves to zero bindings
   * with a stated reason (fail closed — see the module doc).
   *
   * Precedence is deliberate and absolute: when the binding FILE exists it is
   * the sole authority, and `PIPELINE_RUNNER_DEPARTMENTS` is ignored with a
   * warning. Merging two sources would mean a security-critical answer had two
   * authors and no obvious winner. The env var is consulted only when there is
   * no file at all, which is exactly the "existing local setup that has not
   * migrated yet" case it now exists to serve.
   */
  reload(): BindingSnapshot {
    const next = this.read();
    this.current = next;
    this.logIfChanged(next);
    return next;
  }

  private read(): BindingSnapshot {
    const empty = (): Map<string, RuntimeConfig> => new Map();
    let stat: BindingFileStat | null;
    try {
      stat = this.fsys.statFile(this.path);
    } catch (err) {
      return { source: 'file', path: this.path, bindings: empty(), refusal: `${this.path} could not be inspected: ${errorText(err)}` };
    }

    if (stat !== null) {
      const refusal = bindingFilePermissionRefusal(stat, this.path, this.platform, this.uid);
      if (refusal !== null) return { source: 'file', path: this.path, bindings: empty(), refusal };

      let text: string | null;
      try {
        text = this.fsys.readFileText(this.path);
      } catch (err) {
        return { source: 'file', path: this.path, bindings: empty(), refusal: `${this.path} could not be read: ${errorText(err)}` };
      }
      // A file that vanished between stat and read (a rename race with a
      // writer) is treated as absent, not as an error: the writer's rename
      // fires another watch event and the next reload sees the new document.
      if (text !== null) {
        const parsed = parseBindingsDocument(text, this.path, this.logger);
        if ('reason' in parsed) {
          return { source: 'file', path: this.path, bindings: empty(), refusal: parsed.reason };
        }
        return { source: 'file', path: this.path, bindings: parsed.bindings, refusal: null };
      }
    }

    const raw = this.env[DEPARTMENT_RUNTIMES_ENV];
    if (raw !== undefined && raw.trim() !== '') {
      return {
        source: 'env',
        path: this.path,
        bindings: parseDepartmentRuntimesEnv(raw, this.logger),
        refusal: null,
      };
    }
    return { source: 'none', path: this.path, bindings: empty(), refusal: null };
  }

  private logIfChanged(snapshot: BindingSnapshot): void {
    const envSet = (this.env[DEPARTMENT_RUNTIMES_ENV] ?? '').trim() !== '';
    const signature = [snapshot.source, snapshot.refusal ?? '', envSet ? 'env' : '', [...snapshot.bindings.keys()].sort().join(',')].join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    if (snapshot.refusal !== null) {
      this.logger.warn(`department bindings REFUSED — ${snapshot.refusal}. No departments are configured; every offer will be rejected.`);
    } else if (snapshot.source === 'file') {
      this.logger.info(
        snapshot.bindings.size === 0
          ? `department bindings: none in ${this.path} — every department offer will be rejected`
          : `department bindings: ${snapshot.bindings.size} from ${this.path} (${[...snapshot.bindings.keys()].sort().join(', ')})`
      );
      if (envSet) {
        this.logger.warn(
          `${DEPARTMENT_RUNTIMES_ENV} is set but IGNORED: ${this.path} exists and is the sole authority for what this runner ` +
            `executes. Unset the variable — it is deprecated and will be removed.`
        );
      }
    } else if (snapshot.source === 'env') {
      this.logger.warn(
        `${DEPARTMENT_RUNTIMES_ENV} is DEPRECATED and will be removed in a future release. It is being used because no ` +
          `binding file exists at ${this.path}; a supervisor configured this way CANNOT pick up a new department without a ` +
          `restart. Migrate with \`pipeline-runner bind --department <id> --command <cmd>\`.`
      );
      this.logger.info(
        `department bindings: ${snapshot.bindings.size} from ${DEPARTMENT_RUNTIMES_ENV}` +
          (snapshot.bindings.size === 0 ? '' : ` (${[...snapshot.bindings.keys()].sort().join(', ')})`)
      );
    } else {
      this.logger.info(
        `department bindings: none (${this.path} does not exist, ${DEPARTMENT_RUNTIMES_ENV} unset) — department offers will be rejected`
      );
    }
  }

  /**
   * Start reloading on change and return a stop function.
   *
   * Two triggers, because neither alone is sufficient: a directory watch (the
   * file is REPLACED by rename, which unlinks whatever inode a file-watch is
   * bound to), debounced so a truncate-then-write from a non-atomic writer
   * settles into one read; and a slow poll as the safety net for platforms and
   * filesystems where `fs.watch` does not deliver. `SIGHUP` is the third
   * trigger and lives in `cli.ts`, where process signals belong.
   *
   * `onReload`'s second argument says whether the effective answer actually
   * changed, so a caller can stay quiet on the no-op ticks.
   */
  watch(onReload?: (snapshot: BindingSnapshot, changed: boolean) => void): () => void {
    const dir = dirname(this.path);
    const name = basename(this.path);
    let stopped = false;
    let debounceTimer: unknown = null;
    let pollTimer: unknown = null;

    const fire = (): void => {
      if (stopped) return;
      const before = this.lastSignature;
      const snapshot = this.reload();
      onReload?.(snapshot, this.lastSignature !== before);
    };

    const schedule = (): void => {
      if (stopped) return;
      if (debounceTimer !== null) this.clock.clearTimeout(debounceTimer);
      debounceTimer = this.clock.setTimeout(() => {
        debounceTimer = null;
        fire();
      }, this.debounceMs);
    };

    // `fs.watch` throws ENOENT on a missing directory, and a runner that has
    // never been bound legitimately has none yet.
    try {
      this.fsys.mkdirp(dir, BINDINGS_DIR_MODE);
    } catch (err) {
      this.logger.warn(`could not create ${dir} for the department binding watch: ${errorText(err)}`);
    }

    let unwatch: () => void = () => {};
    try {
      unwatch = this.fsys.watchDir(dir, (filename) => {
        // Null means "this platform does not report which entry changed" —
        // reload rather than miss it. Temp files from an atomic write are
        // prefixed with the real name, so they debounce into the same read.
        if (filename !== null && !filename.startsWith(name)) return;
        schedule();
      });
    } catch (err) {
      this.logger.warn(
        `could not watch ${dir} for department binding changes (${errorText(err)}) — ` +
          (this.pollMs > 0 ? `falling back to the ${this.pollMs}ms poll and SIGHUP` : 'reload now requires SIGHUP or a restart')
      );
    }

    const armPoll = (): void => {
      if (stopped || this.pollMs <= 0) return;
      pollTimer = this.clock.setTimeout(() => {
        pollTimer = null;
        fire();
        armPoll();
      }, this.pollMs);
    };
    armPoll();

    return () => {
      if (stopped) return;
      stopped = true;
      if (debounceTimer !== null) this.clock.clearTimeout(debounceTimer);
      if (pollTimer !== null) this.clock.clearTimeout(pollTimer);
      try {
        unwatch();
      } catch {
        // Closing an already-closed watcher is not an error worth surfacing.
      }
    };
  }

  // ── Write side ───────────────────────────────────────────────────────────

  /**
   * The bindings currently ON DISK, for a read-modify-write. Unlike `reload`
   * this THROWS rather than failing closed: silently rewriting a file we could
   * not interpret would discard content an operator may need to look at, and a
   * file that failed the permission guard is evidence, not a nuisance.
   */
  readForWrite(): Map<string, RuntimeConfig> {
    const stat = this.fsys.statFile(this.path);
    if (stat === null) return new Map();
    const refusal = bindingFilePermissionRefusal(stat, this.path, this.platform, this.uid);
    if (refusal !== null) throw new BindingStoreError(refusal);
    const text = this.fsys.readFileText(this.path);
    if (text === null) return new Map();
    const parsed = parseBindingsDocument(text, this.path, this.logger);
    if ('reason' in parsed) {
      throw new BindingStoreError(
        `${parsed.reason} — refusing to overwrite it, because that would discard whatever it holds. ` +
          `Inspect it, then fix or delete ${this.path} and retry.`
      );
    }
    return parsed.bindings;
  }

  /** Replace the whole document, atomically, at mode 0600. Keys are sorted so
   *  the file diffs cleanly when an operator commits or reviews it. */
  writeBindings(bindings: ReadonlyMap<string, RuntimeConfig>): void {
    const dir = dirname(this.path);
    this.fsys.mkdirp(dir, BINDINGS_DIR_MODE);
    const departments: Record<string, RuntimeConfig> = {};
    for (const id of [...bindings.keys()].sort()) departments[id] = bindings.get(id)!;
    const document = { apiVersion: BINDINGS_API_VERSION, departments };
    this.fsys.writeFileAtomic(this.path, JSON.stringify(document, null, 2) + '\n', BINDINGS_FILE_MODE);
  }

  /** Add or replace one department's binding. Returns the narrowed config
   *  actually stored, so a caller can print exactly what will execute. */
  bind(departmentId: string, config: unknown): RuntimeConfig {
    if (departmentId.trim() === '') throw new BindingStoreError('a department id is required');
    const narrowed = narrowRuntimeConfig(config);
    if (narrowed === null) {
      throw new BindingStoreError('the runtime spec is incomplete — `adapterId` and `command` are both required');
    }
    const bindings = this.readForWrite();
    bindings.set(departmentId, narrowed);
    this.writeBindings(bindings);
    return narrowed;
  }

  /** Remove one department's binding. Returns false when it was not bound. */
  unbind(departmentId: string): boolean {
    const bindings = this.readForWrite();
    if (!bindings.delete(departmentId)) return false;
    this.writeBindings(bindings);
    return true;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
