/**
 * Shipper ingest + upload wire shapes — sourced from the published
 * `@baizor/pipeline-protocol` package (repo
 * `github.com/IvanMurzak/pipeline-protocol`), which replaced the hand-rolled
 * vendored copy this file used to be (T8d de-vendoring).
 *
 * This module stays the shipper's single import point (`./wire-ingest`), so
 * internal import paths are unchanged. Surface:
 *   - `IngestEventRecord`  — one batched record: the SHIPPER-ASSIGNED `seq`
 *     (non-negative int) + the opaque event `payload`. Kept as a LOCAL type —
 *     see the note on it.
 *   - `IngestBatchRequest` — the batched-upload body `{ run_id, events }`
 *     (passthrough — extra fields ride along).
 *   - `IngestBatchResponse` — `{ run_id, inserted, skipped }`.
 *   - `UploadMessage`      — the WSS frame `{ type: "upload", id?, batch }`
 *     wrapping `IngestBatchRequest` VERBATIM.
 *   - `UploadAckMessage`   — `{ type: "upload_ack", id?, ack }` embedding
 *     `IngestBatchResponse` VERBATIM, plus the gateway's documented ADDITIVE
 *     `error` field on a NACK (kept as a LOCAL type extension — see the note).
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

import { IngestBatchResponseSchema, UploadAckMessageSchema } from '@baizor/pipeline-protocol';
import type {
  IngestBatchRequest,
  IngestBatchResponse,
  UploadAckMessage as ProtocolUploadAckMessage,
  UploadMessage,
} from '@baizor/pipeline-protocol';
import type { WireFrame } from '../core/wire';

// ── Protocol surface re-exported from the published package ─────────────────

export type { IngestBatchRequest, IngestBatchResponse, UploadMessage } from '@baizor/pipeline-protocol';

/**
 * One record in an ingest batch: the shipper-assigned `seq` + the opaque
 * event `payload`. `seq` is a non-negative integer (the store seeds its
 * replay cursor at -1); this shipper assigns from 1. `payload` is opaque to
 * the wire — normally a privacy-filtered shippable event envelope.
 *
 * KEPT LOCAL on purpose: the package's inferred `IngestEventRecord` type makes
 * `payload` OPTIONAL (`z.unknown()` infers an optional key; the schema asserts
 * presence only at runtime via `superRefine`), while the wire contract — and
 * this local type — REQUIRE it, so record construction stays compile-checked.
 * Structurally assignable to the package type wherever batches are built.
 */
export interface IngestEventRecord {
  seq: number;
  payload: unknown;
}

/**
 * `upload_ack` (server → agent) — the reply to an `upload`; echoes `id`.
 * `error` present ⇒ NACK: the batch was rejected (nothing stored), the ack
 * counters are zero, and retrying the same batch will not succeed.
 *
 * The `error` field is KEPT LOCAL on purpose: it is the gateway's documented
 * ADDITIVE NACK marker (private api `modules/gateway/engine.ts#handleUpload`)
 * and is not (yet) part of the package's `UploadAckMessageSchema` — it rides
 * the schema's `.passthrough()` on the wire, so this local extension types
 * (and `isUploadAck` validates) what the package leaves opaque.
 */
export type UploadAckMessage = ProtocolUploadAckMessage & { error?: string };

// ── Runtime guards for INBOUND (untrusted) payloads ──────────────────────────

/** Narrow an arbitrary JSON value to a well-formed `IngestBatchResponse`
 *  (shared by the WSS ack path and the HTTPS response body — one contract).
 *  Validates with the canonical zod schema but returns the ORIGINAL object,
 *  so extra fields (and reference identity) are preserved exactly. */
export function parseIngestBatchResponse(value: unknown): IngestBatchResponse | null {
  return IngestBatchResponseSchema.safeParse(value).success ? (value as IngestBatchResponse) : null;
}

/** Narrow a wire frame to a well-formed `upload_ack`: the canonical zod schema
 *  plus the local check on the gateway-additive `error` NACK marker. */
export function isUploadAck(frame: WireFrame): frame is UploadAckMessage {
  return (
    UploadAckMessageSchema.safeParse(frame).success &&
    (frame.error === undefined || typeof frame.error === 'string')
  );
}

// ── Frame builder (runner-local; the package ships schemas, not builders) ───

/** Build an `upload` frame (the `id` pairs the eventual `upload_ack`). */
export function buildUploadFrame(batch: IngestBatchRequest, id: string): UploadMessage {
  return { type: 'upload', id, batch };
}
