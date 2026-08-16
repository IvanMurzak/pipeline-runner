/**
 * Inbound-frame dispatcher: routes wire frames by `type` to registered
 * handlers. Types with no handler are logged-and-ignored gracefully:
 *
 *   - RESERVED types the protocol defines but this core does not handle yet
 *     (`lease`/`answer`/`cancel`/`upload_ack` — T1-12 shipper + lease loop,
 *     T1-13 needs-input relay) log at info as "not handled yet". Later tasks
 *     attach handlers via `on(type, handler)` — the hook point — with no
 *     dispatcher change.
 *   - Unknown types (a newer same-major peer's additive messages) log at
 *     debug and are ignored, per the additive-forward protocol policy.
 */

import type { WireFrame } from './wire';
import type { Logger } from './log';
import { nullLogger } from './log';

export type FrameHandler = (frame: WireFrame) => void;

/** Protocol-defined types this CORE routes but does not handle itself. The
 *  jobs/relay/shipper/department layers attach the real handlers via `on()`
 *  (`lease` + `cancel` — jobs/manager.ts, c6; `answer` — relay/bridge.ts;
 *  `upload_ack` — shipper/upload-transport.ts; every `department.*` entry —
 *  department/manager.ts's `attach()`, department-mesh tasks d1/d2/e2); a
 *  bare core (e.g. the `register` command's validation connection) logs them
 *  at info instead of dropping silently.
 *
 *  This list is PURELY a log-level classifier, never load-bearing for
 *  routing: `dispatch()` below checks the registered-handlers map first and
 *  calls whatever's there regardless of whether the type also appears here —
 *  a type can be handled perfectly well (as every `department.*` entry now
 *  is, via `DepartmentManager.attach()`) whether or not it's listed. Listing
 *  it just keeps a connection with no handler attached yet (or none of this
 *  type registered, e.g. a bare validation connection) from logging it as
 *  "unknown" — `@baizor/pipeline-protocol` 0.4.0 (the `e1` gate) already
 *  carries the real `department.*` schemas, so none of these are exotic. */
export const RESERVED_UNHANDLED_TYPES = [
  'lease',
  'answer',
  'cancel',
  'upload_ack',
  // c4: handled by `relay/chat.ts` on a fully-wired daemon connection; listed
  // so a bare core (the `register` command's validation connection) logs it
  // as "not handled yet" rather than "unknown".
  'chat_send',
  'department.offer',
  'department.message',
  'department.cancel',
  'department.lease_revoked',
  'department.artifact_ack',
  'department.config_update',
] as const;

export class Dispatcher {
  private readonly handlers = new Map<string, Set<FrameHandler>>();

  constructor(private readonly logger: Logger = nullLogger) {}

  /** Register a handler for a frame type. Returns an unsubscribe function. */
  on(type: string, handler: FrameHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * Route one inbound frame. Returns true when at least one handler ran.
   * A throwing handler is contained (logged) — one bad handler must not kill
   * the connection's read loop.
   */
  dispatch(frame: WireFrame): boolean {
    const set = this.handlers.get(frame.type);
    if (set && set.size > 0) {
      for (const handler of [...set]) {
        try {
          handler(frame);
        } catch (err) {
          this.logger.error(`handler for '${frame.type}' threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return true;
    }
    if ((RESERVED_UNHANDLED_TYPES as readonly string[]).includes(frame.type)) {
      this.logger.info(`frame '${frame.type}' not handled yet (ignored)`);
    } else {
      this.logger.debug(`unknown frame type '${frame.type}' (ignored)`);
    }
    return false;
  }
}
