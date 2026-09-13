// The test harness's own correctness.
//
// This is a QA test, not a product test. It exists because the F2 suite
// reported "31 PASS / 0 FAIL" while fifteen of its checks had never executed: a
// fixture threw, the exception escaped the suite body, and `finally` printed a
// summary that was accurate about what had run and silent about what had not.
// Zero failures, zero skips, and a third of the coverage missing.
//
// The properties asserted here are the ones that were not true then:
//
//   - an exception halfway through cannot produce exit code 0
//   - planned > executed is a failure even when nothing threw
//   - cleanup still runs
//   - the summary says the run was interrupted, in words
//
// The exit-code checks spawn a real child process, because an exit code is what
// CI reads and a returned object is not.
//
// Run: npm run test:unit

import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRecorder } from "../../supabase/tests/lib/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "fixtures/aborting-suite.mjs");

/** Run the synthetic suite as a child process; never throws on a bad exit. */
function runFixture(env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [FIXTURE], {
      encoding: "utf8", env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? -1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// ---------------------------------------------------------------------------
// the exit code — the thing that actually lied
// ---------------------------------------------------------------------------

test("a suite that aborts halfway cannot exit 0", () => {
  const { code } = runFixture();
  assert.notEqual(code, 0,
    "an aborted run exited 0 — this is the exact defect this file exists to prevent");
  assert.equal(code, 1);
});

test("the same suite exits 0 when it is allowed to finish", () => {
  // Anti-vacuity: without this, a fixture that always failed for some unrelated
  // reason would satisfy the test above and prove nothing.
  const { code, stdout } = runFixture({ SYNTHETIC_THROW: "no" });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /SUITE OK/);
});

// ---------------------------------------------------------------------------
// the summary must say what happened
// ---------------------------------------------------------------------------

test("an aborted run reports the interruption truthfully", () => {
  const { stdout } = runFixture();

  assert.match(stdout, /PLANNED\s+4/);
  assert.match(stdout, /EXECUTED\s+2/);
  assert.match(stdout, /RUN ABORTED/);
  assert.match(stdout, /PLANNED != EXECUTED \(4 planned, 2 executed\)/);
  assert.match(stdout, /SUITE FAILED/);
  // The cause, not just the fact.
  assert.match(stdout, /conflicting key value violates exclusion constraint/);
  // And it must NOT read as a success.
  assert.doesNotMatch(stdout, /SUITE OK/);
});

test("cleanup still runs when the suite aborts", () => {
  const { stdout } = runFixture();
  assert.match(stdout, /synthetic cleanup ran: true/,
    "teardown was skipped — an aborted suite must still remove its fixtures");
});

// ---------------------------------------------------------------------------
// the recorder itself
// ---------------------------------------------------------------------------

const quiet = (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = real; }
};

test("planned > executed fails even when nothing threw and nothing failed", () => {
  const rec = createRecorder("T");
  rec.plan(3);
  quiet(() => {
    rec.check({ id: "a", action: "-", expected: "-", actual: "-", ok: true });
    rec.check({ id: "b", action: "-", expected: "-", actual: "-", ok: true });
  });
  const s = quiet(() => rec.summary());
  assert.equal(s.pass, 2);
  assert.equal(s.fail, 0);
  assert.equal(s.executed, 2);
  assert.equal(s.planned, 3);
  assert.equal(s.green, false, "2 of 3 checks with no failures was reported as green");
});

test("executed = pass + fail + skip, with skips counted", () => {
  const rec = createRecorder("T");
  rec.plan(4);
  quiet(() => {
    rec.check({ id: "a", action: "-", expected: "-", actual: "-", ok: true });
    rec.check({ id: "b", action: "-", expected: "-", actual: "-", ok: false });
    rec.skip({ id: "c", reason: "conditions not present" });
    rec.check({ id: "d", action: "-", expected: "-", actual: "-", ok: true });
  });
  const s = quiet(() => rec.summary());
  assert.equal(s.executed, s.pass + s.fail + s.skipped);
  assert.equal(s.executed, 4);
  assert.equal(s.planned, s.executed);
  // A skip is not a pass, and a failure is still a failure.
  assert.equal(s.pass, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.green, false);
});

test("a complete run with skips and no failures is green", () => {
  // Skips are legitimate when declared. They must not fail a suite on their own,
  // or every state-dependent branch becomes a reason to weaken the assertion.
  const rec = createRecorder("T");
  rec.plan(2);
  quiet(() => {
    rec.check({ id: "a", action: "-", expected: "-", actual: "-", ok: true });
    rec.skip({ id: "b", reason: "stated reason" });
  });
  const s = quiet(() => rec.summary());
  assert.equal(s.green, true);
});

test("an abort makes a run non-green even if every executed check passed", () => {
  const rec = createRecorder("T");
  rec.plan(1);
  quiet(() => {
    rec.check({ id: "a", action: "-", expected: "-", actual: "-", ok: true });
    rec.aborted(new Error("boom"));
  });
  const s = quiet(() => rec.summary());
  assert.equal(s.pass, 1);
  assert.equal(s.fail, 0);
  assert.equal(s.planned, s.executed, "plan matched, so only the abort can fail this");
  assert.equal(s.green, false);
  assert.match(s.aborted.message, /boom/);
});

test("a suite that declares no plan still reports, and is not failed for it", () => {
  // Adoption has to be incremental: a suite without a plan keeps its old
  // behaviour rather than turning red the moment this lands.
  const rec = createRecorder("T");
  quiet(() => rec.check({ id: "a", action: "-", expected: "-", actual: "-", ok: true }));
  const s = quiet(() => rec.summary());
  assert.equal(s.planned, null);
  assert.equal(s.green, true);
});
