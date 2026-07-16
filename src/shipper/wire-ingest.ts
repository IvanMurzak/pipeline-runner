/**
 * VENDORED from ai-pipeline `packages/protocol/src/ingest` + the `upload` /
 * `upload_ack` frames of `packages/protocol/src/wire` — source of truth;
 * replace with the published `@ai-pipeline/protocol` package once available
 * (npm publish blocked). Extends the T1-11 vendoring pattern of
 * `../core/wire.ts` — field names, optionality, and semantics match the zod
 * schemas 1:1; verify against the source on every sync.
 *
 * Vendored subset (exactly what the SHIPPER needs — nothing more):
 *   - `IngestEventRecord`  — one batched record: the SHIPPER-ASSIGNED `seq`
 *     (non-negative int) + the opaque event `payload` (`ingest/index.ts`).
 *   - `IngestBatchRequest` — the batched-upload body `{ run_id, events }`
 *     (`ingest/index.ts`; passthrough — extra fields ride along).
 *   - `IngestBatchResponse` — `{ run_id, inserted, skipped }`
 *     (`ingest/index.ts`).
 *   - `UploadMessage`      — the WSS frame `{ type: "upload", id?, batch }`
 *     wrapping `IngestBatchRequest` VERBATIM (`wire/client.ts`).
 *   - `UploadAckMessage`   — `{ type: "upload_ack", id?, ack }` embedding
 *     `IngestBatchResponse` VERBATIM, plus the gateway's documented ADDITIVE
 *     `error` field on a NACK: `error` present ⇒ nothing was stored, the batch
 *     was rejected as malformed (non-retryable) — see the private api
 *     `modules/gateway/engine.ts#handleUpload` (`wire/server.ts`).
 *
 * ── The `(run_id, seq)` idempotency contract (spike-report G1) ──────────────
 * Events on disk carry NO `seq`; the SHIPPER is the sequence authority — it
 * assigns a per-run monotonic `seq` and ingest is idempotent on `(run_id,
 * seq)` (`INSERT … ON CONFLICT DO NOTHING`). Retries, overlaps and duplicate
 * batches are safe. INVARIANT: exactly ONE shipper per journal.
 *
 * ── Transport note (ARCHITECTURE reconciliation) ────────────────────────────
 * ARCHITECTURE §1 names HTTPS `POST /ingest` the canonical upload transport;
 * the WSS `upload` frame wraps the SAME batch schema so there is ONE
 * idempotency contract regardless of transport. Today the control plane's
 * HTTP route (`POST /api/v1/ingest`) authenticates PAT/session callers only —
 * runner-token auth exists solely on the WSS gateway — so the shipper's
 * default transport is the WSS frame (see `./upload-transport.ts`).
 */

import type { WireFrame } from '../core/wire';

/**
 * One record in an ingest batch: the shipper-assigned `seq` + the opaque
 * event `payload`. `seq` is a non-negative integer (the store seeds its
 * replay cursor at -1); this shipper assigns from 1. `payload` is opaque to
 * the wire — normally a privacy-filtered shippable event envelope.
 */
export interface IngestEventRecord {
  seq: number;
  payload: unknown;
}

/** The batched-upload REQUEST body (passthrough: extra fields tolerated). */
export interface IngestBatchRequest {
  [field: string]: unknown;
  run_id: string;
  events: IngestEventRecord[];
}

/** The ingest RESPONSE: how many records were newly stored vs. deduped. */
export interface IngestBatchResponse {
  [field: string]: unknown;
  run_id: string;
  inserted: number;
  skipped: number;
}

/** `upload` (agent → server): a batched, idempotent event upload. Set `id` to
 *  pair the `upload_ack`. */
export interface UploadMessage extends WireFrame {
  type: 'upload';
  batch: IngestBatchRequest;
}

/**
 * `upload_ack` (server → agent) — the reply to an `upload`; echoes `id`.
 * `error` present ⇒ NACK: the batch was rejected (nothing stored), the ack
 * counters are zero, and retrying the same batch will not succeed.
 */
export interface UploadAckMessage extends WireFrame {
  type: 'upload_ack';
  ack: IngestBatchResponse;
  /** ADDITIVE NACK marker (gateway `handleUpload`): rejection detail. */
  error?: string;
}

// ── Runtime guards for INBOUND (untrusted) payloads ──────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Narrow an arbitrary JSON value to a well-formed `IngestBatchResponse`
 *  (shared by the WSS ack path and the HTTPS response body — one contract). */
export function parseIngestBatchResponse(value: unknown): IngestBatchResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record.run_id)) return null;
  if (!isNonNegativeInt(record.inserted) || !isNonNegativeInt(record.skipped)) return null;
  return record as IngestBatchResponse;
}

/** Narrow a wire frame to a well-formed `upload_ack`. */
export function isUploadAck(frame: WireFrame): frame is UploadAckMessage {
  return (
    frame.type === 'upload_ack' &&
    parseIngestBatchResponse(frame.ack) !== null &&
    (frame.error === undefined || typeof frame.error === 'string')
  );
}

/** Build an `upload` frame (the `id` pairs the eventual `upload_ack`). */
export function buildUploadFrame(batch: IngestBatchRequest, id: string): UploadMessage {
  return { type: 'upload', id, batch };
}
