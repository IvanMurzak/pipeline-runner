/**
 * `uploadDepartmentArtifact` (department-mesh task d3) — the pure upload
 * function independent of `DepartmentManager`'s wiring (that integration is
 * covered by `./manager.artifacts.test.ts`). Exercises:
 *
 *   - chunking at 256 KiB and byte-exact reassembly (verified two ways: every
 *     frame validates against the REAL `DeptArtifactMessageSchema` from
 *     `@baizor/pipeline-protocol` — the same schema the cloud gateway parses
 *     inbound frames with before `mesh-artifacts/reassembly.ts` ever sees
 *     them — and an independent local re-implementation of that reassembler's
 *     concatenation algorithm reproduces the ORIGINAL bytes exactly);
 *   - every cap (1 MiB/artifact, 8 MiB/task, 64 KiB inline) rejects BEFORE
 *     `send` is called, with a reason naming the offending size and the cap;
 *   - a `path` artifact is size-checked via `statSize` BEFORE `readFile` is
 *     ever called — an over-cap file on disk is never read into memory;
 *   - a connection drop mid-chunk-stream is reported rejected, not retried.
 */

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { DeptArtifactMessageSchema } from '@baizor/pipeline-protocol';
import { CaptureLogger } from '../../tests/_helpers';
import type { WireFrame } from '../core/wire';
import type { ArtifactFileSystem, ArtifactUploadInput } from './artifact-upload';
import {
  ARTIFACT_WIRE_CHUNK_BYTES,
  INLINE_ARTIFACT_BYTES_LIMIT,
  MAX_ARTIFACT_BYTES,
  MAX_TASK_ARTIFACT_BYTES,
  uploadDepartmentArtifact,
} from './artifact-upload';

function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Deterministic filler content — not all-zero, so a truncation bug (fewer
 *  distinct bytes than expected) would not accidentally still checksum-match
 *  a short slice of itself. */
function content(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

class FrameSink {
  frames: WireFrame[] = [];
  /** When set, `send` returns false starting at this 0-based call index
   *  (simulates the connection dropping mid-upload). */
  failFromCall: number | null = null;
  private calls = 0;

  send = (frame: WireFrame): boolean => {
    const callIndex = this.calls++;
    if (this.failFromCall !== null && callIndex >= this.failFromCall) return false;
    this.frames.push(frame);
    return true;
  };
}

class FakeArtifactFs implements ArtifactFileSystem {
  files = new Map<string, Uint8Array>();
  readFileCalls: string[] = [];
  statSizeCalls: string[] = [];

  put(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
  }

  statSize(path: string): number | null {
    this.statSizeCalls.push(path);
    return this.files.get(path)?.byteLength ?? null;
  }

  readFile(path: string): Uint8Array | null {
    this.readFileCalls.push(path);
    return this.files.get(path) ?? null;
  }
}

/**
 * Independent re-implementation of `mesh-artifacts/reassembly.ts`'s
 * concatenation step (cloud repo, task c9): decode each chunk's base64
 * `bytes` and concatenate them in `chunk_index` order. Deliberately
 * reimplemented here rather than imported — the two repos do not share code
 * — so this test proves byte-fidelity against the DESCRIBED algorithm (08 §6:
 * "chunking at 256 KiB per frame"), not merely against itself.
 */
function reassemble(frames: WireFrame[]): Uint8Array {
  const sorted = [...frames].sort((a, b) => (a.chunk_index as number) - (b.chunk_index as number));
  const total = sorted.reduce((sum, f) => sum + Buffer.from(f.bytes as string, 'base64').byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of sorted) {
    const chunk = Buffer.from(f.bytes as string, 'base64');
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function baseInput(overrides: Partial<ArtifactUploadInput> = {}): ArtifactUploadInput {
  return {
    executionId: 'dexec-1',
    taskId: 'dtask-1',
    name: 'review.md',
    mediaType: 'text/markdown',
    ...overrides,
  };
}

describe('uploadDepartmentArtifact — chunking, checksum, byte-exact reassembly', () => {
  test('a multi-chunk report artifact (path-sourced) chunks at 256 KiB, every frame validates against the real wire schema, and reassembly is byte-exact', () => {
    const bytes = content(600 * 1024); // 600 KiB -> 3 chunks (256 + 256 + 88)
    const fs = new FakeArtifactFs();
    fs.put('/work/out/review.md', bytes);
    const sink = new FrameSink();

    const outcome = uploadDepartmentArtifact(baseInput({ path: '/work/out/review.md' }), {
      send: sink.send,
      bytesAlreadySentForTask: 0,
      fs,
    });

    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') throw new Error('unreachable');
    expect(outcome.size).toBe(bytes.byteLength);
    expect(outcome.checksum).toBe(sha256Hex(bytes));
    expect(outcome.chunkTotal).toBe(3);

    expect(sink.frames).toHaveLength(3);
    for (const [i, frame] of sink.frames.entries()) {
      expect(frame.type).toBe('department.artifact');
      expect(frame.chunk_index).toBe(i);
      expect(frame.chunk_total).toBe(3);
      expect(frame.size).toBe(bytes.byteLength);
      expect(frame.checksum).toBe(sha256Hex(bytes));
      expect(frame.execution_id).toBe('dexec-1');
      expect(frame.task_id).toBe('dtask-1');
      expect(frame.name).toBe('review.md');
      expect(frame.media_type).toBe('text/markdown');
      // The REAL wire schema from @baizor/pipeline-protocol — the exact
      // shape the cloud gateway validates inbound `department.artifact`
      // frames against before c9's assembler ever sees them.
      expect(DeptArtifactMessageSchema.safeParse(frame).success).toBe(true);
    }
    expect(sink.frames[0]!.bytes && Buffer.from(sink.frames[0]!.bytes as string, 'base64').byteLength).toBe(ARTIFACT_WIRE_CHUNK_BYTES);
    expect(sink.frames[1]!.bytes && Buffer.from(sink.frames[1]!.bytes as string, 'base64').byteLength).toBe(ARTIFACT_WIRE_CHUNK_BYTES);
    expect(sink.frames[2]!.bytes && Buffer.from(sink.frames[2]!.bytes as string, 'base64').byteLength).toBe(600 * 1024 - 2 * ARTIFACT_WIRE_CHUNK_BYTES);

    const reassembled = reassemble(sink.frames);
    expect(Buffer.compare(Buffer.from(reassembled), Buffer.from(bytes))).toBe(0);
    expect(sha256Hex(reassembled)).toBe(outcome.checksum);

    // stat-then-read order, exactly once each.
    expect(fs.statSizeCalls).toEqual(['/work/out/review.md']);
    expect(fs.readFileCalls).toEqual(['/work/out/review.md']);
  });

  test('an artifact under one chunk (inline bytes) sends exactly one chunk', () => {
    const bytes = content(1024); // 1 KiB, well under both the inline cap and the wire chunk size
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput({ name: 'summary.txt', mediaType: 'text/plain', bytes }), {
      send: sink.send,
      bytesAlreadySentForTask: 0,
    });
    expect(outcome).toEqual({ status: 'sent', size: 1024, checksum: sha256Hex(bytes), chunkTotal: 1 });
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]!.chunk_index).toBe(0);
    expect(sink.frames[0]!.chunk_total).toBe(1);
    expect(DeptArtifactMessageSchema.safeParse(sink.frames[0]).success).toBe(true);
  });

  test('an artifact exactly a multiple of the wire chunk size has no empty trailing chunk', () => {
    const bytes = content(2 * ARTIFACT_WIRE_CHUNK_BYTES); // exactly 512 KiB
    const fs = new FakeArtifactFs();
    fs.put('/a', bytes);
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput({ path: '/a' }), { send: sink.send, bytesAlreadySentForTask: 0, fs });
    expect(outcome.status).toBe('sent');
    if (outcome.status !== 'sent') throw new Error('unreachable');
    expect(outcome.chunkTotal).toBe(2);
    expect(sink.frames).toHaveLength(2);
  });
});

describe('uploadDepartmentArtifact — caps are enforced runner-first, rejection is explicit, never silent truncation', () => {
  test('an over-per-artifact-cap file is rejected via statSize BEFORE readFile is ever called, and nothing is sent', () => {
    const fs = new FakeArtifactFs();
    fs.put('/big/report.json', content(MAX_ARTIFACT_BYTES + 1));
    const sink = new FrameSink();
    const logger = new CaptureLogger();

    const outcome = uploadDepartmentArtifact(baseInput({ name: 'report.json', path: '/big/report.json' }), {
      send: sink.send,
      bytesAlreadySentForTask: 0,
      fs,
      logger,
    });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toContain('report.json');
    expect(outcome.reason).toContain('per-artifact limit');
    expect(outcome.reason).toContain('rejected before upload, not truncated');
    expect(sink.frames).toHaveLength(0);
    expect(fs.statSizeCalls).toEqual(['/big/report.json']);
    expect(fs.readFileCalls).toEqual([]); // never read the oversize file into memory
    expect(logger.lines.some((l) => l.startsWith('warn:') && l.includes('per-artifact limit'))).toBe(true);
  });

  test('over-per-artifact-cap inline bytes are rejected (belt-and-braces path, independent of the 64 KiB inline cap)', () => {
    // Larger than the per-artifact cap but delivered inline (a hypothetical
    // future adapter that does not itself enforce the 64 KiB inline limit) —
    // the inline-cap check catches it first since it is the tighter bound.
    const bytes = content(MAX_ARTIFACT_BYTES + 1);
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput({ bytes }), { send: sink.send, bytesAlreadySentForTask: 0 });
    expect(outcome.status).toBe('rejected');
    expect(sink.frames).toHaveLength(0);
  });

  test('inline bytes at/over the 64 KiB inline cap are rejected, naming the cap and suggesting a path', () => {
    const bytes = content(INLINE_ARTIFACT_BYTES_LIMIT); // AT the cap — "at/over" per 07 §3
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput({ bytes }), { send: sink.send, bytesAlreadySentForTask: 0 });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toContain('inline-bytes cap');
    expect(outcome.reason).toContain('use a path instead');
    expect(sink.frames).toHaveLength(0);
  });

  test('an artifact that would push the running per-task total over 8 MiB is rejected before any chunk is sent', () => {
    const bytes = content(1024);
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput({ bytes }), {
      send: sink.send,
      bytesAlreadySentForTask: MAX_TASK_ARTIFACT_BYTES, // already AT the cap
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toContain('dtask-1');
    expect(outcome.reason).toContain('per-task limit');
    expect(sink.frames).toHaveLength(0);
  });

  test('an artifact exactly at the remaining per-task budget is accepted (boundary is ">", not ">=")', () => {
    const bytes = content(1024);
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput({ bytes }), {
      send: sink.send,
      bytesAlreadySentForTask: MAX_TASK_ARTIFACT_BYTES - 1024,
    });
    expect(outcome.status).toBe('sent');
  });

  test('an empty (0-byte) artifact is rejected explicitly, never sent as a degenerate empty frame', () => {
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput({ bytes: new Uint8Array(0) }), { send: sink.send, bytesAlreadySentForTask: 0 });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toContain('empty');
    expect(sink.frames).toHaveLength(0);
  });

  test('an artifact with neither bytes nor a path is rejected explicitly', () => {
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput(), { send: sink.send, bytesAlreadySentForTask: 0 });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toContain('neither inline bytes nor a path');
  });

  test('a path that cannot be stat\'d (missing file) is rejected explicitly, readFile never called', () => {
    const fs = new FakeArtifactFs(); // empty — nothing at this path
    const sink = new FrameSink();
    const outcome = uploadDepartmentArtifact(baseInput({ path: '/missing' }), { send: sink.send, bytesAlreadySentForTask: 0, fs });
    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toContain('could not be read');
    expect(fs.readFileCalls).toEqual([]);
  });

  test('a connection drop mid-chunk-stream is reported rejected, not retried, and no further chunks are sent after the failure', () => {
    const bytes = content(3 * ARTIFACT_WIRE_CHUNK_BYTES); // 3 chunks
    const fs = new FakeArtifactFs();
    fs.put('/a', bytes);
    const sink = new FrameSink();
    sink.failFromCall = 1; // first chunk sends fine, second call (chunk 1) fails
    const logger = new CaptureLogger();

    const outcome = uploadDepartmentArtifact(baseInput({ path: '/a' }), { send: sink.send, bytesAlreadySentForTask: 0, fs, logger });

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') throw new Error('unreachable');
    expect(outcome.reason).toContain('aborted mid-transfer');
    expect(sink.frames).toHaveLength(1); // only chunk 0 actually landed in the sink
    expect(logger.lines.some((l) => l.startsWith('warn:') && l.includes('aborted mid-transfer'))).toBe(true);
  });
});
