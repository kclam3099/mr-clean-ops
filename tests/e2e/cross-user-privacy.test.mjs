// Cross-user RSC payload privacy — browser regression test.
//
// Locks in a real defect found during Phase F1 review:
//
//   Signing out used a SOFT (App Router) navigation. That keeps the current
//   document alive, so the outgoing user's React Server Component flight
//   payload survived in the DOM. After KC signed out and Nick signed in on the
//   same tab, Nick's SCREEN was correct, but Nick's BROWSER still held KC's
//   payload — including "KC Private Team", the private workspace UUID,
//   TEST_VICTOR, and KC's workspace scope options — all readable from
//   JavaScript.
//
// The fix is window.location.replace(): a full document replacement that drops
// both the payload and the history entry. This test proves the fix and, just as
// importantly, proves the leak is detectable — step 3 asserts the same strings
// ARE present for KC, so a test that silently stopped finding anything would
// fail rather than pass vacuously.
//
// Requires a running app. Defaults to http://localhost:3100; override with
// E2E_BASE_URL. Run: npm run test:e2e:privacy

import { chromium } from "playwright";
import {
  adminClient, assertDevProject, resolveIdentities, createFixture,
  createRecorder, rpc, signIn, bookingArgs, CONFIG,
} from "../../supabase/tests/lib/harness.mjs";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const PASSWORD = CONFIG.testPassword();

assertDevProject();

const db = await adminClient();
const ids = await resolveIdentities(db);
const fx = createFixture(db);
const rec = createRecorder("CROSS-USER RSC PRIVACY (browser)");

let browser;
try {
  await assertAppIsUp();

  // ---------------------------------------------------------------------------
  // Temporary synthetic fixture: KC must have something private to leak.
  // ---------------------------------------------------------------------------
  const kcToken = await signIn(ids.email.kc);
  // Tomorrow, not today: migration 0007 rejects appointments that do not start
  // strictly in the future, so a "today 10:00" fixture fails whenever this suite
  // runs after 10am. The date only has to be somewhere KC can load it.
  const today = (await fx.query(
    `select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + 1), 'YYYY-MM-DD') d`))[0].d;

  const PRIVATE_CUSTOMER = "E2E PRIVATE CUSTOMER OMEGA";
  const SHARED_CUSTOMER = "E2E SHARED CUSTOMER ALPHA";

  const priv = await rpc("create_appointment", kcToken, bookingArgs({
    ws: ids.ws.private, staff: ids.staff.victor, date: today, time: "10:00", amount: 300,
    remarks: fx.TAG,
    customer: {
      p_customer_name: PRIVATE_CUSTOMER, p_customer_phone: "+60000009999",
      p_address_line: "E2E PRIVATE ADDRESS", p_area_city: "E2E PRIVATE CITY",
    },
  }));
  if (priv.ok) fx.track(priv.body);

  const shared = await rpc("create_appointment", kcToken, bookingArgs({
    ws: ids.ws.shared, staff: ids.staff.jack, date: today, time: "13:00", amount: 200,
    remarks: fx.TAG,
    customer: {
      p_customer_name: SHARED_CUSTOMER, p_customer_phone: "+60000000001",
      p_address_line: "E2E SHARED ADDRESS", p_area_city: "E2E SHARED CITY",
    },
  }));
  if (shared.ok) fx.track(shared.body);

  rec.check({
    id: "E2E-00 fixture", actor: "KC", setup: "clean baseline",
    action: "create one KC Private Team and one Shared Team appointment for today",
    expected: "both created",
    actual: `private=${priv.ok ? "ok" : priv.msg}, shared=${shared.ok ? "ok" : shared.msg}`,
    ok: priv.ok && shared.ok,
  });
  if (!priv.ok || !shared.ok) throw new Error("fixture failed; aborting");

  // Strings that must never survive into Nick's browser.
  //
  // The third element marks a term that must also be PRESENT in KC's own
  // document, so step E2E-01 can prove the scan is capable of finding a leak at
  // all. All six qualify once /calendar is hard-loaded as KC: that is what
  // streams the payload into inline script tags, which is the leak's substrate.
  const KC_ONLY = [
    ["private workspace name", "KC Private Team", true],
    ["private staff display name", "TEST_VICTOR", true],
    ["virtual merged scope", "All Operations", true],
    ["private workspace UUID", ids.ws.private, true],
    ["private customer fixture", PRIVATE_CUSTOMER, true],
    ["private appointment UUID", priv.body, true],
  ];
  const BASELINE = KC_ONLY.filter(([, , inKcDoc]) => inKcDoc);

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // ---------------------------------------------------------------------------
  // 1-3. KC signs in, and the KC-only data legitimately IS present.
  // ---------------------------------------------------------------------------
  await login(page, ids.email.kc);
  // Masters land on /dashboard; the leak test then hard-loads /calendar itself.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

  // Load /calendar as a FULL page load, not just the post-login soft navigation.
  // This is what puts KC's payload into inline `self.__next_f.push(...)` script
  // tags in the document. Those tags are what a later soft navigation fails to
  // remove — reaching /calendar only by soft nav leaves __next_f empty and the
  // leak cannot occur, so a test that skipped this would pass vacuously.
  await page.goto(`${BASE}/calendar?week=${today}`, { waitUntil: "load" });
  await page.waitForSelector("article", { timeout: 20_000 });

  const kcDoc = await snapshot(page);
  const presentForKc = BASELINE.filter(([, term]) => kcDoc.combined.includes(term)).map(([l]) => l);
  rec.check({
    id: "E2E-01 KC baseline (guards against a vacuous pass)", actor: "TEST_KC",
    setup: "signed in, /calendar rendered",
    action: "confirm KC-only data really is in KC's document",
    expected: `all ${BASELINE.length} rendered markers present`,
    actual: `${presentForKc.length}/${BASELINE.length}: ${presentForKc.join(", ")}`,
    ok: presentForKc.length === BASELINE.length,
  });
  rec.check({
    id: "E2E-02 KC scope selector", actor: "TEST_KC", setup: "two visible workspaces",
    action: "count workspace <select> elements",
    expected: "1 (All Operations / Shared Team / KC Private Team)",
    actual: `${kcDoc.selects}`, ok: kcDoc.selects === 1,
  });

  // ---------------------------------------------------------------------------
  // 4-5. Sign out, then Nick signs in — SAME tab, same browser context.
  // ---------------------------------------------------------------------------
  // CRITICAL: the second sign-in must happen IN PLACE, in whatever document the
  // sign-out left behind. Calling page.goto() here would itself be a full
  // document navigation and would wipe the payload no matter how sign-out
  // behaved — the test would pass even with the bug present. (It did, the first
  // time this was written.) The real user never navigates manually: they click
  // Sign out and type into the form that appears.
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL(`${BASE}/login`, { timeout: 20_000 });
  await loginInPlace(page, ids.email.nick);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  // Wait for the shell AND for streaming to finish. With loading.tsx in place
  // the skeleton renders first, and snapshotting then would scan ~100 characters
  // of placeholder and "pass" without ever seeing the real page.
  await page.waitForSelector("header nav a", { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 20_000 });
  await page.waitForTimeout(500);

  // ---------------------------------------------------------------------------
  // 6-7. Nothing of KC's may survive — visible DOM, full HTML, or flight payload.
  // ---------------------------------------------------------------------------
  const nickDoc = await snapshot(page);
  rec.check({
    id: "E2E-03 Nick is the signed-in user", actor: "TEST_NICK", setup: "same tab",
    action: "read the account name from the header",
    expected: "TEST_NICK", actual: String(nickDoc.account), ok: nickDoc.account === "TEST_NICK",
  });

  assertNoKcTrace("E2E-04", "after sign-out and sign-in as Nick", nickDoc);

  // Proves Nick's page genuinely rendered — otherwise "no KC data found" could
  // just mean "nothing rendered at all", which would pass vacuously.
  // Role-agnostic: asserts Nick's shell rendered, without depending on which
  // page is currently the Master home. A blank page would otherwise scan
  // "clean" and pass for the wrong reason.
  const nickRendered = nickDoc.account === "TEST_NICK"
    && nickDoc.visibleText.includes("Shared Team")
    && nickDoc.navLinks >= 3;
  rec.check({
    id: "E2E-05 Nick's own page really rendered", actor: "TEST_NICK",
    setup: "whichever page is the Master home",
    action: "check the account name, workspace label and navigation",
    expected: "all present — so a clean scan means clean, not blank",
    actual: `account=${nickDoc.account} label=${nickDoc.visibleText.includes("Shared Team")} ` +
            `navLinks=${nickDoc.navLinks} at ${new URL(nickDoc.url).pathname}`,
    ok: nickRendered,
  });
  rec.check({
    id: "E2E-06 Nick has no workspace switcher", actor: "TEST_NICK",
    setup: "one visible workspace",
    action: "count <select> elements",
    expected: "0 — a selector would imply another workspace exists",
    actual: `${nickDoc.selects}`, ok: nickDoc.selects === 0, security: true,
  });

  // ---------------------------------------------------------------------------
  // 8-9. Back / Forward must not resurrect KC's document.
  // ---------------------------------------------------------------------------
  await page.goBack({ waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(1500);
  const backDoc = await snapshot(page);
  assertNoKcTrace("E2E-07", "after browser BACK", backDoc);

  await page.goForward({ waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(1500);
  const fwdDoc = await snapshot(page);
  assertNoKcTrace("E2E-08", "after browser FORWARD", fwdDoc);

  // A hard reload must not resurrect it from bfcache either.
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1500);
  assertNoKcTrace("E2E-09", "after a full reload", await snapshot(page));

  // replace() should have dropped the signed-in KC entry from session history.
  const backToKc = await page.evaluate(() => history.length);
  rec.check({
    id: "E2E-10 history depth", actor: "TEST_NICK", setup: "sign-out used location.replace()",
    action: "read history.length",
    expected: "small — the KC page was replaced, not stacked",
    actual: `${backToKc} entries`, ok: backToKc <= 6,
  });

  function assertNoKcTrace(idPrefix, when, doc) {
    const surfaces = [
      ["visible DOM text", doc.visibleText],
      ["full document HTML", doc.html],
      ["RSC flight payload", doc.flight],
    ];
    for (const [surface, haystack] of surfaces) {
      const found = KC_ONLY.filter(([, term]) => haystack.includes(term)).map(([l]) => l);
      rec.check({
        id: `${idPrefix} ${surface}`, actor: "TEST_NICK", setup: when,
        action: `${when} — scan ${surface} (${haystack.length} chars, at ${path(doc.url)})`,
        expected: "0 traces of KC-only data",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }
  }

  // =========================================================================
  // 7. Dashboard aggregates must not include hidden rows
  // =========================================================================
  // A summary is a place a leak hides in plain sight: the private appointment
  // never appears as a card, but a total computed over all rows would still
  // disclose its value. KC and Nick must see DIFFERENT totals for the same day.
  {
    const kcCtx = await browser.newContext();
    const kcPage = await kcCtx.newPage();
    await kcPage.goto(`${BASE}/login`, { waitUntil: "load" });
    await kcPage.fill("input[name=email]", ids.email.kc);
    await kcPage.fill("input[name=password]", PASSWORD);
    await kcPage.click("button[type=submit]");
    await kcPage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
    await kcPage.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await kcPage.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 20_000 });
    const kcStats = await readStats(kcPage);
    await kcCtx.close();

    const nickCtx = await browser.newContext();
    const nickPage = await nickCtx.newPage();
    await nickPage.goto(`${BASE}/login`, { waitUntil: "load" });
    await nickPage.fill("input[name=email]", ids.email.nick);
    await nickPage.fill("input[name=password]", PASSWORD);
    await nickPage.click("button[type=submit]");
    await nickPage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
    await nickPage.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await nickPage.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 20_000 });
    const nickStats = await readStats(nickPage);
    const nickPage_ = await nickPage.evaluate(() => ({
      html: document.documentElement.outerHTML,
      flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
      text: document.body.innerText,
    }));
    await nickCtx.close();

    rec.check({
      id: "DASH-01 KC's dashboard counts the private appointment", actor: "TEST_KC",
      setup: "a private appointment exists today alongside a shared one",
      action: "read the Today count and total",
      expected: "includes both",
      actual: kcStats, ok: kcStats.length > 0,
    });
    rec.check({
      id: "DASH-02 Nick's totals exclude the hidden row (CRITICAL)", actor: "TEST_NICK",
      setup: "same day, same dashboard",
      action: "compare Nick's Today figures against KC's",
      expected: "different — a shared aggregate would disclose the hidden job's value",
      actual: `KC="${kcStats}" NICK="${nickStats}"`,
      ok: kcStats !== nickStats, security: true,
    });
    for (const [surface, hay] of [
      ["visible text", nickPage_.text], ["HTML", nickPage_.html], ["RSC payload", nickPage_.flight],
    ]) {
      const found = KC_ONLY.filter(([, t]) => hay.includes(t)).map(([l]) => l);
      rec.check({
        id: `DASH-03 dashboard ${surface} clean (CRITICAL)`, actor: "TEST_NICK", setup: "-",
        action: `scan the dashboard ${surface}`,
        expected: "0 traces",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }
  }

} finally {
  const summary = rec.summary();
  if (browser) await browser.close();
  const removed = await fx.cleanup();
  console.log(`fixture cleanup: ${removed.appointments} appointments`);
  await db.end();
  process.exitCode = summary.fail === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

/** The Today stat card's number and total, as a comparable string. */
async function readStats(page) {
  return page.evaluate(() => {
    const card = [...document.querySelectorAll("div")]
      .find((d) => /^TODAY/i.test(d.innerText.trim()));
    return card ? card.innerText.replace(/\s+/g, " ").trim() : "";
  });
}

async function assertAppIsUp() {
  try {
    const r = await fetch(`${BASE}/login`, { redirect: "manual" });
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(
      `\nCannot reach the app at ${BASE} (${e.message}).\n` +
      `Start it first (npm run dev), or set E2E_BASE_URL.\n`,
    );
    process.exit(2);
  }
}

/** First sign-in of a run: navigate to the login page from nothing. */
async function login(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await submitLogin(page, email);
}

/**
 * Sign in WITHOUT navigating — used for the second user, so the document the
 * sign-out produced is the one under test. Any goto() here would silently
 * defeat the whole test.
 */
async function loginInPlace(page, email) {
  await page.waitForSelector("input[name=email]", { timeout: 20_000 });
  await submitLogin(page, email);
}

async function submitLogin(page, email) {
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", PASSWORD);
  await page.click("button[type=submit]");
}

/** Every surface a leak could hide in. */
async function snapshot(page) {
  const data = await page.evaluate(() => {
    // The flight payload lives in self.__next_f as an array of chunks, and also
    // inline in the <script> tags that push into it. Capture both.
    const flightChunks = (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n");
    const scripts = [...document.querySelectorAll("script")].map((s) => s.textContent ?? "").join("\n");
    return {
      url: location.href,
      html: document.documentElement.outerHTML,
      visibleText: document.body?.innerText ?? "",
      flight: `${flightChunks}\n${scripts}`,
      selects: document.querySelectorAll("select").length,
      dayHeadings: document.querySelectorAll("section h2").length,
      navLinks: document.querySelectorAll("header nav a").length,
      account: document.querySelector("header .ml-auto span")?.textContent?.trim() ?? null,
    };
  });
  return { ...data, combined: `${data.html}\n${data.flight}\n${data.visibleText}` };
}

function path(url) {
  try { return new URL(url).pathname; } catch { return url; }
}
