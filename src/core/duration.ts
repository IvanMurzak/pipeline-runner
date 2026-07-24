/**
 * Manifest duration-string parsing (department-mesh, `06-department-registry.md`
 * / `07-runtime-contract.md` §7): a department manifest's `limits` block
 * (`taskTimeout`, `parkExpiry`, …) declares durations as short suffixed
 * strings — `"7d"`, `"2h"`, `"45m"`, `"30s"` — or a plain integer string
 * meaning seconds directly (`"600"`). This is the one place that grammar is
 * parsed; nothing else in the runner has needed a duration parser before
 * (wall-clock task deadlines arrive pre-computed as an ISO instant,
 * `offer.deadline_at` — a different mechanism).
 *
 * Tolerant by construction, same discipline as `../department/config.ts`'s
 * env parsing: malformed input returns `null` rather than throwing, so a
 * caller can log-and-ignore one bad manifest field instead of crashing the
 * daemon.
 */

const SUFFIXED = /^(\d+)(d|h|m|s)$/;
const PLAIN_INTEGER = /^\d+$/;

const UNIT_SECONDS: Record<string, number> = {
  d: 86_400,
  h: 3_600,
  m: 60,
  s: 1,
};

/**
 * Parse a duration string into whole seconds. Accepts `Nd`/`Nh`/`Nm`/`Ns`
 * (non-negative integer amount, e.g. `"7d"` → `604800`) or a bare
 * non-negative integer string meaning seconds already (`"600"` → `600`).
 * Anything else — decimals, negative numbers, mixed units, whitespace,
 * empty/blank, non-numeric garbage — returns `null`, never throws.
 */
export function parseDurationSeconds(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (PLAIN_INTEGER.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const match = SUFFIXED.exec(trimmed);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  return amount * UNIT_SECONDS[match[2]!]!;
}
