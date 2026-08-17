/**
 * D4-2 — the metadata-tier APPROVAL-GATE projection.
 *
 * A gate park must still read as a gate at the DEFAULT privacy tier. Before
 * this, the `'question'` rule placeholdered the whole question object and
 * `approval` went with it, so the cloud — which derives `awaiting_kind` from
 * the PRESENCE of `question.approval` — reported every default-tier gate park
 * as `needs-input`. The `d4` dispatched-runner e2e measured it: run
 * `3fa4c005…` wrong at `metadata`, `3a1c2d24…` right at `events`.
 *
 * The fix is a NARROWING projection — `approval.required_role` and nothing
 * else — so this suite is written as an ADVERSARIAL one. Its subject is not
 * "does the badge work"; it is "can anything OTHER than one of four enum
 * literals reach the wire through the new leaf". Every hostile shape below is
 * asserted on the ACTUAL filtered output, not on a claim that it is handled.
 *
 * The two properties that must hold together, and that the tests are grouped
 * around:
 *
 *   1. A valid gate projects EXACTLY `{ required_role }` — never the marker's
 *      `.passthrough()` siblings, never the question's own content.
 *   2. Everything else is DROPPED, not projected, and dropping is
 *      BYTE-IDENTICAL to the pre-D4-2 output. That is the fail-closed
 *      guarantee: a malformed marker degrades to an ordinary question, exactly
 *      as the relay's frame boundary does with the same input.
 */

import { describe, expect, test } from 'bun:test';
import {
  APPROVAL_REQUIRED_ROLES,
  filterEventForTier,
  QUESTION_PLACEHOLDER,
  SG4_PATH_RE,
} from '../src/shipper/privacy';
import { APPROVAL_ROLES, ApprovalSchema } from '@baizor/pipeline-protocol';
import { journalEvent } from './_shipper-helpers';

/** Every string leaf of a payload, with its location — mirrors the same two
 *  helpers in `shipper-privacy.test.ts` (kept local rather than exported from
 *  the filter: its public surface is a trust boundary, not a test kit). */
function stringLeaves(node: unknown, at = 'payload'): Array<[string, string]> {
  if (typeof node === 'string') return [[at, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${at}.${k}`));
  }
  return [];
}

/** The SG4 verdict on a payload, as `location -> value` findings. */
function sg4Findings(payload: unknown): string[] {
  return stringLeaves(payload)
    .filter(([, v]) => SG4_PATH_RE.test(v))
    .map(([at, v]) => `${at} -> ${JSON.stringify(v.slice(0, 140))}`);
}

const SECRETS = {
  questionText: 'SECRET_QUESTION_should-we-deploy-the-payment-hotfix',
  questionContext: 'SECRET_CONTEXT_the-diff-touches-billing.ts-lines-40-90',
  questionOption: 'SECRET_OPTION_deploy-to-prod-now',
  /** `ApprovalSchema` is `.passthrough()`, so a REAL marker can legitimately
   *  carry this. It is free text, and it is the reason a plain `keep` was
   *  rejected: keeping the object would ship authored content from inside the
   *  very field the placeholder exists to strip. */
  approvalReason: 'SECRET_REASON_the-diff-touches-billing.ts-lines-40-90',
} as const;

/** The question's OWN nested identity (v4 back-compat field), deliberately
 *  DIFFERENT from the sibling `question_id: 'q-1'` on the event data — the
 *  placeholder reads the nested one, and these tests should say which. */
const NESTED_QID = 'qq-nested';

/** The exact output a park with NO usable gate and no nested identity must
 *  produce — the pre-D4-2 shape, asserted with `toEqual` so an extra key is a
 *  failure rather than a detail. */
const PLAIN = { text: QUESTION_PLACEHOLDER } as const;

/** The same, for a question that DOES carry the nested identity — what a
 *  `gateQuestion(...)` whose marker was dropped must filter to. */
const PLAIN_WITH_QID = { text: QUESTION_PLACEHOLDER, question_id: NESTED_QID } as const;

/** Filter one `awaiting_input` park at the metadata tier and hand back the
 *  filtered `question`. */
function filterQuestion(question: unknown, type = 'awaiting_input'): unknown {
  const filtered = filterEventForTier(
    journalEvent(type, 'r1', { run_id: 'r1', iteration: 1, question_id: 'q-1', question }),
    'metadata',
  ) as { data: Record<string, unknown> };
  return filtered.data.question;
}

/** The whole filtered envelope as it would go on the wire — for "no byte of
 *  this reached the wire" assertions, which must look at everything, not just
 *  the field under test. */
function filterWire(question: unknown, type = 'awaiting_input'): string {
  return JSON.stringify(
    filterEventForTier(
      journalEvent(type, 'r1', { run_id: 'r1', iteration: 1, question_id: 'q-1', question }),
      'metadata',
    ),
  );
}

/** A realistic gate park as drive emits it: real question content, a valid
 *  marker, and a passthrough sibling on the marker. */
function gateQuestion(requiredRole: unknown, approvalExtra: Record<string, unknown> = {}) {
  return {
    text: SECRETS.questionText,
    context: SECRETS.questionContext,
    options: [SECRETS.questionOption],
    question_id: NESTED_QID,
    approval: { required_role: requiredRole, ...approvalExtra },
  };
}

/** What a valid gate park must filter to: the plain placeholder, the nested
 *  identity, and the projected leaf — nothing else. */
function projected(role: string) {
  return { text: QUESTION_PLACEHOLDER, question_id: NESTED_QID, approval: { required_role: role } };
}

describe('D4-2 PIN: the projection enum tracks the protocol authority', () => {
  // THE POINT OF THIS BLOCK. `APPROVAL_REQUIRED_ROLES` is a hand-written copy of
  // `@baizor/pipeline-protocol`'s `APPROVAL_ROLES`, because `privacy.ts` may not
  // import anything but `node:crypto`. A copy nobody compares is a copy that
  // diverges silently — so these tests consult the REAL PACKAGE, not a second
  // literal. Asserting the array against another hand-written list (which is
  // what an earlier revision of this suite did) proves only that the array
  // equals itself.
  //
  // The failure it exists to catch: the protocol adds a fifth role, the relay's
  // `ApprovalSchema` validates it at the frame boundary, and `projectApprovalGate`
  // DROPS it — so that gate reports `needs-input` again. Fail-closed for
  // disclosure, wide open for the badge path, which is all of D4-2.

  test('list pin: the projection enum IS the protocol enum, order included', () => {
    expect([...APPROVAL_REQUIRED_ROLES]).toEqual([...APPROVAL_ROLES]);
  });

  test('behavioural pin: every role ApprovalSchema ACCEPTS, the projection PROJECTS', () => {
    // The direction that matters. A role added upstream fails here even if
    // someone forgets to update the list assertion above.
    for (const role of APPROVAL_ROLES) {
      expect(ApprovalSchema.safeParse({ required_role: role }).success, `schema accepts ${role}`).toBe(true);
      expect(filterQuestion(gateQuestion(role)), `projection emits ${role}`).toEqual(projected(role));
    }
  });

  test('behavioural pin: every role ApprovalSchema REJECTS, the projection DROPS', () => {
    // The other direction: the projection must not be more permissive than the
    // authority either, or the shipper would assert a gate the relay refused.
    for (const bad of ['superuser', 'Owner', 'OWNER', '', ' owner', 'owner ', 'billing_admin']) {
      expect(ApprovalSchema.safeParse({ required_role: bad }).success, `schema rejects ${bad}`).toBe(false);
      expect(filterQuestion(gateQuestion(bad)), `projection drops ${bad}`).toEqual(PLAIN_WITH_QID);
    }
  });

  test("the projected object is exactly what ApprovalSchema would have produced for that leaf", () => {
    // Closes the loop with the relay's own authority: what the metadata tier
    // ships is a strict narrowing of what the frame boundary validates.
    for (const role of APPROVAL_ROLES) {
      const parsed = ApprovalSchema.parse({ required_role: role, reason: 'SECRET_REASON_ignored' });
      const shipped = (filterQuestion(gateQuestion(role, { reason: 'SECRET_REASON_ignored' })) as {
        approval: Record<string, unknown>;
      }).approval;
      expect(shipped).toEqual({ required_role: parsed.required_role });
      expect(Object.keys(shipped)).toEqual(['required_role']);
    }
  });
});

describe('D4-2: a valid gate projects required_role, and ONLY required_role', () => {
  test('the whole point: a metadata-tier gate park carries the gate marker', () => {
    expect(filterQuestion(gateQuestion('owner'))).toEqual(projected('owner'));
  });

  test('every role the protocol enum admits projects', () => {
    // Pinned against the exported list rather than a hand-copied one, so a
    // role added to the enum without a decision here fails loudly.
    expect([...APPROVAL_REQUIRED_ROLES]).toEqual(['owner', 'admin', 'member', 'viewer']);
    for (const role of APPROVAL_REQUIRED_ROLES) {
      expect(filterQuestion(gateQuestion(role))).toEqual(projected(role));
    }
  });

  test('NARROWING, not keeping: a passthrough sibling on the marker is dropped', () => {
    // The distinction the whole task turns on (r4 ledger item 4). `reason` is
    // schema-valid on a real approval and is free text.
    const question = filterQuestion(gateQuestion('admin', { reason: SECRETS.approvalReason }));
    expect(question).toEqual(projected('admin'));
    expect(filterWire(gateQuestion('admin', { reason: SECRETS.approvalReason }))).not.toContain(
      SECRETS.approvalReason,
    );
  });

  test('a projected gate still leaks none of the question itself', () => {
    const wire = filterWire(gateQuestion('owner', { reason: SECRETS.approvalReason }));
    for (const secret of Object.values(SECRETS)) expect(wire).not.toContain(secret);
  });

  test('KEY ORDER: the filtered question serializes exactly as expected', () => {
    // `toEqual` is order-insensitive, and what actually goes on the wire is
    // JSON. Key order is allowlist-iteration order, so assert the bytes.
    expect(JSON.stringify(filterQuestion(gateQuestion('owner')))).toBe(
      `{"text":"${QUESTION_PLACEHOLDER}","question_id":"${NESTED_QID}","approval":{"required_role":"owner"}}`,
    );
    expect(JSON.stringify(filterQuestion({ text: SECRETS.questionText, question_id: NESTED_QID }))).toBe(
      `{"text":"${QUESTION_PLACEHOLDER}","question_id":"${NESTED_QID}"}`,
    );
    // The projection is appended LAST, so a dropped marker leaves the byte
    // sequence of a plain question untouched rather than merely an equal object.
    expect(Object.keys(filterQuestion(gateQuestion('viewer')) as object)).toEqual([
      'text',
      'question_id',
      'approval',
    ]);
  });

  test('the projected leaf is a fresh object, not an alias of the input', () => {
    // A spread or a reference would let a later mutation of the source object
    // — or a passthrough sibling — ride along. Prove the output does not share
    // identity with the input marker.
    const input = gateQuestion('owner', { reason: SECRETS.approvalReason });
    const out = filterQuestion(input) as { approval: Record<string, unknown> };
    expect(out.approval).not.toBe(input.approval);
    expect(Object.keys(out.approval)).toEqual(['required_role']);
  });

  test('the projection survives the SG4 scrub unchanged and is not path-shaped', () => {
    const filtered = filterEventForTier(
      journalEvent('awaiting_input', 'r1', {
        run_id: 'r1',
        iteration: 1,
        question_id: 'q-1',
        question: gateQuestion('member'),
      }),
      'metadata',
    );
    // The scrub walks every string leaf at any depth, so it DOES see this one.
    // A closed enum of four short words is not path-shaped, so it is a no-op —
    // asserted rather than assumed.
    expect(sg4Findings(filtered)).toEqual([]);
    expect(
      ((filtered.data as Record<string, unknown>).question as Record<string, unknown>).approval,
    ).toEqual({ required_role: 'member' });
  });
});

describe('D4-2 adversarial: every hostile shape is DROPPED, not projected', () => {
  // Each case asserts the FULL filtered question with `toEqual`, so "dropped"
  // means "the output is byte-identical to a plain question" — not merely
  // "the value was not copied verbatim".

  const HOSTILE: Array<{ label: string; approval: unknown }> = [
    // ── wrong type entirely ────────────────────────────────────────────────
    { label: 'boolean true (the legacy gate marker, and a real historical trap)', approval: true },
    { label: 'boolean false', approval: false },
    { label: 'a bare string', approval: 'owner' },
    { label: 'a bare string naming the field', approval: 'required_role=owner' },
    { label: 'a number', approval: 1 },
    { label: 'an array of markers', approval: [{ required_role: 'owner' }] },
    { label: 'an array of role strings', approval: ['owner'] },
    { label: 'an empty array', approval: [] },
    { label: 'an empty object (no required_role at all)', approval: {} },

    // ── right container, wrong leaf ────────────────────────────────────────
    { label: 'required_role an unknown enum value', approval: { required_role: 'superuser' } },
    { label: 'required_role an empty string', approval: { required_role: '' } },
    { label: 'required_role case-shifted', approval: { required_role: 'Owner' } },
    { label: 'required_role padded', approval: { required_role: ' owner' } },
    { label: 'required_role a boolean', approval: { required_role: true } },
    { label: 'required_role a number', approval: { required_role: 0 } },
    { label: 'required_role null', approval: { required_role: null } },
    { label: 'required_role a nested object', approval: { required_role: { required_role: 'owner' } } },
    { label: 'required_role an array', approval: { required_role: ['owner'] } },

    // ── secret-shaped values in required_role (the SG4 axis) ───────────────
    {
      label: 'required_role an absolute Windows path',
      approval: { required_role: 'C:/Users/ivan/very-secret-client-project/.secrets/token' },
    },
    {
      label: 'required_role an absolute POSIX path',
      approval: { required_role: '/home/ivan/.ssh/id_ed25519' },
    },
    { label: 'required_role a live API key', approval: { required_role: 'sk-live-SECRET_123456' } },
    {
      label: 'required_role the question text smuggled through',
      approval: { required_role: SECRETS.questionText },
    },
    {
      label: 'required_role a valid role with a payload appended',
      approval: { required_role: 'owner\nSECRET_SMUGGLED_PAYLOAD' },
    },
    {
      label: 'required_role a valid role with a NUL-suffixed payload',
      approval: { required_role: 'owner\u0000SECRET_SMUGGLED_PAYLOAD' },
    },
  ];

  for (const { label, approval } of HOSTILE) {
    test(`dropped: ${label}`, () => {
      expect(filterQuestion({ text: SECRETS.questionText, approval })).toEqual(PLAIN);
    });
  }

  test('no hostile value reaches the wire anywhere in the envelope', () => {
    // The per-case assertions above prove the `approval` key is absent. This
    // one proves the value did not resurface somewhere ELSE in the payload.
    for (const { label, approval } of HOSTILE) {
      const wire = filterWire({ text: SECRETS.questionText, approval });
      for (const secret of ['SECRET_SMUGGLED_PAYLOAD', 'sk-live-SECRET_123456', 'id_ed25519', '.secrets']) {
        expect(wire, `${label} leaked ${secret}`).not.toContain(secret);
      }
      expect(wire, `${label} leaked the question text`).not.toContain(SECRETS.questionText);
    }
  });

  test('dropped: an ACCESSOR whose getter returns a valid role', () => {
    // An own property can be a getter rather than a data property.
    // `hasOwnProperty` is true for it, so the own-check passes and the getter
    // RUNS — the enum check is what stops it. Asserted because a value that
    // arrives by invocation rather than by storage is the case a
    // shape-inspection guard is most likely to have overlooked.
    let reads = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'required_role', {
      enumerable: true,
      configurable: true,
      get() {
        reads++;
        // Alternates: a checker that validated once and re-read to project
        // would emit the second value.
        return reads === 1 ? 'owner' : 'SECRET_SMUGGLED_ON_SECOND_READ';
      },
    });

    const out = filterQuestion({ text: SECRETS.questionText, approval: accessor });
    // The projection is allowed to accept this — the getter's first value IS a
    // valid role — but it must project THAT value, never a later one.
    expect(JSON.stringify(out)).not.toContain('SECRET_SMUGGLED_ON_SECOND_READ');
    expect(reads).toBe(1); // read exactly once: no validate-then-re-read gap
    expect(out).toEqual({ ...PLAIN, approval: { required_role: 'owner' } });
  });

  test('dropped: an accessor whose getter throws is not swallowed into a gate', () => {
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, 'required_role', {
      enumerable: true,
      get() {
        throw new Error('SECRET_THROWN_FROM_GETTER');
      },
    });
    // Whatever the policy, it must not be "a gate". Today the throw propagates
    // to the caller (the shipper's own error handling), which is fail-closed:
    // nothing is shipped at all. Pinned so a future try/catch cannot quietly
    // turn it into a projected gate.
    expect(() => filterQuestion({ text: SECRETS.questionText, approval: hostile })).toThrow(
      'SECRET_THROWN_FROM_GETTER',
    );
  });

  test('dropped: a boxed String role (object, not primitive)', () => {
    // `typeof new String('owner') === 'object'`, so the string check rejects it
    // even though `==` and `.includes` on the primitive would have matched.
    expect(
      filterQuestion({ text: SECRETS.questionText, approval: { required_role: new String('owner') } }),
    ).toEqual(PLAIN);
  });

  test('dropped: __proto__-keyed object literal (prototype-chain fabrication)', () => {
    // THE case the own-property check exists for. Written as an object literal
    // on purpose: unlike `JSON.parse`, a literal `__proto__` key really does
    // SET the prototype, so a bare `value.required_role` read would inherit
    // `'owner'` and fabricate a gate from an object that carries no such field.
    const polluted = { __proto__: { required_role: 'owner' } };
    // Sanity: the prototype read really would have found it — otherwise this
    // test would pass for the wrong reason.
    expect((polluted as unknown as { required_role?: string }).required_role).toBe('owner');
    expect(Object.prototype.hasOwnProperty.call(polluted, 'required_role')).toBe(false);

    expect(filterQuestion({ text: SECRETS.questionText, approval: polluted })).toEqual(PLAIN);
  });

  test('dropped: __proto__ as an OWN key, the JSON.parse form', () => {
    // `JSON.parse` never sets the prototype — it defines an own `__proto__`
    // DATA property — which is the shape that actually reaches this filter,
    // since every event it sees was parsed off a journal line.
    const parsed = JSON.parse('{"__proto__":{"required_role":"owner"}}');
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed.required_role).toBeUndefined();

    expect(filterQuestion({ text: SECRETS.questionText, approval: parsed })).toEqual(PLAIN);
    // And the pollution did not escape into Object.prototype either.
    expect(({} as Record<string, unknown>).required_role).toBeUndefined();
  });

  test('dropped: constructor/prototype-keyed marker', () => {
    const parsed = JSON.parse('{"constructor":{"prototype":{"required_role":"owner"}}}');
    expect(filterQuestion({ text: SECRETS.questionText, approval: parsed })).toEqual(PLAIN);
  });

  test('a null-prototype marker with a REAL own role still projects', () => {
    // The own-property check must not become an accidental rejection of
    // legitimate input: `Object.create(null)` has no `hasOwnProperty` method of
    // its own, which is exactly why the call is written
    // `Object.prototype.hasOwnProperty.call(...)`.
    const bare = Object.create(null) as Record<string, unknown>;
    bare.required_role = 'viewer';
    expect(filterQuestion({ text: SECRETS.questionText, approval: bare })).toEqual({
      text: QUESTION_PLACEHOLDER,
      approval: { required_role: 'viewer' },
    });
  });
});

describe('D4-2: a plain question is byte-identical to before the projection', () => {
  test('no approval key at all', () => {
    expect(
      filterQuestion({
        text: SECRETS.questionText,
        context: SECRETS.questionContext,
        options: [SECRETS.questionOption],
      }),
    ).toEqual(PLAIN);
  });

  test('approval explicitly null — the ordinary no-gate case, no key emitted', () => {
    expect(filterQuestion({ text: SECRETS.questionText, approval: null })).toEqual(PLAIN);
  });

  test('approval explicitly undefined', () => {
    expect(filterQuestion({ text: SECRETS.questionText, approval: undefined })).toEqual(PLAIN);
  });

  test('a question with no question_id still yields the bare placeholder', () => {
    const filtered = filterEventForTier(
      journalEvent('awaiting_input', 'r1', {
        run_id: 'r1',
        iteration: 1,
        question: { text: SECRETS.questionText },
      }),
      'metadata',
    ) as { data: Record<string, unknown> };
    expect(filtered.data.question).toEqual({ text: QUESTION_PLACEHOLDER });
  });

  test('a non-record question is still dropped entirely', () => {
    for (const question of ['a string', 42, true, null, ['array']]) {
      const filtered = filterEventForTier(
        journalEvent('awaiting_input', 'r1', { run_id: 'r1', iteration: 1, question }),
        'metadata',
      ) as { data: Record<string, unknown> };
      expect(filtered.data).not.toHaveProperty('question');
    }
  });
});

describe('D4-2: content and events tiers are untouched', () => {
  // They were correct in the e2e (`3a1c2d24…` derived `needs-approval` at the
  // events tier before this change existed) and this task must not move them.
  const event = journalEvent('awaiting_input', 'r1', {
    run_id: 'r1',
    iteration: 1,
    question_id: 'q-1',
    question: gateQuestion('owner', { reason: SECRETS.approvalReason }),
  });

  for (const tier of ['events', 'full'] as const) {
    test(`${tier} tier passes the event through by identity, gate marker intact`, () => {
      const filtered = filterEventForTier(event, tier);
      // `filterEventForTier` returns the SAME OBJECT at these tiers — identity,
      // which is stronger than deep equality and is the actual contract.
      expect(filtered).toBe(event);
      expect(JSON.stringify(filtered)).toBe(JSON.stringify(event));
      const question = (filtered.data as Record<string, unknown>).question as Record<string, unknown>;
      expect(question.approval).toEqual({ required_role: 'owner', reason: SECRETS.approvalReason });
      expect(question.text).toBe(SECRETS.questionText);
    });
  }
});

describe('D4-2: department.input_required — the same rule, adjudicated', () => {
  // DECISION (task DoD): the projection APPLIES here too, because there is no
  // separate department question shape to reason about —
  // `pipeline-protocol`'s `DeptQuestionSchema` is a RE-EXPORT of the same
  // `QuestionSchema` ("UNCHANGED — no parallel shape", `department/task.ts`),
  // `approval` field included. Nothing consumes a department gate today (the
  // runner's own department `Question` in `src/department/adapter.ts` does not
  // declare the field, and the cloud derivation keys on `awaiting_input`), so
  // this branch is a PROVABLE NO-OP in practice — proven by the second test
  // below rather than asserted in prose. It is written as one rule anyway: the
  // filter's own header records that the `step_uuid` defect was fixed as "the
  // RULE, not the two entries `i1` happened to observe", and one shape that
  // behaves two ways at a trust boundary is the hardest drift to notice.

  test('a department question carrying a valid marker projects identically', () => {
    expect(
      filterQuestion(gateQuestion('admin', { reason: SECRETS.approvalReason }), 'department.input_required'),
    ).toEqual(projected('admin'));
  });

  test('and it is a NO-OP for every department question the runner can actually emit', () => {
    // `RuntimeEvent`'s `Question` (`src/department/adapter.ts`) is
    // `{ text, context?, options? }` — no `approval` field — so nothing the
    // runner produces reaches the projection. Byte-identical to before.
    expect(
      filterQuestion(
        { text: SECRETS.questionText, context: SECRETS.questionContext, options: [SECRETS.questionOption] },
        'department.input_required',
      ),
    ).toEqual(PLAIN);
  });

  test('the hostile shapes are dropped here too', () => {
    for (const { label, approval } of [
      { label: 'boolean', approval: true },
      { label: 'unknown role', approval: { required_role: 'superuser' } },
      { label: 'secret-shaped role', approval: { required_role: 'sk-live-SECRET_123456' } },
    ]) {
      expect(
        filterQuestion({ text: SECRETS.questionText, approval }, 'department.input_required'),
        label,
      ).toEqual(PLAIN);
    }
  });
});
