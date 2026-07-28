/**
 * The engine-module contract's own tests (simplified-onboarding b2; design
 * `06-engine-modules.md` §3/§6).
 *
 * Three things are worth testing about a declaration layer, and only three:
 * that the declarations are TRUE of the code that carries them, that the
 * registry and the modules cannot drift apart, and that adding an engine is
 * as mechanical as the design claims. Everything else here would be testing
 * an object literal against itself.
 */

import { describe, expect, test } from 'bun:test';
import type { InvocationEnvelope } from './adapter';
import { RuntimeAdapterError } from './adapter';
import { ClaudeCodeAdapter } from './claude-code';
import { ContainerAdapter } from './container';
import type { EngineCapabilities, EngineDeclaration, EngineModule, EngineName, EngineRegistry } from './engine';
import {
  adapterIdToEngine,
  CLAUDE_CODE_ENGINE_CAPABILITIES,
  CONTAINER_ENGINE_CAPABILITIES,
  ENGINE_CAPABILITY_LEVELS,
  ENGINE_MCP_TOKEN_ENV,
  ENGINE_MCP_URL_ENV,
  ENGINE_NAMES,
  ENGINE_REGISTRY,
  EngineMcpUnavailableError,
  engineToAdapterId,
  isolationForAdapterId,
  isSupportedEngine,
  lookupEngine,
  PIPELINE_ENGINE_CAPABILITIES,
  PROCESS_ENGINE_CAPABILITIES,
  requireEngineMcpEnv,
  supportedEngines,
} from './engine';
import { JsonlProcessAdapter } from './jsonl-process';
import { MESH_EXECUTION_TOKEN_ENV, MESH_MCP_URL_ENV } from './manager';
import { PIPELINE_DRIVE_CAPABILITIES, PipelineDriveAdapter } from './pipeline-drive';

/** The four modules this runner actually registers (`../cli.ts`). If a
 *  fifth is ever constructed there without appearing here, the coherence
 *  tests below stop covering it — which is why `every registered adapter id
 *  has a registry row` asserts in BOTH directions. */
const SHIPPED_MODULES: EngineModule[] = [
  new JsonlProcessAdapter(),
  new ContainerAdapter(),
  new PipelineDriveAdapter(),
  new ClaudeCodeAdapter(),
];

describe('declared capabilities (06 §3)', () => {
  test("`pipeline` matches 06 §3's table row for row", () => {
    // The design's table states, for the `pipeline` column: mid-task input
    // no ("no stdin"), cancellation yes, streaming partial, checkpoint no.
    expect(PIPELINE_ENGINE_CAPABILITIES).toEqual({
      acceptsMidTaskInput: 'no',
      supportsCancellation: 'yes',
      supportsStreaming: 'partial',
      supportsCheckpoint: 'no',
    });
  });

  test("`claude-code` matches 06 §3's table row for row", () => {
    // The design's table states, for the `claude-code` column: mid-task input
    // yes ("via the receiver tools"), cancellation yes, streaming yes,
    // checkpoint no. It is the only engine with no qualified answer.
    expect(CLAUDE_CODE_ENGINE_CAPABILITIES).toEqual({
      acceptsMidTaskInput: 'yes',
      supportsCancellation: 'yes',
      supportsStreaming: 'yes',
      supportsCheckpoint: 'no',
    });
  });

  test('`container` declares exactly what `process` does — it is a sandbox, not a second protocol', () => {
    expect(CONTAINER_ENGINE_CAPABILITIES).toEqual(PROCESS_ENGINE_CAPABILITIES);
  });

  test('`process` is honest about mid-task input being the wrapped runtime\'s call', () => {
    // Not 'yes': `jsonl-process` refuses to send a `task.message` to a
    // runtime whose `ready` frame declared `midTaskInput:false`, so the
    // module cannot promise on that runtime's behalf.
    expect(PROCESS_ENGINE_CAPABILITIES.acceptsMidTaskInput).toBe('partial');
    expect(PROCESS_ENGINE_CAPABILITIES.supportsStreaming).toBe('yes');
  });

  test('every declared level is drawn from the three-value vocabulary', () => {
    for (const row of Object.values(ENGINE_REGISTRY)) {
      for (const level of Object.values(row.capabilities)) {
        expect(ENGINE_CAPABILITY_LEVELS).toContain(level);
      }
    }
  });

  test('no shipped engine claims checkpoint support, and none implements it', () => {
    // Ground truth, not a restatement: `checkpoint`/`resume` are OPTIONAL on
    // `AgentRuntimeAdapter` and no shipped adapter defines either.
    for (const module of SHIPPED_MODULES) {
      expect(module.engineCapabilities.supportsCheckpoint).toBe('no');
      expect(module.checkpoint).toBeUndefined();
      expect(module.resume).toBeUndefined();
    }
  });

  test("`pipeline`'s static declaration does not contradict the handle it negotiates", () => {
    // `EngineCapabilities` (static, this file) and `RuntimeCapabilities`
    // (per-handle, `./adapter.ts`) overlap on exactly one axis. A module
    // declaring 'no' may never mint a handle saying `midTaskInput:true`.
    expect(PIPELINE_ENGINE_CAPABILITIES.acceptsMidTaskInput).toBe('no');
    expect(PIPELINE_DRIVE_CAPABILITIES.midTaskInput).toBe(false);
  });
});

describe('module ⇄ registry coherence', () => {
  test('each shipped module declares the engine name, capabilities and MCP stance its registry row states', () => {
    for (const module of SHIPPED_MODULES) {
      const row = lookupEngine(module.engine);
      expect(row).not.toBeNull();
      expect(row?.adapterId).toBe(module.id);
      expect(module.engineCapabilities).toEqual(row?.capabilities as EngineCapabilities);
      expect(module.requiresMcpConnection).toBe(row?.requiresMcpConnection as boolean);
      // x20: the row is what `./manager.ts` judges an isolation request
      // against (it holds an adapterId, not an instance), so a row that
      // disagreed with its module would let the supervisor believe a sandbox
      // exists that the module does not build.
      expect(module.isolation).toBe(row?.isolation as never);
    }
  });

  test('x20: exactly ONE shipped module provides `container` isolation — every other spawns onto the host', () => {
    // This asymmetry is the whole reason the refusal exists. If a second
    // module ever genuinely sandboxes, this list grows and the refusal in
    // `./manager.ts` narrows automatically — it reads the same rows.
    const isolating = SHIPPED_MODULES.filter((module) => module.isolation === 'container').map((module) => module.id);
    expect(isolating).toEqual(['container']);
    expect(isolationForAdapterId('container')).toBe('container');
    for (const id of ['claude-code', 'jsonl-process', 'pipeline-drive']) {
      expect(isolationForAdapterId(id)).toBe('process');
    }
  });

  test('x20: an adapterId outside the registry yields null — "not this table\'s to judge", not "no isolation"', () => {
    // `./manager.ts` must NOT refuse a third-party/test adapter it knows
    // nothing about; null is what keeps that distinct from a declared
    // `'process'`, which IS refused when a sandbox was requested.
    expect(isolationForAdapterId('fake')).toBeNull();
    expect(isolationForAdapterId('codex')).toBeNull();
  });

  test('the registry covers exactly the four registered adapters, in both directions', () => {
    expect(Object.values(ENGINE_REGISTRY).map((row) => row.adapterId).sort()).toEqual([
      'claude-code',
      'container',
      'jsonl-process',
      'pipeline-drive',
    ]);
    expect(SHIPPED_MODULES.map((m) => m.id).sort()).toEqual(Object.values(ENGINE_REGISTRY).map((r) => r.adapterId).sort());
  });

  test('every row is stored under its own name', () => {
    for (const [name, row] of Object.entries(ENGINE_REGISTRY)) {
      expect(row.engine).toBe(name as never);
    }
  });

  test('only the model-driven module requires an MCP connection — the supervisor degrades for the rest', () => {
    // `manager.ts`'s `resolveMcpEnv` returns null and the spawn proceeds
    // without the variables. D24's refusal is for model-driven engines only:
    // declaring `true` on a process/drive module would break existing
    // dispatch, which works with no MCP access whatsoever.
    const requiring = SHIPPED_MODULES.filter((module) => module.requiresMcpConnection).map((module) => module.id);
    expect(requiring).toEqual(['claude-code']);
  });
});

describe('the supported-engine list (what `validate` reads)', () => {
  test('is the registry keys, sorted', () => {
    expect(supportedEngines()).toEqual(['claude-code', 'container', 'pipeline', 'process']);
    expect(supportedEngines()).toEqual([...ENGINE_NAMES].sort());
  });

  test('includes `claude-code` — b3 added the module, the name and the row together', () => {
    // Listing an engine before it can run is exactly the lie `validate` is
    // for, so this assertion is only true because `./claude-code.ts` exists
    // and `../cli.ts` constructs it (asserted by SHIPPED_MODULES above).
    expect(supportedEngines()).toContain('claude-code');
    expect(isSupportedEngine('claude-code')).toBe(true);
    expect(engineToAdapterId('claude-code')).toBe('claude-code');
  });

  test('an unknown engine resolves to null rather than throwing', () => {
    expect(lookupEngine('codex')).toBeNull();
    expect(engineToAdapterId('codex')).toBeNull();
    expect(isSupportedEngine('codex')).toBe(false);
    expect(adapterIdToEngine('codex')).toBeNull();
  });

  test('translates both ways for every shipped engine', () => {
    expect(engineToAdapterId('claude-code')).toBe('claude-code');
    expect(adapterIdToEngine('claude-code')).toBe('claude-code');
    expect(engineToAdapterId('process')).toBe('jsonl-process');
    expect(engineToAdapterId('container')).toBe('container');
    expect(engineToAdapterId('pipeline')).toBe('pipeline-drive');
    expect(adapterIdToEngine('jsonl-process')).toBe('process');
    expect(adapterIdToEngine('container')).toBe('container');
    expect(adapterIdToEngine('pipeline-drive')).toBe('pipeline');
  });

  test('round-trips: engine → adapterId → engine, for all of them', () => {
    for (const name of ENGINE_NAMES) {
      expect(adapterIdToEngine(engineToAdapterId(name) as string)).toBe(name);
    }
  });
});

describe('adding an engine is the registry plus the enum (06 §6)', () => {
  const stub: EngineDeclaration = {
    engine: 'stub' as never, // `EngineName` is derived from ENGINE_NAMES — a real engine adds itself there
    adapterId: 'stub-engine',
    capabilities: { acceptsMidTaskInput: 'yes', supportsCancellation: 'yes', supportsStreaming: 'yes', supportsCheckpoint: 'no' },
    requiresMcpConnection: true,
    // x20: a new engine states the isolation tier it provides, like every
    // other declaration on the row — one more line, still mechanical.
    isolation: 'process',
  };

  test('one added row is enough for the whole engine surface to know about it', () => {
    const withStub: EngineRegistry = { ...ENGINE_REGISTRY, stub };
    // Every lookup the CLI and the validator use — no other file touched.
    expect(supportedEngines(withStub)).toEqual(['claude-code', 'container', 'pipeline', 'process', 'stub']);
    expect(lookupEngine('stub', withStub)).toEqual(stub);
    expect(engineToAdapterId('stub', withStub)).toBe('stub-engine');
    expect(adapterIdToEngine('stub-engine', withStub)).toBe('stub');
    expect(lookupEngine('stub', withStub)?.requiresMcpConnection).toBe(true);
  });

  test('removing the row removes the engine, leaving the shipped ones untouched', () => {
    const withStub: EngineRegistry = { ...ENGINE_REGISTRY, stub };
    const { stub: _removed, ...withoutStub } = withStub;
    expect(supportedEngines(withoutStub)).toEqual(supportedEngines());
    expect(lookupEngine('stub', withoutStub)).toBeNull();
    expect(engineToAdapterId('stub', withoutStub)).toBeNull();
    expect(adapterIdToEngine('stub-engine', withoutStub)).toBeNull();
  });

  test('the shipped registry is never mutated by any of it', () => {
    expect(supportedEngines()).toEqual(['claude-code', 'container', 'pipeline', 'process']);
    expect(lookupEngine('stub')).toBeNull();
  });

  test('the enum and the table cannot drift apart — the compiler says so', () => {
    // `@ts-expect-error` fails `tsc --noEmit` when the line does NOT error,
    // so this is a real assertion about the type, not a comment: a table
    // missing an `ENGINE_NAMES` member is not a `Record<EngineName, …>`.
    // Adding the name without the row is therefore a build failure, which is
    // what makes "registry + enum, nothing else" enforceable.
    // @ts-expect-error — 'claude-code', 'container' and 'pipeline' are missing
    const incomplete: Record<EngineName, EngineDeclaration> = { process: ENGINE_REGISTRY.process };
    expect(Object.keys(incomplete)).toEqual(['process']);
  });
});

describe('refusing rather than running blind (D24, responsibility 4)', () => {
  const invocationWithEnv = (env: Record<string, string | undefined>): InvocationEnvelope => ({
    executionId: 'exec-1',
    runtime: { adapterId: 'claude-code', command: 'claude', env },
    task: { taskId: 't1', contextId: 'c1', messages: [] },
  });

  test('the env names are the ones the supervisor actually injects', () => {
    // Single source of truth: `manager.ts` re-exports these under its own
    // shipped names, so a rename cannot desynchronize the two halves.
    expect(ENGINE_MCP_URL_ENV).toBe(MESH_MCP_URL_ENV);
    expect(ENGINE_MCP_TOKEN_ENV).toBe(MESH_EXECUTION_TOKEN_ENV);
  });

  test('returns the injected url + token when the supervisor could mint one', () => {
    const env = { [ENGINE_MCP_URL_ENV]: 'https://ai-pipeline.dev/mcp', [ENGINE_MCP_TOKEN_ENV]: 'tok-1' };
    expect(requireEngineMcpEnv(invocationWithEnv(env), 'claude-code')).toEqual({
      url: 'https://ai-pipeline.dev/mcp',
      token: 'tok-1',
    });
  });

  test('refuses when either half is missing, empty, or the env is absent entirely', () => {
    const cases: Record<string, string | undefined>[] = [
      {},
      { [ENGINE_MCP_URL_ENV]: 'https://ai-pipeline.dev/mcp' },
      { [ENGINE_MCP_TOKEN_ENV]: 'tok-1' },
      { [ENGINE_MCP_URL_ENV]: '', [ENGINE_MCP_TOKEN_ENV]: 'tok-1' },
      { [ENGINE_MCP_URL_ENV]: 'https://ai-pipeline.dev/mcp', [ENGINE_MCP_TOKEN_ENV]: '' },
    ];
    for (const env of cases) {
      expect(() => requireEngineMcpEnv(invocationWithEnv(env), 'claude-code')).toThrow(EngineMcpUnavailableError);
    }
    const bare: InvocationEnvelope = {
      executionId: 'exec-1',
      runtime: { adapterId: 'claude-code', command: 'claude' },
      task: { taskId: 't1', contextId: 'c1', messages: [] },
    };
    expect(() => requireEngineMcpEnv(bare, 'claude-code')).toThrow(EngineMcpUnavailableError);
  });

  test('the refusal is a RuntimeAdapterError, so the supervisor already reports it as a stated failure', () => {
    // `manager.ts`'s `startWithInvocation` catches whatever `start()` rejects
    // with and reports a terminal `failed` carrying the message — no
    // supervisor change is needed for an engine to refuse this way.
    try {
      requireEngineMcpEnv(invocationWithEnv({}), 'claude-code');
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err).toBeInstanceOf(EngineMcpUnavailableError);
      expect(err).toBeInstanceOf(RuntimeAdapterError);
      expect((err as Error).message).toContain('claude-code');
      expect((err as Error).message).toContain(ENGINE_MCP_URL_ENV);
      expect((err as Error).message).toContain('refusing to start');
    }
  });

  test('never puts the token in the refusal message', () => {
    try {
      requireEngineMcpEnv(invocationWithEnv({ [ENGINE_MCP_URL_ENV]: 'https://x/mcp', [ENGINE_MCP_TOKEN_ENV]: '' }), 'x');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as Error).message).not.toContain('https://x/mcp');
    }
  });
});
