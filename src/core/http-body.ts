/**
 * Release the socket behind a `fetch` response we are not going to read.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * A `Response` from `fetch` owns a live handle — the socket (or, on a keep-alive
 * pool, the connection's claim on it) stays checked out until the body is
 * consumed (`.json()`, `.text()`, …) or explicitly cancelled. Dropping the
 * `Response` on the floor does NOT release it: the runtime only reclaims the
 * handle when the object is garbage-collected, and GC is under no obligation to
 * run at any particular time. In a request/response script that is invisible.
 * In this daemon it is not — every fetch here lives inside a loop that runs for
 * the lifetime of the machine:
 *
 *   - `shipper/upload-transport.ts` — retried by `Shipper.drain`'s backoff timer
 *     for as long as the control plane keeps answering 5xx;
 *   - `core/transport.ts` — the long-poll cycle, re-armed by `core/connection.ts`
 *     on every reconnect.
 *
 * So an early `return` on a non-2xx status — the exact path that skips
 * `.json()` — leaks one handle per cycle, without bound. A user reported ~5,500
 * live handles after ~5,350 poll cycles: one per poll, none ever reclaimed,
 * until the process hits the open-file limit.
 *
 * The fix is one line at each early exit, so it belongs in one place rather than
 * being re-derived (and eventually forgotten) at every call site. Call it on
 * EVERY path that abandons a response without reading it — status branches,
 * `catch` blocks, and the "we were closed while the request was in flight"
 * races.
 *
 * Never throws and never rejects: a body that is already read, already errored,
 * or locked by another reader has nothing left to release, and a caller on an
 * error path must not acquire a new failure mode from its own cleanup.
 */

/** The only part of a `Response` this needs — so a partial test double works too. */
export interface HasOptionalBody {
  readonly body?: ReadableStream<Uint8Array> | null;
}

/**
 * Cancel `res`'s unread body so its underlying handle is released now instead
 * of at the next GC. Safe to `await` on any exit path: it resolves even when
 * there is no body (a 204, a `Response(null)`) or the stream is already gone.
 */
export async function discardBody(res: HasOptionalBody | null | undefined): Promise<void> {
  try {
    await res?.body?.cancel();
  } catch {
    // Already consumed, already errored, or locked by another reader — in every
    // one of those cases the handle is not ours to release any more.
  }
}
