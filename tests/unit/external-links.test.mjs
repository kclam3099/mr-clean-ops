// External deep-link builders.
//
// These take customer-controlled free text and turn it into a URL the user
// will click, so the negative cases matter more than the positive ones: a
// value that is not a phone number must produce NO link, never a link that
// happens to carry something else.
//
// Run: npm run test:unit

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalisePhoneForWhatsApp, whatsappHref, mapsHref, buildReminderMessage,
} from "../../lib/external-links.ts";

test("normalises Malaysian numbers to bare international form", () => {
  assert.equal(normalisePhoneForWhatsApp("+60123456789"), "60123456789");
  assert.equal(normalisePhoneForWhatsApp("60123456789"), "60123456789");
  assert.equal(normalisePhoneForWhatsApp("0123456789"), "60123456789");
  assert.equal(normalisePhoneForWhatsApp("+60 12-345 6789"), "60123456789");
  assert.equal(normalisePhoneForWhatsApp(" (012) 345-6789 "), "60123456789");
});

test("rejects anything that is not plausibly a phone number", () => {
  for (const bad of [
    null, undefined, "", "   ",
    "not a number",
    "javascript:alert(1)",
    "012 javascript:alert(1)",
    "+60123456789 <script>",
    "0123456789@evil.example",
    "123",                       // too short
    "1234567890123456789",       // too long
    "+60-12-345-6789?text=x",    // query injection attempt
  ]) {
    assert.equal(normalisePhoneForWhatsApp(bad), null, `should reject: ${String(bad)}`);
  }
});

test("whatsappHref returns null rather than a broken link", () => {
  assert.equal(whatsappHref("not a phone", "hi"), null);
  assert.equal(whatsappHref(null, "hi"), null);
  assert.equal(whatsappHref("javascript:alert(1)", "hi"), null);
});

test("whatsappHref is always https://wa.me and encodes the message", () => {
  const href = whatsappHref("+60123456789", "Hi & welcome, see you at 10:00?");
  assert.ok(href.startsWith("https://wa.me/60123456789?text="));
  // The scheme is a literal in the module, so it cannot be influenced.
  assert.ok(!href.includes(" "));
  assert.ok(href.includes("%26"));   // &
  assert.ok(href.includes("%3F"));   // ?
});

test("a hostile message cannot break out of the query string", () => {
  const href = whatsappHref("+60123456789", 'x"&phone=999&y=<script>alert(1)</script>');
  assert.ok(href.startsWith("https://wa.me/60123456789?text="));
  // Only the single `?` that this module wrote may appear.
  assert.equal(href.split("?").length, 2);
  assert.ok(!href.includes("<script>"));
  assert.ok(!/&phone=/.test(href));
});

test("mapsHref builds an encoded Google Maps search, or null", () => {
  const href = mapsHref("12 Jalan Test", "Kepong");
  assert.equal(href, "https://www.google.com/maps/search/?api=1&query=12%20Jalan%20Test%2C%20Kepong");
  assert.equal(mapsHref(null, null), null);
  assert.equal(mapsHref("", "  "), null);
  assert.equal(mapsHref(null, "Cheras"), "https://www.google.com/maps/search/?api=1&query=Cheras");
});

test("a hostile address cannot inject extra parameters or markup", () => {
  const href = mapsHref('12 Jalan "Test" &q=evil', "<script>alert(1)</script>");
  assert.ok(href.startsWith("https://www.google.com/maps/search/?api=1&query="));
  assert.ok(!href.includes("<script>"));
  // Only the api=1& that this module wrote.
  assert.equal(href.split("&").length, 2);
});

test("reminder message includes the customer, a readable date and the time", () => {
  const msg = buildReminderMessage({
    customerName: "TEST CUSTOMER A", date: "2026-09-15", startTime: "10:00",
  });
  assert.ok(msg.includes("TEST CUSTOMER A"));
  assert.ok(msg.includes("15 September"));
  assert.ok(msg.includes("10:00"));
  assert.ok(msg.includes("Mr Clean & Clean"));
});

test("reminder message survives an unparseable date without throwing", () => {
  const msg = buildReminderMessage({ customerName: "X", date: "not-a-date", startTime: "10:00" });
  assert.ok(msg.includes("not-a-date"));
});
