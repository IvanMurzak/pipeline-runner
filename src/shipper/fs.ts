/**
 * Injectable filesystem seam for the shipper (tail, cursor, spool, stats).
 *
 * The core's `ConfigFileSystem` (`../core/config.ts`) is too small for the
 * shipper (no readdir/remove/size), so the shipper owns a wider seam with the
 * same philosophy: import-inert, tests use an in-memory implementation, the
 * real filesystem is only touched through `nodeShipperFs()`.
 *
 * Also owns `defaultDataDir()` — the agent's mutable DATA directory (cursor +
 * offline buffer live here, NEVER inside the tailed project):
 *
 *   - Windows: `%LOCALAPPDATA%\pipeline-runner`
 *   - elsewhere: `$XDG_STATE_HOME/pipeline-runner`
 *     (falling back to `~/.local/state/pipeline-runner`)
 *
 * department-mesh d7 (D17): `PIPELINE_RUNNER_HOME` roots this at
 * `<home>/data` (see `../core/config.ts`'s `resolveHome`, the single source
 * of truth for the env var) — unset ⇒ the OS-default paths above, unchanged.
 */

import * as fs from 'node:fs';
import { join } from 'node:path';
import { resolveHome } from '../core/config';

export class ShipperFsError extends Error {}

export interface ShipperFileSystem {
  /** The file's text, or null if it does not exist. */
  readFileText(path: string): string | null;
  /** Write text, creating or replacing. Best-effort atomic (tmp + rename). */
  writeFileText(path: string, data: string): void;
  mkdirp(path: string): void;
  /** File size in bytes, or null if the file does not exist. */
  statSize(path: string): number | null;
  /** Last-modified time (epoch ms), or null if the file does not exist.
   *  Used as a CHANGE DETECTOR (skip unchanged files), never as a clock —
   *  equality is compared against a previously returned value only. */
  statMtime(path: string): number | null;
  /** Read bytes [start, end) — short reads tolerated (returns what exists). */
  readRange(path: string, start: number, end: number): Uint8Array;
  /** Names of directory entries, or null when the dir does not exist. */
  listDir(path: string): Array<{ name: string; isDirectory: boolean }> | null;
  /** Delete a file (missing file is a no-op). */
  remove(path: string): void;
  /** Rename a file (used to set poisoned spool chunks aside). */
  rename(from: string, to: string): void;
}

/** The real filesystem (node:fs sync API — shipper I/O is small and bursty). */
export function nodeShipperFs(): ShipperFileSystem {
  const ignoreEnoent = (err: unknown): void => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  };
  return {
    readFileText: (path) => {
      try {
        return fs.readFileSync(path, 'utf8');
      } catch (err) {
        ignoreEnoent(err);
        return null;
      }
    },
    writeFileText: (path, data) => {
      const tmp = `${path}.tmp`;
      fs.writeFileSync(tmp, data, 'utf8');
      try {
        fs.renameSync(tmp, path);
      } catch {
        // Windows rename-over-existing can fail — fall back to direct write.
        fs.writeFileSync(path, data, 'utf8');
        try {
          fs.rmSync(tmp);
        } catch {
          /* best-effort tmp cleanup */
        }
      }
    },
    mkdirp: (path) => {
      fs.mkdirSync(path, { recursive: true });
    },
    statSize: (path) => {
      try {
        return fs.statSync(path).size;
      } catch (err) {
        ignoreEnoent(err);
        return null;
      }
    },
    statMtime: (path) => {
      try {
        return fs.statSync(path).mtimeMs;
      } catch (err) {
        ignoreEnoent(err);
        return null;
      }
    },
    readRange: (path, start, end) => {
      const len = end - start;
      if (len <= 0) return new Uint8Array(0);
      let fd: number;
      try {
        fd = fs.openSync(path, 'r');
      } catch (err) {
        ignoreEnoent(err);
        return new Uint8Array(0);
      }
      try {
        const buf = Buffer.alloc(len);
        let read = 0;
        while (read < len) {
          const n = fs.readSync(fd, buf, read, len - read, start + read);
          if (n === 0) break;
          read += n;
        }
        return read === len ? buf : buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    },
    listDir: (path) => {
      try {
        return fs
          .readdirSync(path, { withFileTypes: true })
          .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch (err) {
        ignoreEnoent(err);
        return null;
      }
    },
    remove: (path) => {
      try {
        fs.rmSync(path);
      } catch (err) {
        ignoreEnoent(err);
      }
    },
    rename: (from, to) => {
      fs.renameSync(from, to);
    },
  };
}

/**
 * Resolve the OS-appropriate DATA directory from an injectable env + platform
 * (mirrors `defaultConfigDir` in `../core/config.ts`, but for mutable state).
 */
export function defaultDataDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform
): string {
  // d7 (D17): an isolated home roots this instance's data dir at
  // `<home>/data` — see `defaultConfigDir`'s matching check in
  // `../core/config.ts`, which this mirrors.
  const home = resolveHome(env);
  if (home !== null) return join(home, 'data');
  if (platform === 'win32') {
    const local =
      env.LOCALAPPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Local') : undefined);
    if (!local) {
      throw new ShipperFsError('cannot determine data directory: %LOCALAPPDATA% and %USERPROFILE% are both unset');
    }
    return join(local, 'pipeline-runner');
  }
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'pipeline-runner');
  if (env.HOME) return join(env.HOME, '.local', 'state', 'pipeline-runner');
  throw new ShipperFsError('cannot determine data directory: $XDG_STATE_HOME and $HOME are both unset');
}
