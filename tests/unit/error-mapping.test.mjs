// Unit tests for the privacy-safe error module.
//
// This is the boundary that decides what a user is told when an operation is
// refused. The property that matters most is negative: a message the module
// does not recognise must NOT reach the UI, and a hidden cross-workspace
// conflict must produce STAFF_UNAVAILABLE and nothing else.
//
// Pure module, no database — run with: npm run test:unit

import assert from "node:assert/strict";
import { test } from "node:test";

// The module is plain TypeScript with no runtime dependencies, so Node's
// built-in type stripping loads it directly — no build step, no bundler.
import { toAppError, AppErrorCode } from "../../lib/errors/appError.ts";

const SAFE_COPY = new Set([
  "This team member is not available at that time. Please choose another time or another person.",
  "A large job is holding the rest of that day. A Master can approve an exception with a reason.",
  "That time overlaps an existing appointment. Overlapping bookings are never allowed.",
  "That time is outside working hours.",
  "This team member is on time off then.",
  "You do not have permission to do that.",
  "This appointment can no longer be changed because it is completed or cancelled.",
  "Please check the details and try again.",
  "Something went wrong. Please try again.",
]);

test("hidden cross-workspace conflict maps to STAFF_UNAVAILABLE with no detail", () => {
  const e = toAppError({ message: "STAFF_UNAVAILABLE" });
  assert.equal(e.code, AppErrorCode.STAFF_UNAVAILABLE);
  assert.deepEqual(e.detail, {}, "must carry no structured detail");
  assert.equal(e.overridable, false, "a conflict you cannot see is not overridable");
  assert.ok(!/10:00|large|private|workspace/i.test(e.message));
});

test("known engine errors map to their codes", () => {
  const cases = [
    ["PHYSICAL_OVERLAP: conflicts with an existing appointment at 10:00:00", AppErrorCode.PHYSICAL_OVERLAP],
    ["LARGE_JOB_OVERRIDE_REQUIRED: blocked by a large-job lock starting 10:00:00", AppErrorCode.LARGE_JOB_OVERRIDE_REQUIRED],
    ["LARGE_JOB_OVERRIDE_REQUIRED: this large job would block an existing appointment at 15:00:00", AppErrorCode.LARGE_JOB_OVERRIDE_REQUIRED],
    ["Outside working hours (12:00:00 to 16:00:00)", AppErrorCode.OUTSIDE_WORKING_HOURS],
    ["Staff is unavailable during this time (time off)", AppErrorCode.TIME_OFF],
    ["Staff is unavailable on this date (full day off)", AppErrorCode.TIME_OFF],
    ["Not authorized", AppErrorCode.NOT_AUTHORIZED],
    ["Only Super Master may change staff active status", AppErrorCode.NOT_AUTHORIZED],
    ["Staff may not perform a large-job override", AppErrorCode.NOT_AUTHORIZED],
    ["Staff may not override duration", AppErrorCode.NOT_AUTHORIZED],
    ["Only a booked appointment can be rescheduled", AppErrorCode.INVALID_APPOINTMENT_STATE],
    ["Only a booked appointment can be cancelled", AppErrorCode.INVALID_APPOINTMENT_STATE],
    ["At least one service item is required", AppErrorCode.VALIDATION_ERROR],
    ["Multiple active workspace memberships — workspace_id is required", AppErrorCode.VALIDATION_ERROR],
    ["An existing booked appointment falls outside the new hours — reschedule it first", AppErrorCode.VALIDATION_ERROR],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(toAppError({ message: raw }).code, expected, `for: ${raw}`);
  }
});

test("authorised detail is extracted as structured fields, never as raw text", () => {
  const overlap = toAppError({ message: "PHYSICAL_OVERLAP: conflicts with an existing appointment at 10:00:00" });
  assert.equal(overlap.detail.blockingTime, "10:00");

  const lock = toAppError({ message: "LARGE_JOB_OVERRIDE_REQUIRED: blocked by a large-job lock starting 09:30:00" });
  assert.equal(lock.detail.blockingTime, "09:30");
  assert.equal(lock.overridable, true);

  const hours = toAppError({ message: "Outside working hours (12:00:00 to 16:00:00)" });
  assert.equal(hours.detail.windowStart, "12:00");
  assert.equal(hours.detail.windowEnd, "16:00");
});

test("unknown messages fail closed and never echo server text", () => {
  const leaky = [
    'duplicate key value violates unique constraint "appointments_pkey"',
    "PRIVATE CUSTOMER Z booked at 10:00 in KC Private Team for RM800",
    "permission denied for function can_view_conflict",
    'relation "public.appointments" does not exist',
    "conflicting_appointment_id 36709f0c-63c6-4a6a-8299-d2e6b4bfff89",
  ];
  for (const raw of leaky) {
    const e = toAppError({ message: raw });
    assert.equal(e.code, AppErrorCode.UNEXPECTED, `for: ${raw}`);
    assert.equal(e.message, "Something went wrong. Please try again.");
    assert.deepEqual(e.detail, {});
  }
});

test("no mapped message ever contains server text", () => {
  const inputs = [
    "STAFF_UNAVAILABLE",
    "PHYSICAL_OVERLAP: conflicts with an existing appointment at 10:00:00",
    "LARGE_JOB_OVERRIDE_REQUIRED: blocked by a large-job lock starting 10:00:00",
    "Outside working hours (09:00:00 to 19:00:00)",
    "boom",
    "",
    null,
    undefined,
    new Error("PRIVATE CUSTOMER Z"),
  ];
  for (const input of inputs) {
    const e = toAppError(input);
    assert.ok(SAFE_COPY.has(e.message), `unexpected copy for ${String(input)}: ${e.message}`);
  }
});

test("accepts Error instances, strings and supabase-shaped objects alike", () => {
  assert.equal(toAppError("STAFF_UNAVAILABLE").code, AppErrorCode.STAFF_UNAVAILABLE);
  assert.equal(toAppError(new Error("STAFF_UNAVAILABLE")).code, AppErrorCode.STAFF_UNAVAILABLE);
  assert.equal(
    toAppError({ message: "STAFF_UNAVAILABLE", code: "P0001" }).code,
    AppErrorCode.STAFF_UNAVAILABLE,
  );
  assert.equal(toAppError(null).code, AppErrorCode.UNEXPECTED);
});

test("STAFF_UNAVAILABLE matching is exact, so a longer message cannot slip through", () => {
  const e = toAppError({ message: "STAFF_UNAVAILABLE because Jack is in KC Private Team at 10:00" });
  assert.equal(e.code, AppErrorCode.UNEXPECTED, "a suffixed variant must not be treated as the sentinel");
  assert.equal(e.message, "Something went wrong. Please try again.");
});
