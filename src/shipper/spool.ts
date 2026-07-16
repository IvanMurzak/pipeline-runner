/**
 * On-disk offline buffer (the SPOOL) — the durable queue between the tail and
 * the upload transport.
 *
 * Design: SPOOL-FIRST. Every flush writes its batches to disk BEFORE the
 * cursor advances, and the uploader drains the spool oldest-first, deleting a
 * chunk only after the server confirms it. Offline buffering therefore isn't
 * a special mode — it is the only path — and a process restart resumes
 * exactly where the spool left off. A crash after upload-confirm but before
 * delete re-uploads one chunk; `(run_id, seq)` idempotency makes that a
 * server-side no-op.
 *
 * Layout (under the agent DATA dir, never the tailed project):
 *   <dir>/00000001.json      one chunk = one IngestBatchRequest (single run,
 *   <dir>/00000002.json      ≤ batch-size events), name = monotonic counter
 *   <dir>/00000007.json.rejected   a NACKed (non-retryable) chunk, set aside
 *
 * Chunks are only ever written by `append` and removed by `remove`/`reject`.
 * Contents are ALREADY privacy-filtered — the filter runs before anything is
 * persisted, so no above-tier content ever exists on the shipper's disk.
 *
 * BOUNDED (drop policy): the spool caps the total buffered EVENT count
 * (`maxEvents`). When an append would exceed the cap, the OLDEST chunks are
 * dropped first (ring-buffer semantics: a long outage keeps the freshest
 * telemetry; the server sees an explicit seq gap, making the loss auditable)
 * and every drop is reported to the caller for ERROR-level logging — never
 * silent. `.rejected` chunks do not count against the cap.
 */

import { join } from 'node:path';
import type { ShipperFileSystem } from './fs';
import type { IngestBatchRequest } from './wire-ingest';

export const DEFAULT_SPOOL_MAX_EVENTS = 10_000;

export interface SpoolChunk {
  /** File name, e.g. `00000042.json` (sort key — oldest first). */
  name: string;
  batch: IngestBatchRequest;
}

export interface SpoolDrop {
  name: string;
  runId: string;
  /** Inclusive seq range of the dropped events. */
  firstSeq: number;
  lastSeq: number;
  eventCount: number;
}

const CHUNK_RE = /^\d{8}\.json$/;

export class Spool {
  private counter = 0;
  private eventCount_ = 0;
  private names: string[] = []; // pending chunk names, oldest first
  private loaded = false;

  constructor(
    private readonly fs: ShipperFileSystem,
    private readonly dir: string,
    private readonly maxEvents = DEFAULT_SPOOL_MAX_EVENTS
  ) {}

  /** Scan the spool dir (restart recovery). Idempotent. */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const entries = this.fs.listDir(this.dir) ?? [];
    this.names = entries
      .filter((e) => !e.isDirectory && CHUNK_RE.test(e.name))
      .map((e) => e.name)
      .sort();
    for (const name of this.names) {
      const batch = this.read(name);
      this.eventCount_ += batch?.events.length ?? 0;
      const numeric = Number.parseInt(name, 10);
      if (Number.isFinite(numeric)) this.counter = Math.max(this.counter, numeric);
    }
  }

  /** Total buffered events across pending chunks. */
  get eventCount(): number {
    this.ensureLoaded();
    return this.eventCount_;
  }

  /** Pending chunk count. */
  get chunkCount(): number {
    this.ensureLoaded();
    return this.names.length;
  }

  private read(name: string): IngestBatchRequest | null {
    const text = this.fs.readFileText(join(this.dir, name));
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as IngestBatchRequest;
      if (typeof parsed.run_id !== 'string' || !Array.isArray(parsed.events)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Durably append one batch, then enforce the cap. Returns the chunks
   * DROPPED (oldest-first) to honor the bound — the caller MUST log them.
   */
  append(batch: IngestBatchRequest): { name: string; dropped: SpoolDrop[] } {
    this.ensureLoaded();
    this.fs.mkdirp(this.dir);
    this.counter += 1;
    const name = `${String(this.counter).padStart(8, '0')}.json`;
    this.fs.writeFileText(join(this.dir, name), JSON.stringify(batch));
    this.names.push(name);
    this.eventCount_ += batch.events.length;

    const dropped: SpoolDrop[] = [];
    while (this.eventCount_ > this.maxEvents && this.names.length > 1) {
      const oldest = this.names[0]!;
      const oldBatch = this.read(oldest);
      this.removeByName(oldest);
      if (oldBatch !== null && oldBatch.events.length > 0) {
        dropped.push({
          name: oldest,
          runId: oldBatch.run_id,
          firstSeq: oldBatch.events[0]!.seq,
          lastSeq: oldBatch.events[oldBatch.events.length - 1]!.seq,
          eventCount: oldBatch.events.length,
        });
      }
    }
    return { name, dropped };
  }

  /** The oldest pending chunk, or null when the spool is drained. Skips (and
   *  forgets) chunks that went unreadable on disk. */
  oldest(): SpoolChunk | null {
    this.ensureLoaded();
    while (this.names.length > 0) {
      const name = this.names[0]!;
      const batch = this.read(name);
      if (batch !== null) return { name, batch };
      this.removeByName(name); // corrupt/vanished chunk — drop bookkeeping
    }
    return null;
  }

  /** Delete a confirmed-uploaded chunk. */
  remove(name: string): void {
    this.ensureLoaded();
    this.removeByName(name);
  }

  /** Set a NACKed (non-retryable) chunk aside as `<name>.rejected` — kept on
   *  disk for forensics, excluded from the drain and the cap. */
  reject(name: string): void {
    this.ensureLoaded();
    const index = this.names.indexOf(name);
    if (index < 0) return;
    const batch = this.read(name);
    this.names.splice(index, 1);
    this.eventCount_ -= batch?.events.length ?? 0;
    try {
      this.fs.rename(join(this.dir, name), join(this.dir, `${name}.rejected`));
    } catch {
      this.fs.remove(join(this.dir, name)); // rename failed — delete instead
    }
  }

  private removeByName(name: string): void {
    const index = this.names.indexOf(name);
    if (index < 0) return;
    const batch = this.read(name);
    this.names.splice(index, 1);
    this.eventCount_ -= batch?.events.length ?? 0;
    this.fs.remove(join(this.dir, name));
  }
}
