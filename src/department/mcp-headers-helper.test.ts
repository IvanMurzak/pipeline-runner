/**
 * `runHeadersHelper` — the `headersHelper` program's decision table
 * (simplified-onboarding x21).
 *
 * Driven through the injected `HelperIo` rather than a subprocess, because
 * everything worth asserting here is about WHAT it reads and WHERE it prints:
 * that the credential comes from the environment and never from argv, that
 * stdout carries the header map and nothing else, and that every failure is a
 * distinct exit code with a message naming no secret. The real chain — a real
 * shell, a real subprocess, a real authorization server — is
 * `./mcp-headers-helper.real.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import {
  ENGINE_MCP_HELPER_SECRET_ENV,
  ENGINE_MCP_HELPER_SECRET_ENV_LEGACY,
  ENGINE_MCP_HELPER_URL_ENV,
  ENGINE_MCP_HELPER_URL_ENV_LEGACY,
} from './engine';
import { runHeadersHelper } from './mcp-headers-helper';

const URL_ = 'http://127.0.0.1:51234/mcp-headers';
const SECRET = 'a'.repeat(64);

interface Capture {
  stdout: string;
  stderr: string;
  requests: { url: string; authorization: string | undefined }[];
}

function io(
  options: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    respond?: (request: { url: string }) => Response | Promise<Response>;
  } = {}
): { io: Parameters<typeof runHeadersHelper>[0]; capture: Capture } {
  const capture: Capture = { stdout: '', stderr: '', requests: [] };
  return {
    capture,
    io: {
      argv: options.argv ?? ['/usr/local/bin/bun', '/opt/r/mcp-headers-helper.ts', 'dexec-42'],
      env: options.env ?? { [ENGINE_MCP_HELPER_URL_ENV]: URL_, [ENGINE_MCP_HELPER_SECRET_ENV]: SECRET },
      stdout: (text) => {
        capture.stdout += text;
      },
      stderr: (text) => {
        capture.stderr += text;
      },
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const headers = new Headers(init?.headers);
        capture.requests.push({ url, authorization: headers.get('authorization') ?? undefined });
        return options.respond === undefined
          ? new Response(JSON.stringify({ Authorization: 'Bearer tok-2' }), { headers: { 'content-type': 'application/json' } })
          : options.respond({ url });
      }) as typeof fetch,
    },
  };
}

describe('the headers-helper program', () => {
  test('prints the runner\'s header map on stdout, verbatim — that is the whole contract', async () => {
    const { io: helperIo, capture } = io();
    expect(await runHeadersHelper(helperIo)).toBe(0);
    expect(JSON.parse(capture.stdout)).toEqual({ Authorization: 'Bearer tok-2' });
    expect(capture.stderr).toBe('');
  });

  test('the secret travels in a header read from the ENVIRONMENT; the execution id comes from argv', async () => {
    const { io: helperIo, capture } = io();
    await runHeadersHelper(helperIo);
    const request = capture.requests[0]!;
    // `/proc/<pid>/cmdline` is world-readable and `/proc/<pid>/environ` is
    // not — x20's precedent, and the reason these two values travel by
    // different routes.
    expect(request.authorization).toBe(`Bearer ${SECRET}`);
    expect(request.url).toContain('execution=dexec-42');
    expect(request.url).not.toContain(SECRET);
  });

  test('an execution id with URL-special characters is encoded, not concatenated', async () => {
    const { io: helperIo, capture } = io({ argv: ['bun', 'helper.ts', 'dexec/42&x=1'] });
    await runHeadersHelper(helperIo);
    expect(capture.requests[0]!.url).toContain('execution=dexec%2F42%26x%3D1');
  });

  test('no execution id argument ⇒ exit 2, and nothing on stdout', async () => {
    const { io: helperIo, capture } = io({ argv: ['bun', 'helper.ts'] });
    expect(await runHeadersHelper(helperIo)).toBe(2);
    expect(capture.stdout).toBe('');
    expect(capture.stderr).toContain('no execution id');
  });

  test('no injected channel ⇒ exit 2 — this is the case where the runner offered none', async () => {
    for (const env of [
      {},
      { [ENGINE_MCP_HELPER_URL_ENV]: URL_ },
      { [ENGINE_MCP_HELPER_SECRET_ENV]: SECRET },
      { [ENGINE_MCP_HELPER_URL_ENV]: URL_, [ENGINE_MCP_HELPER_SECRET_ENV]: '' },
      // …and the same three holes in the pre-rename spellings, so "fall back
      // to the old name" cannot accidentally mean "accept half a channel".
      { [ENGINE_MCP_HELPER_URL_ENV_LEGACY]: URL_ },
      { [ENGINE_MCP_HELPER_SECRET_ENV_LEGACY]: SECRET },
      { [ENGINE_MCP_HELPER_URL_ENV_LEGACY]: URL_, [ENGINE_MCP_HELPER_SECRET_ENV_LEGACY]: '' },
    ]) {
      const { io: helperIo, capture } = io({ env });
      expect(await runHeadersHelper(helperIo)).toBe(2);
      expect(capture.stdout).toBe('');
    }
  });

  test('b5 — the helper reads the PRE-RENAME spellings too, and prefers the new ones', async () => {
    // The case that matters: this program is a GRANDCHILD of the supervisor
    // (Claude Code re-runs it on connect and on 401), so it can easily be a
    // newer build than the session whose environment it inherits. A helper
    // that only knew the new names would 401-loop forever there.
    const legacyOnly = io({ env: { [ENGINE_MCP_HELPER_URL_ENV_LEGACY]: URL_, [ENGINE_MCP_HELPER_SECRET_ENV_LEGACY]: SECRET } });
    expect(await runHeadersHelper(legacyOnly.io)).toBe(0);
    expect(JSON.parse(legacyOnly.capture.stdout)).toEqual({ Authorization: 'Bearer tok-2' });
    expect(legacyOnly.capture.requests[0]!.authorization).toBe(`Bearer ${SECRET}`);
    expect(legacyOnly.capture.requests[0]!.url).toContain(URL_);

    // Both present and identical — the shipped state during the window.
    const both = io({
      env: {
        [ENGINE_MCP_HELPER_URL_ENV]: URL_,
        [ENGINE_MCP_HELPER_SECRET_ENV]: SECRET,
        [ENGINE_MCP_HELPER_URL_ENV_LEGACY]: URL_,
        [ENGINE_MCP_HELPER_SECRET_ENV_LEGACY]: SECRET,
      },
    });
    expect(await runHeadersHelper(both.io)).toBe(0);
    expect(both.capture.requests[0]!.authorization).toBe(`Bearer ${SECRET}`);

    // Both present and DIFFERENT — the new name wins, unambiguously.
    const conflicting = io({
      env: {
        [ENGINE_MCP_HELPER_URL_ENV]: URL_,
        [ENGINE_MCP_HELPER_SECRET_ENV]: SECRET,
        [ENGINE_MCP_HELPER_URL_ENV_LEGACY]: 'http://127.0.0.1:1/stale',
        [ENGINE_MCP_HELPER_SECRET_ENV_LEGACY]: 'stale-secret',
      },
    });
    expect(await runHeadersHelper(conflicting.io)).toBe(0);
    expect(conflicting.capture.requests[0]!.url).toContain(URL_);
    expect(conflicting.capture.requests[0]!.authorization).toBe(`Bearer ${SECRET}`);
    expect(conflicting.capture.stderr).not.toContain('stale-secret');
  });

  test('an unreachable runner is a clean exit 1 inside Claude Code\'s 10s window, not a hang', async () => {
    const { io: helperIo, capture } = io({
      respond: () => {
        throw new TypeError('connect ECONNREFUSED');
      },
    });
    expect(await runHeadersHelper(helperIo)).toBe(1);
    expect(capture.stderr).toContain('unreachable');
    expect(capture.stdout).toBe('');
  });

  test('a refusal is reported by STATUS only — the helper never speculates about why', async () => {
    const { io: helperIo, capture } = io({ respond: () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) });
    expect(await runHeadersHelper(helperIo)).toBe(1);
    expect(capture.stderr).toContain('HTTP 401');
    expect(capture.stdout).toBe('');
  });

  test('a body that is not a flat string→string map is refused rather than forwarded', async () => {
    const bodies = ['not json at all', JSON.stringify(['a']), JSON.stringify({ Authorization: 42 }), JSON.stringify(null)];
    for (const body of bodies) {
      const { io: helperIo, capture } = io({ respond: () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
      expect(await runHeadersHelper(helperIo)).toBe(1);
      expect(capture.stdout).toBe('');
    }
  });

  test('nothing it writes anywhere ever contains the secret', async () => {
    const cases = [
      io(),
      io({ respond: () => new Response('{}', { status: 502 }) }),
      io({
        respond: () => {
          throw new Error(`connect ECONNREFUSED (${SECRET})`);
        },
      }),
    ];
    for (const { io: helperIo, capture } of cases) {
      await runHeadersHelper(helperIo);
      expect(capture.stderr).not.toContain(SECRET);
      expect(capture.stdout).not.toContain(SECRET);
    }
  });
});
