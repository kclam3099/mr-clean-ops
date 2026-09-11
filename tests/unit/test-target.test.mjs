// The destructive-test target guard.
//
// This is the check that decides whether an automated suite is allowed to write
// to a given Supabase project. It exists because a teardown once deleted a real
// customer booking, so the guard matrix is asserted rather than trusted.
//
// `evaluateTarget` is pure, so every branch is exercised here with synthetic
// values — no network, no database, no environment.
//
// Run: npm run test:unit

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectRef, evaluateTarget,
  TEST_SAFE_PROJECT_REFS, WIPEABLE_PROJECT_REFS, DEV_PROJECT_REF, TEST_PROJECT_REQUIRED,
} from "../../supabase/tests/lib/target.mjs";

const DEV = "ozojfflkchltwqnbflso";
const TST = "aaaabbbbccccddddeeee";
const PROD = "zzzzyyyyxxxxwwwwvvvv";
const url = (ref) => `https://${ref}.supabase.co`;

// ---------------------------------------------------------------------------
// ref parsing
// ---------------------------------------------------------------------------

test("projectRef reads the ref from a canonical URL", () => {
  assert.equal(projectRef(url(DEV)), DEV);
  assert.equal(projectRef(`${url(DEV)}/`), DEV);
  assert.equal(projectRef(`  ${url(DEV)}///  `), DEV);
  assert.equal(projectRef(`http://${DEV}.supabase.co`), DEV);
  assert.equal(projectRef(`https://${DEV.toUpperCase()}.supabase.co`), DEV);
});

test("projectRef refuses anything that is not exactly a project host", () => {
  // A ref appearing somewhere in a URL is not the host. This is the shape an
  // attacker-supplied or mistyped value takes, and the reason the pattern is
  // anchored rather than searched.
  assert.equal(projectRef(`https://evil.example/${DEV}.supabase.co`), null);
  assert.equal(projectRef(`https://${DEV}.supabase.co.evil.example`), null);
  assert.equal(projectRef(`https://${DEV}.supabase.co/rest/v1`), null);
  assert.equal(projectRef(`https://sub.${DEV}.supabase.co`), null);
  // Length is exact: a 19- or 21-character lookalike is a different project.
  assert.equal(projectRef(`https://${DEV.slice(0, 19)}.supabase.co`), null);
  assert.equal(projectRef(`https://${DEV}x.supabase.co`), null);
  assert.equal(projectRef("https://db.example.com"), null);
  assert.equal(projectRef(""), null);
  assert.equal(projectRef(undefined), null);
  assert.equal(projectRef(null), null);
  assert.equal(projectRef(42), null);
});

// ---------------------------------------------------------------------------
// the guard matrix
// ---------------------------------------------------------------------------

const evaluate = (o) => evaluateTarget({ safeRefs: [TST], ...o });

test("an allowlisted ref with a matching claim is permitted", () => {
  const r = evaluate({ url: url(TST), expectedRef: TST });
  assert.deepEqual(r, { ok: true, ref: TST });
});

test("an allowlisted ref is permitted before EXPECTED_TEST_PROJECT_REF exists", () => {
  // The pre-cutover state: the allowlist alone is what protects the run.
  const r = evaluate({ url: url(TST), expectedRef: undefined });
  assert.equal(r.ok, true);
});

test("a ref outside the allowlist is refused", () => {
  const r = evaluate({ url: url(PROD) });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_ALLOWLISTED");
  assert.match(r.message, /TEST_SAFE_PROJECT_REFS/);
});

test("refusing DEV says it is DEV and names the read-only alternative", () => {
  const r = evaluate({ url: url(DEV) });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_ALLOWLISTED");
  assert.match(r.message, /is DEV/);
  assert.match(r.message, /dev:inspect/);
});

test("a connection that disagrees with the environment's claim is refused", () => {
  // A stale copied .env is exactly how a suite ends up somewhere it was never
  // meant to be, so the two must agree even when the ref is otherwise allowed.
  const r = evaluateTarget({ url: url(TST), expectedRef: PROD, safeRefs: [TST] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "MISMATCH");
});

test("a mismatch onto DEV is called out specifically", () => {
  const r = evaluateTarget({ url: url(DEV), expectedRef: TST, safeRefs: [TST, DEV] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "MISMATCH");
  assert.match(r.message, /DEV/);
});

test("an unparseable or missing URL is refused, not guessed", () => {
  assert.equal(evaluate({ url: "https://db.example.com" }).code, "UNPARSEABLE");
  assert.equal(evaluate({ url: "" }).code, "NO_URL");
  assert.equal(evaluate({ url: undefined }).code, "NO_URL");
});

test("once TEST is required, an environment with no claim is refused", () => {
  const r = evaluate({ url: url(TST), requireExpected: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NO_EXPECTED");
});

test("an empty allowlist permits nothing", () => {
  const r = evaluateTarget({ url: url(TST), safeRefs: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_ALLOWLISTED");
});

// ---------------------------------------------------------------------------
// no boolean escape hatches
// ---------------------------------------------------------------------------

for (const key of [
  "ALLOW_NON_DEV_TESTS", "ALLOW_PROD_TESTS", "ALLOW_DEV_TESTS",
  "SKIP_TARGET_GUARD", "FORCE_TEST_TARGET",
]) {
  test(`${key} cannot authorise anything — it is refused outright`, () => {
    // Refused rather than ignored: a silently ignored override leaves the person
    // believing it worked. An otherwise perfectly valid target still fails.
    const r = evaluate({ url: url(TST), expectedRef: TST, env: { [key]: "true" } });
    assert.equal(r.ok, false);
    assert.equal(r.code, "FORBIDDEN_OVERRIDE");
    assert.match(r.message, new RegExp(key));
  });
}

test("an empty override value is not treated as an attempt", () => {
  const r = evaluate({ url: url(TST), expectedRef: TST, env: { ALLOW_NON_DEV_TESTS: "" } });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// wipe authority is separate and narrower
// ---------------------------------------------------------------------------

test("test-safe does not imply wipeable", () => {
  const r = evaluateTarget({ url: url(TST), safeRefs: [TST], wipeableRefs: [], wipe: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_WIPEABLE");
});

test("wiping requires the ref on both lists", () => {
  const r = evaluateTarget({ url: url(TST), safeRefs: [TST], wipeableRefs: [TST], wipe: true });
  assert.equal(r.ok, true);
});

test("a wipeable ref that is not test-safe is still refused", () => {
  const r = evaluateTarget({ url: url(PROD), safeRefs: [TST], wipeableRefs: [PROD], wipe: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_ALLOWLISTED");
});

test("the wipe list is not consulted for an ordinary run", () => {
  const r = evaluateTarget({ url: url(TST), safeRefs: [TST], wipeableRefs: [], wipe: false });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------------------
// invariants of the shipped allowlists
// ---------------------------------------------------------------------------

test("every shipped allowlist entry is a well-formed ref", () => {
  for (const ref of [...TEST_SAFE_PROJECT_REFS, ...WIPEABLE_PROJECT_REFS]) {
    assert.match(ref, /^[a-z0-9]{20}$/, `${ref} is not a project ref`);
  }
});

test("wipeable is a subset of test-safe", () => {
  for (const ref of WIPEABLE_PROJECT_REFS) {
    assert.ok(TEST_SAFE_PROJECT_REFS.includes(ref),
      `${ref} may be wiped but is not test-safe — the lists disagree`);
  }
});

test("DEV is never wipeable", () => {
  assert.ok(!WIPEABLE_PROJECT_REFS.includes(DEV_PROJECT_REF),
    "DEV is on the wipeable list. It holds the owner's real bookings.");
});

test("once TEST is required, DEV is on neither list", () => {
  // The cutover switch enforces its own precondition: flipping
  // TEST_PROJECT_REQUIRED without removing DEV fails here rather than in
  // production of the owner's data.
  if (!TEST_PROJECT_REQUIRED) return;
  assert.ok(!TEST_SAFE_PROJECT_REFS.includes(DEV_PROJECT_REF),
    "DEV is still test-safe after cutover — remove it from TEST_SAFE_PROJECT_REFS");
  assert.ok(!WIPEABLE_PROJECT_REFS.includes(DEV_PROJECT_REF),
    "DEV is still wipeable after cutover — remove it from WIPEABLE_PROJECT_REFS");
});
