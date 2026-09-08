// WhatsApp appointment message parser.
//
// The parser is pure and takes no clock, so every case here is deterministic.
// Past/future checks use an INJECTED Malaysia reference time, which is what
// keeps this suite from becoming a time bomb.
//
// Run: npm run test:unit

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAppointmentMessage, markPastDateTime, isPastDateTime, looksLikeAppointment,
  itemsTotal, businessNowLocal,
} from "../../lib/appointments/message-parser.ts";

/** 8 September 2026, 11:00 in Kuala Lumpur — the morning of the Grace job. */
const CLOCK = "2026-09-08T11:00";

const GRACE = `Appointment Confirmed

Puchong Utama

Name : Grace
Contact Number: 0148136726
Date: 8/9/26
Appt Time:  2pm

Address: no 36A Jalan PU 7/3
Bandar Puchong Utama 47100
Puchong Selangor

Remark

Sofa 2 seater L RM179`;

// 1. the exact real-world message
test("parses the Grace message exactly", () => {
  const p = markPastDateTime(parseAppointmentMessage(GRACE), CLOCK);

  assert.equal(p.customerName, "Grace");
  assert.equal(p.phone, "0148136726");
  assert.equal(p.date, "2026-09-08");
  assert.equal(p.time, "14:00");
  assert.equal(
    p.address,
    "no 36A Jalan PU 7/3\nBandar Puchong Utama 47100\nPuchong Selangor",
  );
  assert.equal(p.areaCity, "Puchong Utama");
  assert.equal(p.remarks, "");
  assert.deepEqual(p.items, [
    { description: "Sofa 2 seater L", quantity: 1, unitPrice: 179 },
  ]);
  assert.equal(itemsTotal(p.items), 179);

  // Nothing needs confirming: 2pm on 8 Sep is future at 11:00 that morning.
  assert.deepEqual(p.missingFields, []);
  assert.deepEqual(p.confirmationFields, []);
});

test("the area heading is corroborated by the address, not guessed", () => {
  const p = parseAppointmentMessage(GRACE);
  // "Puchong Utama" also appears inside "Bandar Puchong Utama".
  assert.equal(p.status.areaCity, "FOUND");

  const elsewhere = parseAppointmentMessage(`Kepong

Name: Lim
Date: 9/9/26
Time: 10am
Address: 5 Jalan Ampang
Sofa RM200`);
  // "Kepong" appears nowhere in the address, so it is a guess and gets asked.
  assert.equal(elsewhere.areaCity, "Kepong");
  assert.equal(elsewhere.status.areaCity, "NEEDS_CONFIRMATION");
});

test("a message header is not mistaken for a place", () => {
  const p = parseAppointmentMessage(GRACE);
  assert.notEqual(p.areaCity, "Appointment Confirmed");
});

// 2. a second realistic shape
test("parses a compact message", () => {
  const p = markPastDateTime(parseAppointmentMessage(
    `Name: Ahmad
Contact: 0123456789
Date: 10/9/26
Time: 10am
Address: Cheras
Sofa RM200`), CLOCK);

  assert.equal(p.customerName, "Ahmad");
  assert.equal(p.phone, "0123456789");
  assert.equal(p.date, "2026-09-10");
  assert.equal(p.time, "10:00");
  assert.equal(p.address, "Cheras");
  assert.deepEqual(p.items, [{ description: "Sofa", quantity: 1, unitPrice: 200 }]);
});

// 3 & 4. label robustness
test("labels are case-insensitive and tolerate stray spacing", () => {
  const p = parseAppointmentMessage(
    `NAME    :   Siti
   contact number :0111222333
DaTe   :  1/10/26
APPT TIME :   3.30pm`);
  assert.equal(p.customerName, "Siti");
  assert.equal(p.phone, "0111222333");
  assert.equal(p.date, "2026-10-01");
  assert.equal(p.time, "15:30");
});

test("accepts the alternative label vocabulary", () => {
  const p = parseAppointmentMessage(
    `Customer Name: Wong
Phone Number: 0134445555
Appointment Date: 2/10/26
Appointment Time: 0930
Location: Bangsar`);
  assert.equal(p.customerName, "Wong");
  assert.equal(p.phone, "0134445555");
  assert.equal(p.date, "2026-10-02");
  assert.equal(p.time, "09:30");
  assert.equal(p.address, "Bangsar");
});

// 5. multiline address
test("captures a multiline address and stops at the next section", () => {
  const p = parseAppointmentMessage(
    `Address: Line one
Line two
Line three

Name: Zul`);
  assert.equal(p.address, "Line one\nLine two\nLine three");
  assert.equal(p.customerName, "Zul");
});

// 6 & 12. several services
test("reads several service lines", () => {
  const p = parseAppointmentMessage(
    `Sofa 2 seater RM179
Mattress Queen RM120
Carpet RM80`);
  assert.deepEqual(p.items, [
    { description: "Sofa 2 seater", quantity: 1, unitPrice: 179 },
    { description: "Mattress Queen", quantity: 1, unitPrice: 120 },
    { description: "Carpet", quantity: 1, unitPrice: 80 },
  ]);
  assert.equal(itemsTotal(p.items), 379);
});

// 7 & 13. price shapes
test("accepts the usual ways of writing RM", () => {
  for (const [line, price] of [
    ["Sofa RM179", 179],
    ["Sofa RM 179", 179],
    ["Sofa rm179", 179],
    ["Sofa RM179.00", 179],
    ["Sofa RM1,200", 1200],
    ["Sofa RM1,200.50", 1200.5],
  ]) {
    const p = parseAppointmentMessage(line);
    assert.equal(p.items.length, 1, `should parse: ${line}`);
    assert.equal(p.items[0].unitPrice, price, `wrong price for: ${line}`);
  }
});

// 8. the quantity trap
test("'2 seater' is description, never quantity", () => {
  const p = parseAppointmentMessage("Sofa 2 seater L RM179");
  assert.equal(p.items[0].description, "Sofa 2 seater L");
  assert.equal(p.items[0].quantity, 1);
  assert.equal(p.items[0].unitPrice, 179);
});

test("an RM amount is the line total, so quantity words never multiply it", () => {
  // V1 rule: "Sofa x2 RM358" commits RM358, not RM716. Guessing that 358 was
  // per-item would change the duration and the large-job classification.
  const p = parseAppointmentMessage("Sofa x2 RM358");
  assert.equal(p.items[0].description, "Sofa x2");
  assert.equal(p.items[0].quantity, 1);
  assert.equal(p.items[0].unitPrice, 358);
  assert.equal(itemsTotal(p.items), 358);
});

// 9 & 10. numbers that are not prices
test("postcodes, phone numbers and dates are never prices", () => {
  const p = parseAppointmentMessage(GRACE);
  assert.equal(p.items.length, 1);
  const prices = p.items.map((i) => i.unitPrice);
  assert.ok(!prices.includes(47100), "postcode became a price");
  assert.ok(!prices.includes(148136726), "phone became a price");
  assert.ok(!prices.includes(8), "date became a price");
});

test("a line without RM is never an item", () => {
  const p = parseAppointmentMessage("Sofa 2 seater 179\nMattress 120");
  assert.deepEqual(p.items, []);
  assert.equal(p.status.items, "MISSING");
});

test("summary lines are kept out of the items", () => {
  const p = parseAppointmentMessage(
    `Sofa RM179
Mattress RM120
Carpet RM80
Total RM379
Deposit RM100
Balance RM279`);
  assert.equal(p.items.length, 3);
  assert.equal(itemsTotal(p.items), 379);
  assert.equal(p.excludedLines.length, 3);
});

// 11. Malaysian dates
test("numeric dates are DD/MM/YY", () => {
  assert.equal(parseAppointmentMessage("Date: 8/9/26").date, "2026-09-08");
  assert.equal(parseAppointmentMessage("Date: 08/09/2026").date, "2026-09-08");
  assert.equal(parseAppointmentMessage("Date: 8-9-2026").date, "2026-09-08");
  assert.equal(parseAppointmentMessage("Date: 8.9.26").date, "2026-09-08");
  assert.equal(parseAppointmentMessage("Date: 8 Sep 2026").date, "2026-09-08");
  assert.equal(parseAppointmentMessage("Date: 8 September 2026").date, "2026-09-08");
});

test("a date that is ambiguous only under another convention still reads DD/MM", () => {
  // 9 August, not 9 September. The review screen renders it in long form so a
  // misread is visible before anyone taps a staff member.
  assert.equal(parseAppointmentMessage("Date: 9/8/26").date, "2026-08-09");
});

// 13. malformed date
test("an impossible date is refused, not coerced", () => {
  for (const bad of ["12/13/26", "31/2/26", "0/9/26", "32/1/26", "hello"]) {
    const p = parseAppointmentMessage(`Date: ${bad}`);
    assert.equal(p.date, "", `should refuse: ${bad}`);
    assert.equal(p.status.date, "NEEDS_CONFIRMATION", `should ask about: ${bad}`);
  }
});

// 12. times
test("normalises the usual WhatsApp time formats", () => {
  for (const [raw, expected] of [
    ["2pm", "14:00"], ["2 pm", "14:00"], ["2:00pm", "14:00"], ["2.00pm", "14:00"],
    ["14:00", "14:00"], ["1400", "14:00"], ["930", "09:30"],
    ["12pm", "12:00"], ["12am", "00:00"], ["12:30am", "00:30"], ["11.45AM", "11:45"],
  ]) {
    assert.equal(parseAppointmentMessage(`Time: ${raw}`).time, expected, `for: ${raw}`);
  }
});

test("an ambiguous time is asked about, never assumed", () => {
  for (const bad of ["2", "25:00", "10:75", "afternoon"]) {
    const p = parseAppointmentMessage(`Time: ${bad}`);
    assert.equal(p.time, "", `should refuse: ${bad}`);
    assert.equal(p.status.time, "NEEDS_CONFIRMATION");
  }
});

// 14. missing time
test("an absent field is MISSING, not confirmed", () => {
  const p = parseAppointmentMessage("Name: Grace\nDate: 9/9/26");
  assert.equal(p.status.time, "MISSING");
  assert.ok(p.missingFields.includes("time"));
  assert.ok(!p.confirmationFields.includes("time"));
});

// 15. missing area
test("no location heading means MISSING area", () => {
  const p = parseAppointmentMessage("Name: Grace\nAddress: 12 Jalan Test");
  assert.equal(p.areaCity, "");
  assert.equal(p.status.areaCity, "MISSING");
});

// 16 & 17. remarks
test("an empty Remark heading leaves remarks empty and the service an item", () => {
  const p = parseAppointmentMessage(GRACE);
  assert.equal(p.remarks, "");
  assert.equal(p.items.length, 1);
});

test("real remark text is preserved, and a price line below it is still an item", () => {
  const p = parseAppointmentMessage(
    `Remark
Please call before arriving
Gate code 1234

Sofa RM179`);
  assert.equal(p.remarks, "Please call before arriving\nGate code 1234");
  assert.deepEqual(p.items, [{ description: "Sofa", quantity: 1, unitPrice: 179 }]);
});

// 18. hostile input
test("markup in a message stays plain text", () => {
  const nasty = `Name: <script>alert(1)</script>
Address: <img src=x onerror=alert(1)>
javascript:alert(1) RM50`;
  const p = parseAppointmentMessage(nasty);
  assert.equal(p.customerName, "<script>alert(1)</script>");
  assert.equal(p.items[0].description, "javascript:alert(1)");
  // Plain strings in, plain strings out — the parser neither strips nor
  // executes; React escapes them at render, and Zod bounds them at the action.
  assert.equal(typeof p.customerName, "string");
});

// 19. THE authorization property
test("a pasted Staff line has no field to land in", () => {
  const p = parseAppointmentMessage(
    `Name: Grace
Staff: Victor
Workspace: KC Private Team
Role: super_master
Sofa RM179`);

  // The output type carries no staff, workspace, role or membership at all, so
  // there is nowhere for a pasted instruction to take effect.
  assert.ok(!("staffId" in p));
  assert.ok(!("staff" in p));
  assert.ok(!("workspaceId" in p));
  assert.ok(!("workspace" in p));
  assert.ok(!("role" in p));

  // And none of those lines is silently promoted into a field that IS used.
  assert.equal(p.customerName, "Grace");
  assert.ok(!p.address.includes("Victor"));
  assert.ok(!p.areaCity.includes("Victor"));
  assert.deepEqual(p.items, [{ description: "Sofa", quantity: 1, unitPrice: 179 }]);
});

// 20. junk tolerance
test("unrecognised lines are ignored without breaking the parse", () => {
  const p = markPastDateTime(parseAppointmentMessage(
    `Thanks for booking!!!
😀😀😀
Puchong Utama
Name: Grace
Date: 9/9/26
Time: 2pm
Address: 1 Jalan Puchong Utama
Sofa RM179
Please share this message`), CLOCK);
  assert.equal(p.customerName, "Grace");
  assert.equal(p.items.length, 1);
  assert.equal(p.status.date, "FOUND");
});

// ---- past / future, with an injected clock --------------------------------
//
// The rule CHANGED with migration 0010: a past appointment is recordable, so
// the parser MARKS it rather than demoting its fields. Pushing the owner into
// the correction form for a job that simply already happened is exactly the
// friction the paste flow exists to remove.

test("2pm today is future at 11am, and is not marked past", () => {
  const p = markPastDateTime(parseAppointmentMessage(GRACE), "2026-09-08T11:00");
  assert.equal(p.isPast, false);
  assert.equal(p.status.date, "FOUND");
  assert.equal(p.status.time, "FOUND");
  assert.deepEqual(p.confirmationFields, []);
});

test("10am today IS past at 11am — marked, but still valid data", () => {
  const morning = GRACE.replace("Appt Time:  2pm", "Appt Time: 10am");
  const p = markPastDateTime(parseAppointmentMessage(morning), "2026-09-08T11:00");
  assert.equal(p.isPast, true);
  assert.equal(p.status.date, "FOUND");
  assert.equal(p.status.time, "FOUND");
  assert.deepEqual(p.confirmationFields, []);
  assert.deepEqual(p.missingFields, []);
});

test("past is decided by the combined datetime, not the date alone", () => {
  assert.equal(markPastDateTime(parseAppointmentMessage(GRACE), "2026-09-08T13:59").isPast, false);
  assert.equal(markPastDateTime(parseAppointmentMessage(GRACE), "2026-09-08T14:00").isPast, true);
  assert.equal(markPastDateTime(parseAppointmentMessage(GRACE), "2026-09-08T14:01").isPast, true);
});

test("a past date is marked whatever the hour", () => {
  assert.equal(markPastDateTime(parseAppointmentMessage(GRACE), "2026-09-09T08:00").isPast, true);
});

test("marking never promotes an already-unparseable field", () => {
  const p = markPastDateTime(parseAppointmentMessage("Date: 12/13/26\nTime: 2pm"), CLOCK);
  assert.equal(p.status.date, "NEEDS_CONFIRMATION");
  assert.equal(p.isPast, false);
});

test("isPastDateTime compares the combined local datetime", () => {
  assert.equal(isPastDateTime("2026-09-08", "14:00", "2026-09-08T11:00"), false);
  assert.equal(isPastDateTime("2026-09-08", "10:00", "2026-09-08T11:00"), true);
  // Equal counts as past — the database guard is `<= now()`.
  assert.equal(isPastDateTime("2026-09-08", "11:00", "2026-09-08T11:00"), true);
  // Nothing to compare yet is not "past".
  assert.equal(isPastDateTime("", "10:00", "2026-09-08T11:00"), false);
  assert.equal(isPastDateTime("2026-09-08", "", "2026-09-08T11:00"), false);
});

// ---- limits and edges -----------------------------------------------------
test("a value longer than its column asks rather than truncating", () => {
  const p = parseAppointmentMessage(`Name: ${"A".repeat(130)}`);
  assert.equal(p.customerName.length, 130);
  assert.equal(p.status.customerName, "NEEDS_CONFIRMATION");
});

test("empty and whitespace input parse to nothing, without throwing", () => {
  for (const input of ["", "   ", "\n\n\n", null, undefined]) {
    const p = parseAppointmentMessage(input);
    assert.equal(p.items.length, 0);
    assert.equal(p.customerName, "");
    assert.ok(p.missingFields.length > 0);
  }
});

test("CRLF line endings are handled", () => {
  const p = parseAppointmentMessage(GRACE.replace(/\n/g, "\r\n"));
  assert.equal(p.customerName, "Grace");
  assert.equal(p.address, "no 36A Jalan PU 7/3\nBandar Puchong Utama 47100\nPuchong Selangor");
});

test("a huge paste is bounded rather than allowed to hang", () => {
  const p = parseAppointmentMessage("x\n".repeat(100_000));
  assert.ok(p.rawText.length <= 32_000);
});

test("looksLikeAppointment needs more than one signal", () => {
  assert.equal(looksLikeAppointment(parseAppointmentMessage("hello there")), false);
  assert.equal(looksLikeAppointment(parseAppointmentMessage("Sofa RM179")), false);
  assert.equal(looksLikeAppointment(parseAppointmentMessage(GRACE)), true);
});

test("businessNowLocal renders Malaysia wall-clock time", () => {
  // 2026-09-08T03:30Z is 11:30 in Kuala Lumpur (UTC+8).
  assert.equal(businessNowLocal(new Date("2026-09-08T03:30:00Z")), "2026-09-08T11:30");
  // Midnight must be 00, not 24.
  assert.equal(businessNowLocal(new Date("2026-09-07T16:00:00Z")), "2026-09-08T00:00");
});
