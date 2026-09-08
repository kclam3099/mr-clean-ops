// The customer-facing availability message.
//
// The message goes straight to a customer, so the tests that matter most are
// the ones about what it must NOT contain: no staff name, no workspace, no
// count, and no explanation for a time that is missing.
//
// Run: npm run test:unit

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCustomerMessage, groupSlotsForCustomer, friendlyTime, weekdayLabel,
} from "../../lib/availability/customer-message.ts";

// 2026-09-09 is a Wednesday, 09-10 Thursday, 09-11 Friday, 09-12 Saturday.
const WED = "2026-09-09", THU = "2026-09-10", FRI = "2026-09-11", SAT = "2026-09-12";

const slot = (date, time) => ({ date, time });

test("times read the way a customer writes them", () => {
  assert.equal(friendlyTime("10:00"), "10am");
  assert.equal(friendlyTime("13:00"), "1pm");
  assert.equal(friendlyTime("15:00"), "3pm");
  assert.equal(friendlyTime("09:30"), "9.30am");
  assert.equal(friendlyTime("12:00"), "12pm");
  assert.equal(friendlyTime("00:00"), "12am");
});

test("weekday labels are Chinese and derived from the date", () => {
  assert.equal(weekdayLabel(WED), "星期三");
  assert.equal(weekdayLabel(THU), "星期四");
  assert.equal(weekdayLabel(SAT), "星期六");
});

// 1 & 2. union across staff
test("a time is shown when ANY staff member can take it", () => {
  // Jack free at 10:00, Dyron free at 13:00 — the customer sees both.
  const days = groupSlotsForCustomer([slot(WED, "10:00"), slot(WED, "13:00")]);
  assert.equal(days.length, 1);
  assert.deepEqual(days[0].times, ["10am", "1pm"]);
});

// 6. dedup
test("the same time from two staff appears once", () => {
  const days = groupSlotsForCustomer([
    slot(WED, "10:00"), slot(WED, "10:00"), slot(WED, "13:00"), slot(WED, "13:00"),
  ]);
  assert.deepEqual(days[0].times, ["10am", "1pm"]);
});

// 3. both busy
test("a time nobody can take is simply absent", () => {
  const days = groupSlotsForCustomer([slot(WED, "10:00"), slot(WED, "13:00")]);
  assert.ok(!days[0].times.includes("3pm"));
});

// 4. whole day omitted
test("a day with nothing available is omitted entirely", () => {
  const message = buildCustomerMessage(
    [slot(WED, "10:00"), slot(WED, "13:00"), slot(FRI, "13:00")], "thisWeek");
  assert.ok(message.includes("星期三"));
  assert.ok(message.includes("星期五"));
  // Thursday had no slots, so it must not appear at all — not as an empty
  // heading, which would invite "why not Thursday?".
  assert.ok(!message.includes("星期四"));
});

// 5. a single slot still shows its day
test("a day with one available time still appears, with just that time", () => {
  const message = buildCustomerMessage([slot(FRI, "13:00")], "thisWeek");
  assert.ok(message.includes("星期五"));
  assert.ok(message.includes("1pm"));
});

test("the full worked example reads as intended", () => {
  const message = buildCustomerMessage([
    slot(WED, "10:00"), slot(WED, "13:00"), slot(WED, "15:00"),
    slot(THU, "10:00"), slot(THU, "13:00"), slot(THU, "15:00"),
    slot(FRI, "10:00"), slot(FRI, "13:00"), slot(FRI, "15:00"),
    slot(SAT, "13:00"), slot(SAT, "15:00"),
  ], "thisWeek");

  assert.equal(message, [
    "这个星期可预约时间 😊",
    "",
    "星期三",
    "10am, 1pm, 3pm",
    "",
    "星期四",
    "10am, 1pm, 3pm",
    "",
    "星期五",
    "10am, 1pm, 3pm",
    "",
    "星期六",
    "1pm, 3pm",
  ].join("\n"));
});

// 7 & 8. what must never appear
test("the message names no staff member", () => {
  const message = buildCustomerMessage([slot(WED, "10:00"), slot(THU, "13:00")], "thisWeek");
  for (const name of ["Jack", "Dyron", "Victor", "TEST_JACK", "TEST_DYRON", "TEST_VICTOR"]) {
    assert.ok(!message.includes(name), `leaked staff name: ${name}`);
  }
});

test("the message carries no workspace, count or reason", () => {
  const message = buildCustomerMessage([slot(WED, "10:00")], "thisWeek");
  for (const term of [
    "KC Private Team", "Shared Team", "workspace", "busy", "unavailable",
    "booked", "conflict", "appointment",
  ]) {
    assert.ok(!message.includes(term), `leaked: ${term}`);
  }
  // No digits beyond the times themselves — nothing that reads as a count.
  assert.ok(!/\d+\s*(个|slots|appointments)/.test(message));
});

// 12. empty range
test("an empty range says so plainly, and invents no day", () => {
  assert.equal(buildCustomerMessage([], "thisWeek"), "这个星期暂时没有可预约时间");
  assert.equal(buildCustomerMessage([], "today"), "今天暂时没有可预约时间");
  assert.equal(buildCustomerMessage([], "tomorrow"), "明天暂时没有可预约时间");
  assert.equal(buildCustomerMessage([], "nextWeek"), "下个星期暂时没有可预约时间");
  assert.equal(buildCustomerMessage([], "custom"), "暂时没有可预约时间");
  for (const w of ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]) {
    assert.ok(!buildCustomerMessage([], "thisWeek").includes(w));
  }
});

test("each preset gets its own heading", () => {
  assert.ok(buildCustomerMessage([slot(WED, "10:00")], "today").startsWith("今天可预约时间 😊"));
  assert.ok(buildCustomerMessage([slot(WED, "10:00")], "tomorrow").startsWith("明天可预约时间 😊"));
  assert.ok(buildCustomerMessage([slot(WED, "10:00")], "thisWeek").startsWith("这个星期可预约时间 😊"));
  assert.ok(buildCustomerMessage([slot(WED, "10:00")], "nextWeek").startsWith("下个星期可预约时间 😊"));
  assert.ok(buildCustomerMessage([slot(WED, "10:00")], "custom").startsWith("可预约时间 😊"));
});

test("days come out in date order regardless of input order", () => {
  const days = groupSlotsForCustomer([slot(SAT, "13:00"), slot(WED, "10:00"), slot(THU, "15:00")]);
  assert.deepEqual(days.map((d) => d.date), [WED, THU, SAT]);
});

test("times within a day are chronological, not insertion-ordered", () => {
  const days = groupSlotsForCustomer([slot(WED, "15:00"), slot(WED, "10:00"), slot(WED, "13:00")]);
  assert.deepEqual(days[0].times, ["10am", "1pm", "3pm"]);
});

test("malformed slots are dropped rather than rendered", () => {
  const days = groupSlotsForCustomer([
    slot(WED, "10:00"), slot("", "10:00"), slot(WED, ""), { date: WED, time: "13:00" },
  ]);
  assert.equal(days.length, 1);
  assert.deepEqual(days[0].times, ["10am", "1pm"]);
});
