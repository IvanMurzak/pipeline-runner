/**
 * Shared shipper-test fakes: an in-memory `ShipperFileSystem` (byte-accurate,
 * so the journal tail's offset math is exercised for real), a scriptable
 * upload transport, and journal-event factories. Underscore-prefixed so
 * `bun test` does not pick this file up as a suite.
 */

import type { ShipperFileSystem } from '../src/shipper/fs';
import type { UploadResult, UploadTransport } from '../src/shipper/upload-transport';
import type { IngestBatchRequest } from '../src/shipper/wire-ingest';

// ── In-memory shipper fs ─────────────────────────────────────────────────────

const norm = (path: string): string => path.replace(/\\/g, '/');

export class MemShipperFs implements ShipperFileSystem {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>();

  /** Append raw bytes to a file (journal-writer side of the tests). */
  appendBytes(path: string, bytes: Uint8Array): void {
    const key = norm(path);
    const existing = this.files.get(key) ?? new Uint8Array(0);
    const next = new Uint8Array(existing.length + bytes.length);
    next.set(existing, 0);
    next.set(bytes, existing.length);
    this.files.set(key, next);
  }

  /** Append UTF-8 text to a file. */
  appendText(path: string, text: string): void {
    this.appendBytes(path, new TextEncoder().encode(text));
  }

  /** Truncate/replace a file with raw text (journal rotation in tests). */
  setText(path: string, text: string): void {
    this.files.set(norm(path), new TextEncoder().encode(text));
  }

  readFileText(path: string): string | null {
    const bytes = this.files.get(norm(path));
    return bytes === undefined ? null : new TextDecoder().decode(bytes);
  }

  writeFileText(path: string, data: string): void {
    this.files.set(norm(path), new TextEncoder().encode(data));
  }

  mkdirp(path: string): void {
    this.dirs.add(norm(path));
  }

  statSize(path: string): number | null {
    return this.files.get(norm(path))?.length ?? null;
  }

  readRange(path: string, start: number, end: number): Uint8Array {
    const bytes = this.files.get(norm(path));
    if (bytes === undefined) return new Uint8Array(0);
    return bytes.slice(Math.min(start, bytes.length), Math.min(end, bytes.length));
  }

  listDir(path: string): Array<{ name: string; isDirectory: boolean }> | null {
    const prefix = norm(path).replace(/\/$/, '') + '/';
    const names = new Map<string, boolean>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) names.set(rest, false);
      else names.set(rest.slice(0, slash), true);
    }
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      names.set(slash < 0 ? rest : rest.slice(0, slash), true);
    }
    if (names.size === 0 && !this.dirs.has(norm(path).replace(/\/$/, ''))) return null;
    return [...names.entries()].map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  remove(path: string): void {
    this.files.delete(norm(path));
  }

  rename(from: string, to: string): void {
    const key = norm(from);
    const bytes = this.files.get(key);
    if (bytes === undefined) throw new Error(`rename: no such file ${from}`);
    this.files.delete(key);
    this.files.set(norm(to), bytes);
  }
}

// ── Scriptable upload transport ──────────────────────────────────────────────

export class FakeUploadTransport implements UploadTransport {
  readonly name = 'fake';
  /** Every upload ATTEMPT, in order (deep-copied at call time). */
  attempts: IngestBatchRequest[] = [];
  /** Every CONFIRMED (ok) upload, in order. */
  confirmed: IngestBatchRequest[] = [];
  /** Scripted results consumed first; when empty, `mode` applies. */
  script: UploadResult[] = [];
  mode: 'ok' | 'offline' | 'reject' = 'ok';

  async upload(batch: IngestBatchRequest): Promise<UploadResult> {
    const copy = JSON.parse(JSON.stringify(batch)) as IngestBatchRequest;
    this.attempts.push(copy);
    const result: UploadResult =
      this.script.shift() ??
      (this.mode === 'ok'
        ? { ok: true, ack: { run_id: batch.run_id, inserted: batch.events.length, skipped: 0 } }
        : this.mode === 'offline'
          ? { ok: false, retryable: true, error: 'offline (fake)' }
          : { ok: false, retryable: false, error: 'rejected (fake)' });
    if (result.ok) this.confirmed.push(copy);
    return result;
  }

  /** All confirmed (runId, seq) pairs, in upload order. */
  confirmedSeqs(runId: string): number[] {
    return this.confirmed
      .filter((batch) => batch.run_id === runId)
      .flatMap((batch) => batch.events.map((event) => event.seq));
  }
}

// ── Journal-event factories ──────────────────────────────────────────────────

export function journalEvent(
  type: string,
  runId: string | null,
  data: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: 4,
    ts: '2026-07-11T12:00:00.000Z',
    type,
    project_root: 'C:/Users/ivan/very-secret-client-project',
    worktree: null,
    run_id: runId,
    parent_run_id: null,
    session_id: 'sess-1',
    data,
    ...extra,
  };
}

export function journalLine(
  type: string,
  runId: string | null,
  data: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify(journalEvent(type, runId, data, extra)) + '\n';
}

/** Flush queued micro/macrotasks so async drain loops settle. Each macrotask
 *  round flushes every pending microtask chain; the drain's awaits are all
 *  microtasks (fake transports use no real timers), so a few rounds suffice. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
