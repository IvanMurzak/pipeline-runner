/**
 * Event shipper (T1-12) — tails `events.jsonl` + `.stats` artifacts, filters
 * them by privacy tier AGENT-SIDE (metadata default), assigns the per-run
 * `seq`, batches, buffers durably on disk, and uploads idempotently through
 * an injectable transport. NOT yet wired into the agent main loop (a later
 * task); `src/index.ts` intentionally does not re-export it until then.
 */

export * from './wire-ingest';
export * from './fs';
export * from './privacy';
export * from './tail';
export * from './cursor';
export * from './spool';
export * from './upload-transport';
export * from './stats';
export * from './shipper';
