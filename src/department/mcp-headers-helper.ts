/**
 * The `headersHelper` program (simplified-onboarding x21; D23 as amended by
 * D33).
 *
 * Claude Code runs this on every MCP connect and, since v2.1.193,
 * automatically on a `401`/`403` before retrying the call once. Its contract
 * (read out of the shipped binary): a STRING command, run with `shell:true`
 * and a 10s timeout, which must print a JSON object of string→string headers
 * on stdout.
 *
 * This program is that command's payload, and it is deliberately the dumbest
 * thing that can work: it asks the daemon's loopback endpoint
 * (`./execution-token-endpoint.ts`) for this execution's current headers and
 * prints the answer verbatim. It holds no policy, mints nothing, and knows
 * nothing about OAuth — because it runs INSIDE a model-driven session and
 * everything it knows is, in effect, known to that session.
 *
 * ## What it reads, and from where — this is the whole security argument
 *
 *   - `PIPELINE_MESH_HELPER_URL` / `PIPELINE_MESH_HELPER_SECRET` from its own
 *     **environment**, inherited from the Claude Code session the supervisor
 *     spawned. Never from argv: `/proc/<pid>/cmdline` is world-readable
 *     (0444) while `/proc/<pid>/environ` is owner-only (0400) — the same
 *     reason, and the same precedent, as `x20`'s name-only `-e KEY` flags.
 *   - the execution id from **argv**, because it is an identifier and not a
 *     credential (it is already in journal paths, index lines and log
 *     messages), and putting it there is what lets the endpoint refuse a
 *     secret presented for the wrong execution.
 *
 * It reads NOTHING from disk, writes nothing to disk, and prints nothing to
 * stderr that contains either value.
 *
 * ## Why a separate program rather than a shell one-liner
 *
 * A `curl` one-liner would need the secret interpolated by the shell, and the
 * two shells `shell:true` selects (POSIX `sh`, Windows `cmd.exe`) do not
 * agree on a single spelling of "read this variable". A tiny program reading
 * `process.env` is identical on both, needs no `curl` on the box, and is
 * testable.
 */

/** Claude Code allows the helper 10s; fail inside that window so the CLI sees
 *  a clean non-zero exit and its own message rather than a kill. */
export const HELPER_FETCH_TIMEOUT_MS = 5_000;

export interface HelperIo {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  fetchImpl: typeof fetch;
}

/**
 * A headers object is only usable if every value is a string. Validated here
 * rather than trusted so a malformed (or hostile) body becomes a stated
 * failure instead of a header map Claude Code chokes on mid-connect.
 */
function isHeaderMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const entry of Object.values(value)) {
    if (typeof entry !== 'string') return false;
  }
  return true;
}

/**
 * Exit code, not a throw — this is a program. `0` prints headers; anything
 * else prints a reason on stderr that never names the secret, the token or
 * the URL (the URL is loopback and dull, but the discipline is the module's,
 * not the URL's).
 */
export async function runHeadersHelper(io: HelperIo): Promise<number> {
  // `bun <script> <executionId>` ⇒ [bunPath, scriptPath, executionId].
  const executionId = io.argv[2];
  const url = io.env.PIPELINE_MESH_HELPER_URL;
  const secret = io.env.PIPELINE_MESH_HELPER_SECRET;

  if (typeof executionId !== 'string' || executionId.length === 0) {
    io.stderr('pipeline mcp-headers-helper: no execution id argument\n');
    return 2;
  }
  if (typeof url !== 'string' || url.length === 0 || typeof secret !== 'string' || secret.length === 0) {
    io.stderr('pipeline mcp-headers-helper: PIPELINE_MESH_HELPER_URL/PIPELINE_MESH_HELPER_SECRET are not set in this environment\n');
    return 2;
  }

  let response: Response;
  try {
    const target = new URL(url);
    target.searchParams.set('execution', executionId);
    response = await io.fetchImpl(target.toString(), {
      headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
      signal: AbortSignal.timeout(HELPER_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    io.stderr(`pipeline mcp-headers-helper: the runner's local token endpoint is unreachable (${err instanceof Error ? err.name : 'error'})\n`);
    return 1;
  }

  if (!response.ok) {
    io.stderr(`pipeline mcp-headers-helper: the runner refused (HTTP ${response.status})\n`);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    io.stderr('pipeline mcp-headers-helper: the runner answered with something that is not JSON\n');
    return 1;
  }
  if (!isHeaderMap(parsed)) {
    io.stderr('pipeline mcp-headers-helper: the runner answered with something that is not a header map\n');
    return 1;
  }

  // stdout is the contract. Nothing else is ever written here.
  io.stdout(JSON.stringify(parsed));
  return 0;
}

/* c8 ignore start — the process shell around the testable function above. */
if (import.meta.main) {
  const code = await runHeadersHelper({
    argv: process.argv,
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    fetchImpl: fetch,
  });
  process.exit(code);
}
/* c8 ignore stop */
