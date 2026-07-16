/**
 * Byte-accurate journal tail for `events.jsonl` (append-only NDJSON).
 *
 * Rebuilt properly from the Phase-0 spike shipper (spike-report §7): the tail
 * only ever advances to a NEWLINE boundary (0x0A is always a UTF-8 char
 * boundary), so decoding never splits a multibyte character and a half-written
 * trailing line is buffered until its newline arrives.
 *
 * Positions:
 *   - `readOffset`  — bytes physically consumed from the file.
 *   - `parseOffset` — bytes through the LAST COMPLETE LINE (readOffset minus
 *     the buffered partial line). This is the value the shipper persists in
 *     its cursor: resuming from it never re-reads a consumed line and never
 *     skips one.
 *
 * Rotation/truncation: when the file shrinks below `readOffset` the tail
 * resets to position 0 (new file). Per-run seq state is NOT the tail's
 * concern — the shipper keeps counters across rotations so a run spanning a
 * rotation keeps a monotonic seq (already-shipped events dedup server-side).
 */

import type { ShipperFileSystem } from './fs';

export interface TailPoll {
  /** Complete journal lines (CR-stripped, empty lines removed), file order. */
  lines: string[];
  /** Byte position through the last complete line — the cursor value. */
  parseOffset: number;
  /** True when a shrink/rotation reset positions this poll. */
  rotated: boolean;
}

export class JournalTail {
  private readOffset: number;
  private pending: Uint8Array = new Uint8Array(0);

  constructor(
    private readonly fs: ShipperFileSystem,
    private readonly path: string,
    resumeOffset = 0
  ) {
    this.readOffset = Math.max(0, resumeOffset);
  }

  /** Byte position through the last complete parsed line. */
  get parseOffset(): number {
    return this.readOffset - this.pending.length;
  }

  /** Read newly-appended complete lines (empty result when nothing new). */
  poll(): TailPoll {
    let rotated = false;
    const size = this.fs.statSize(this.path);
    if (size === null) return { lines: [], parseOffset: this.parseOffset, rotated };

    // Truncation / rotation: the path now points at a shorter (new) file.
    if (size < this.readOffset) {
      this.readOffset = 0;
      this.pending = new Uint8Array(0);
      rotated = true;
    }
    if (size === this.readOffset) return { lines: [], parseOffset: this.parseOffset, rotated };

    const chunk = this.fs.readRange(this.path, this.readOffset, size);
    if (chunk.length === 0) return { lines: [], parseOffset: this.parseOffset, rotated };
    this.readOffset += chunk.length;

    const combined = new Uint8Array(this.pending.length + chunk.length);
    combined.set(this.pending, 0);
    combined.set(chunk, this.pending.length);

    const lastNl = combined.lastIndexOf(0x0a);
    if (lastNl < 0) {
      this.pending = combined; // no complete line yet — keep buffering
      return { lines: [], parseOffset: this.parseOffset, rotated };
    }
    const completeBytes = combined.subarray(0, lastNl + 1);
    this.pending = combined.slice(lastNl + 1); // copy — combined is transient

    const lines = new TextDecoder()
      .decode(completeBytes)
      .split('\n')
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)) // tolerate CRLF journals
      .filter((line) => line !== '');
    return { lines, parseOffset: this.parseOffset, rotated };
  }
}
