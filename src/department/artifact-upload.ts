/**
 * `department.artifact` chunked, capped upload (department-mesh task d3;
 * `08-protocol-delta.md` §6, `09-infra-and-artifacts.md` §3.1, task c9's
 * cloud-side counterpart: `cloud/apps/api/src/modules/mesh-artifacts/`).
 *
 * Artifacts do NOT ride the event-ingest/shipper path (07 §8 — that path is
 * tier-filtered telemetry; artifacts are first-class task data). They get
 * this dedicated frame with its own caps, enforced HERE, on the runner,
 * BEFORE a single byte crosses the wire:
 *
 *   - a declared `path` is STAT'd first and refused if it is already over
 *     the per-artifact cap — a hostile or buggy runtime cannot make this
 *     process read an arbitrarily large file into memory just to reject it
 *     (mirrors the cloud assembler's own "refuse before buffering anything",
 *     `mesh-artifacts/reassembly.ts`'s module doc);
 *   - inline `bytes` (no `path`) are legal only under
 *     {@link INLINE_ARTIFACT_BYTES_LIMIT} (64 KiB, 07 §3) — `jsonl-process.ts`
 *     already enforces this at parse time for ITS runtimes, but this is
 *     re-checked here so every OTHER adapter that might ever hand a
 *     `RuntimeEvent` with inline `bytes` gets the same guarantee, not an
 *     adapter-specific one;
 *   - a per-artifact cap of {@link MAX_ARTIFACT_BYTES} (1 MiB) and a
 *     runner-tracked per-task running total capped at
 *     {@link MAX_TASK_ARTIFACT_BYTES} (8 MiB) — the runner-side half of 09
 *     §3.1's "enforced on the runner FIRST"; the cloud re-checks the
 *     AUTHORITATIVE per-task total (summed from `dept_artifacts`, which
 *     outlives any one runner process or execution) on insert, since this
 *     process only knows what IT has sent since it last started;
 *   - chunking at {@link ARTIFACT_WIRE_CHUNK_BYTES} (256 KiB) per frame,
 *     `checksum` = sha256 hex of the WHOLE artifact — exactly what
 *     `mesh-artifacts/reassembly.ts`'s `ArtifactAssembler` expects.
 *
 * REJECTION IS ALWAYS EXPLICIT; SILENT TRUNCATION IS FORBIDDEN. There is
 * deliberately no branch anywhere below that sends a prefix of an over-cap
 * artifact and calls it done — every cap violation returns
 * `{ status: 'rejected', reason }` before `deps.send` is ever called, and
 * the caller (`./manager.ts`) logs that reason at `warn`, never swallows it.
 */

import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import type { DeptArtifactMessage } from '@baizor/pipeline-protocol';
import type { Logger } from '../core/log';
import { nullLogger } from '../core/log';
import type { WireFrame } from '../core/wire';

/** Max bytes for ONE artifact — 1 MiB (09 §3.1). Mirrors the cloud's
 *  `MAX_ARTIFACT_BYTES` (`cloud/apps/api/src/http/caps.ts`) exactly — the two
 *  repos are separate, so this is a deliberately duplicated normative
 *  constant, not a shared import. */
export const MAX_ARTIFACT_BYTES = 1024 * 1024;

/** Max cumulative artifact bytes THIS RUNNER PROCESS will push for one task
 *  before refusing further uploads for it — 8 MiB (09 §3.1). Tracked
 *  per-`taskId` by the caller (`./manager.ts`'s `taskArtifactBytesSent`) and
 *  passed in as `bytesAlreadySentForTask`; resets on runner restart and does
 *  not see bytes another runner (or a prior attempt) already sent — a
 *  best-effort, runner-first gate. The cloud's own check
 *  (`mesh-artifacts/service.ts`) is the AUTHORITATIVE one: it sums every row
 *  actually stored for the task, regardless of which runner or execution
 *  wrote it. */
export const MAX_TASK_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Wire chunk size — 256 KiB (08 §6 / 09 §3.1). A 1 MiB artifact is at most
 *  4 chunks, matching `cloud/apps/api/src/http/caps.ts`'s
 *  `ARTIFACT_WIRE_CHUNK_BYTES`. */
export const ARTIFACT_WIRE_CHUNK_BYTES = 256 * 1024;

/** Inline `bytes` (no `path`) are legal only under this ceiling (07 §3) —
 *  same value `jsonl-process.ts`'s `INLINE_ARTIFACT_BYTES_LIMIT` enforces at
 *  parse time for JSONL runtimes; duplicated (not imported) so this module
 *  has no dependency on any one adapter. */
export const INLINE_ARTIFACT_BYTES_LIMIT = 64 * 1024;

// ── Injectable filesystem seam (mirrors `../shipper/fs.ts`'s sync-port style:
//    artifact reads are small — capped at 1 MiB — and bursty, so sync I/O is
//    fine and keeps this module trivially testable with an in-memory fake) ──

export interface ArtifactFileSystem {
  /** File size in bytes, or null if the file does not exist / is not a
   *  regular file / cannot be stat'd. Called BEFORE any read. */
  statSize(path: string): number | null;
  /** Read the whole file. Only ever called after `statSize` returned a
   *  value at/under {@link MAX_ARTIFACT_BYTES}. Returns null on any read
   *  error (e.g. the file vanished between stat and read). */
  readFile(path: string): Uint8Array | null;
}

export function nodeArtifactFs(): ArtifactFileSystem {
  return {
    statSize: (path) => {
      try {
        const st = nodeFs.statSync(path);
        return st.isFile() ? st.size : null;
      } catch {
        return null;
      }
    },
    readFile: (path) => {
      try {
        return new Uint8Array(nodeFs.readFileSync(path));
      } catch {
        return null;
      }
    },
  };
}

// ── Public shapes ────────────────────────────────────────────────────────────

export interface ArtifactUploadInput {
  executionId: string;
  taskId: string;
  name: string;
  mediaType: string;
  /** Inline payload — legal only under {@link INLINE_ARTIFACT_BYTES_LIMIT}.
   *  Exactly one of `bytes`/`path` is expected (mirrors `RuntimeEvent`'s
   *  `artifact` variant, `./adapter.ts`); both absent, or both present, is
   *  tolerated by preferring `bytes` (matches `jsonl-process.ts`'s own
   *  narrowing, which never produces both). */
  bytes?: Uint8Array;
  /** A path on disk — read, size-checked, then uploaded (07 §3). */
  path?: string;
}

export type ArtifactUploadOutcome =
  | { status: 'sent'; size: number; checksum: string; chunkTotal: number }
  | { status: 'rejected'; reason: string };

export interface ArtifactUploadDeps {
  /** Send one wire frame; false = not connected right now. */
  send(frame: WireFrame): boolean;
  /** Bytes this runner process has already SENT (not yet necessarily
   *  cloud-confirmed — see the module doc) for `input.taskId`'s other
   *  artifacts. The per-task cap check below is against
   *  `bytesAlreadySentForTask + thisArtifact'sSize`. */
  bytesAlreadySentForTask: number;
  fs?: ArtifactFileSystem;
  logger?: Logger;
}

function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Human-readable byte size for rejection messages — mirrors the cloud's own
 *  `mesh-artifacts/service.ts#formatBytes` (independently, not imported: a
 *  cosmetic helper, not a normative constant). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const scaled =
    bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${scaled} (${bytes} B)`;
}

function resolveContent(
  input: ArtifactUploadInput,
  fs: ArtifactFileSystem,
): { ok: true; content: Uint8Array } | { ok: false; reason: string } {
  if (input.bytes !== undefined) {
    if (input.bytes.byteLength >= INLINE_ARTIFACT_BYTES_LIMIT) {
      return {
        ok: false,
        reason:
          `artifact "${input.name}" inline bytes are ${formatBytes(input.bytes.byteLength)}, ` +
          `at/over the ${formatBytes(INLINE_ARTIFACT_BYTES_LIMIT)} inline-bytes cap — use a path instead — ` +
          `rejected, not truncated`,
      };
    }
    return { ok: true, content: input.bytes };
  }

  if (input.path === undefined) {
    return { ok: false, reason: `artifact "${input.name}" has neither inline bytes nor a path — nothing to upload` };
  }

  // STAT first — refuse an over-cap file before ever reading it into memory
  // (mirrors the cloud assembler's "refuse before buffering anything").
  const size = fs.statSize(input.path);
  if (size === null) {
    return { ok: false, reason: `artifact "${input.name}": path "${input.path}" could not be read (missing or not a file)` };
  }
  if (size > MAX_ARTIFACT_BYTES) {
    return {
      ok: false,
      reason:
        `artifact "${input.name}" is ${formatBytes(size)} on disk, over the ${formatBytes(MAX_ARTIFACT_BYTES)} ` +
        `per-artifact limit — rejected before upload, not truncated`,
    };
  }

  const content = fs.readFile(input.path);
  if (content === null) {
    return { ok: false, reason: `artifact "${input.name}": path "${input.path}" could not be read` };
  }
  return { ok: true, content };
}

/**
 * Upload one artifact: resolve its bytes (inline or from disk), enforce
 * every cap runner-side, then send it as one or more `department.artifact`
 * chunk frames. Returns `{status:'rejected', reason}` the instant ANY check
 * fails — nothing is ever sent for a rejected artifact, and a
 * partially-chunked send that hits a dead connection is reported as
 * rejected too (never retried into a second, possibly-duplicate attempt;
 * see the module doc's "abandon cleanly" note).
 */
export function uploadDepartmentArtifact(input: ArtifactUploadInput, deps: ArtifactUploadDeps): ArtifactUploadOutcome {
  const logger = deps.logger ?? nullLogger;
  const fs = deps.fs ?? nodeArtifactFs();

  const resolved = resolveContent(input, fs);
  if (!resolved.ok) {
    logger.warn(resolved.reason);
    return { status: 'rejected', reason: resolved.reason };
  }
  const { content } = resolved;

  if (content.byteLength === 0) {
    const reason = `artifact "${input.name}" is empty (0 bytes) — nothing to upload`;
    logger.warn(reason);
    return { status: 'rejected', reason };
  }

  // Per-artifact cap — belt-and-braces: the path branch above already
  // caught this via `statSize`; inline is already under 64 KiB (< 1 MiB);
  // this is the single choke point every future content source passes
  // through regardless of how it got its bytes.
  if (content.byteLength > MAX_ARTIFACT_BYTES) {
    const reason =
      `artifact "${input.name}" is ${formatBytes(content.byteLength)}, over the ${formatBytes(MAX_ARTIFACT_BYTES)} ` +
      `per-artifact limit — rejected before upload, not truncated`;
    logger.warn(reason);
    return { status: 'rejected', reason };
  }

  // Per-task cumulative cap (09 §3.1) — runner-first gate; see the module
  // doc for why this is best-effort rather than authoritative.
  if (deps.bytesAlreadySentForTask + content.byteLength > MAX_TASK_ARTIFACT_BYTES) {
    const reason =
      `task ${input.taskId} has already had ${formatBytes(deps.bytesAlreadySentForTask)} of artifacts uploaded ` +
      `this session; adding "${input.name}" (${formatBytes(content.byteLength)}) would exceed the ` +
      `${formatBytes(MAX_TASK_ARTIFACT_BYTES)} per-task limit — rejected before upload, not truncated`;
    logger.warn(reason);
    return { status: 'rejected', reason };
  }

  const checksum = sha256Hex(content);
  const size = content.byteLength;
  const chunkTotal = Math.ceil(size / ARTIFACT_WIRE_CHUNK_BYTES);

  for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex++) {
    const start = chunkIndex * ARTIFACT_WIRE_CHUNK_BYTES;
    const end = Math.min(start + ARTIFACT_WIRE_CHUNK_BYTES, size);
    const chunk = content.subarray(start, end);
    const frame: DeptArtifactMessage = {
      type: 'department.artifact',
      execution_id: input.executionId,
      task_id: input.taskId,
      name: input.name,
      media_type: input.mediaType,
      size,
      checksum,
      chunk_index: chunkIndex,
      chunk_total: chunkTotal,
      bytes: Buffer.from(chunk).toString('base64'),
    };
    if (!deps.send(frame)) {
      const reason = `artifact "${input.name}" upload aborted mid-transfer (chunk ${chunkIndex}/${chunkTotal}) — connection not online; not retried`;
      logger.warn(reason);
      return { status: 'rejected', reason };
    }
  }

  return { status: 'sent', size, checksum, chunkTotal };
}
