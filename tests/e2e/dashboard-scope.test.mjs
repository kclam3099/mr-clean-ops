// Dashboard two-week overview, and scope-label consistency.
//
// Two properties under test. The dashboard must be a SCAN surface: compact
// rows, no per-appointment action buttons, no full address. And the scope shown
// in the nav selector must agree with the scope named in the page heading and
// with the rows actually returned — they previously disagreed, because a layout
// cannot read its children's search params.
//
// The suite seeds and removes its own appointments and never resets the DEV
// baseline, so manual data is left alone.
//
// Run: npm run test:e2e:dashboard

import { chromium } from "playwright";
import {
  adminClient, assertDevProject, resolveIdentities, createFixture,
  createRecorder, CONFIG, signIn, rpc, bookingArgs, SYNTHETIC_PRIVATE_CUSTOMER,
} from "../../supabase/tests/lib/harness.mjs";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const PASSWORD = CONFIG.testPassword();

assertDevProject();
const db = await adminClient();
const ids = await resolveIdentities(db);
const fx = createFixture(db);
const rec = createRecorder("DASHBOARD + SCOPE (browser)");

const KC_ONLY = [
  ["Victor name", "TEST_VICTOR"],
  ["Victor staff id", ids.staff.victor],
  ["private workspace id", ids.ws.private],
  ["private workspace name", "KC Private Team"],
  ["private customer", SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name],
];

let browser;
try {
  await assertAppIsUp();
  browser = await chromium.launch();

  const scalar = async (sql, params = []) => (await fx.query(sql, params))[0].v;
  const today = await scalar(
    `select to_char((now() at time zone 'Asia/Kuala_Lumpur')::date,'YYYY-MM-DD') v`);
  // Monday-anchored, matching weekRange().
  const thisWeekEnd = await scalar(
    `select to_char(date_trunc('week', $1::date)::date + 6,'YYYY-MM-DD') v`, [today]);
  const nextWeekStart = await scalar(
    `select to_char(date_trunc('week', $1::date)::date + 7,'YYYY-MM-DD') v`, [today]);

  async function session(email, viewport = { width: 1440, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.fill("input[name=email]", email);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
    return { ctx, page };
  }
  const settle = async (page) => {
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 20_000 })
      .catch(() => {});
    await page.waitForTimeout(600);
  };

  // ---- fixtures: this week (shared), next week (shared), next week (private)
  const kcToken = await signIn(ids.email.kc);
  const seeds = [];
  const seed = async (label, { staff, ws, date, time, amount, customer }) => {
    const r = await rpc("create_appointment", kcToken, {
      ...bookingArgs({ ws, staff, date, time, amount, remarks: fx.TAG, customer }),
      // The slot may be earlier today; historical recording is allowed now.
      p_confirm_past: true,
    });
    if (r.ok) { fx.track(r.body); seeds.push({ label, id: r.body }); }
    else console.log(`  seed ${label} failed: ${r.msg}`);
    return r;
  };

  const sharedThisWeek = await seed("shared/this-week", {
    staff: ids.staff.jack, ws: ids.ws.shared, date: thisWeekEnd, time: "10:00", amount: 416,
    customer: { p_customer_name: "TEST CUSTOMER DASH THISWEEK", p_customer_phone: "+60123456789",
      p_address_line: "88 Jalan Very Long Address Damansara Perdana Petaling Jaya", p_area_city: "Damansara Perdana" },
  });
  const sharedNextWeek = await seed("shared/next-week", {
    staff: ids.staff.dyron, ws: ids.ws.shared, date: nextWeekStart, time: "13:00", amount: 350,
    customer: { p_customer_name: "TEST CUSTOMER DASH NEXTWEEK", p_customer_phone: "+60123456789",
      p_address_line: "12 Jalan Test", p_area_city: "Puchong" },
  });
  const privateNextWeek = await seed("private/next-week", {
    staff: ids.staff.victor, ws: ids.ws.private, date: nextWeekStart, time: "15:00", amount: 300,
    customer: SYNTHETIC_PRIVATE_CUSTOMER,
  });

  rec.check({
    id: "DB-00 fixtures created", actor: "KC", setup: "-",
    action: "seed one shared job this week, one shared and one private next week",
    expected: "all three created",
    actual: `${sharedThisWeek.ok} ${sharedNextWeek.ok} ${privateNextWeek.ok}`,
    ok: sharedThisWeek.ok && sharedNextWeek.ok && privateNextWeek.ok,
  });

  const read = (page) => page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-appointment-row]")];
    return {
      heading: document.querySelector("[data-scope-label]")?.textContent?.trim() ?? "",
      selector: (() => {
        const s = document.querySelector("[data-scope-selector]");
        return s ? s.options[s.selectedIndex].textContent.trim() : null;
      })(),
      rowCount: rows.length,
      rowText: rows.map((r) => r.innerText.replace(/\s+/g, " ").trim()),
      rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
      hasThisWeek: /THIS WEEK/i.test(document.body.innerText),
      hasNextWeek: /NEXT WEEK/i.test(document.body.innerText),
      actionButtons: [...document.querySelectorAll("a")]
        .filter((a) => /^(Directions|Call|WhatsApp)$/.test(a.textContent.trim())).length,
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
      flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  // =========================================================================
  // 1. KC — scope drives heading, selector AND rows together
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);

    for (const [label, query, expectLabel, expectPrivate, expectShared] of [
      ["All Operations", "", "All Operations", true, true],
      ["Shared Team", `?ws=${ids.ws.shared}`, "Shared Team", false, true],
      ["KC Private Team", `?ws=${ids.ws.private}`, "KC Private Team", true, false],
    ]) {
      await page.goto(`${BASE}/dashboard${query}`, { waitUntil: "load" });
      await settle(page);
      const m = await read(page);

      rec.check({
        id: `DB-01 ${label}: heading and selector agree (CRITICAL)`, actor: "KC",
        setup: label,
        action: "compare the page heading against the nav selector",
        expected: `both say "${expectLabel}"`,
        actual: `heading="${m.heading}" selector="${m.selector}"`,
        ok: m.heading.startsWith(expectLabel) && m.selector === expectLabel,
      });

      const hasPrivate = m.text.includes(SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name);
      const hasShared = m.text.includes("TEST CUSTOMER DASH NEXTWEEK");
      rec.check({
        id: `DB-02 ${label}: rows follow the same scope`, actor: "KC", setup: label,
        action: "check which seeded appointments are listed",
        expected: `private=${expectPrivate} shared=${expectShared}`,
        actual: `private=${hasPrivate} shared=${hasShared}`,
        ok: hasPrivate === expectPrivate && hasShared === expectShared,
      });
    }

    // Two-week structure and density.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    const m = await read(page);

    rec.check({
      id: "DB-03 both weeks are present", actor: "KC", setup: "-",
      action: "look for This week and Next week sections",
      expected: "both",
      actual: `thisWeek=${m.hasThisWeek} nextWeek=${m.hasNextWeek}`,
      ok: m.hasThisWeek && m.hasNextWeek,
    });

    rec.check({
      id: "DB-04 rows are compact", actor: "KC", setup: "1440px",
      action: "measure each appointment row",
      expected: "no row taller than 60px",
      actual: m.rowHeights.length ? `${m.rowHeights.join(", ")}px` : "no rows",
      ok: m.rowHeights.length > 0 && m.rowHeights.every((h) => h <= 60),
    });

    rec.check({
      id: "DB-05 no per-appointment action buttons", actor: "KC",
      setup: "those belong on the appointment itself",
      action: "count Directions / Call / WhatsApp links",
      expected: "0",
      actual: `${m.actionButtons}`, ok: m.actionButtons === 0,
    });

    rec.check({
      id: "DB-06 the full address is not rendered, but the area is", actor: "KC", setup: "-",
      action: "look for the long address line and for the area",
      expected: "address absent, area present",
      actual: `address=${m.text.includes("88 Jalan Very Long Address")} area=${m.text.includes("Damansara Perdana")}`,
      ok: !m.text.includes("88 Jalan Very Long Address") && m.text.includes("Damansara Perdana"),
    });

    rec.check({
      id: "DB-07 a row carries time, customer, staff, area, amount and status", actor: "KC",
      setup: "-", action: "read the seeded row",
      expected: "all six fields",
      actual: m.rowText.find((t) => t.includes("TEST CUSTOMER DASH THISWEEK")) ?? "(row not found)",
      ok: (() => {
        const row = m.rowText.find((t) => t.includes("TEST CUSTOMER DASH THISWEEK")) ?? "";
        return ["10:00", "TEST CUSTOMER DASH THISWEEK", "TEST_JACK", "Damansara Perdana", "416"]
          .every((f) => row.includes(f)) && /booked/i.test(row);
      })(),
    });

    // Rows click through to the existing detail route.
    const href = await page.evaluate(() =>
      document.querySelector("[data-appointment-row]")?.getAttribute("href") ?? null);
    rec.check({
      id: "DB-08 a row links to the appointment detail", actor: "KC", setup: "-",
      action: "read a row's href",
      expected: "/appointments/<uuid>",
      actual: href ?? "(none)",
      ok: !!href && /^\/appointments\/[0-9a-f-]{36}$/i.test(href),
    });

    // Empty days remain visible, compactly.
    rec.check({
      id: "DB-09 empty days stay visible but small", actor: "KC", setup: "-",
      action: "look for a 'No appointments' day line",
      expected: "present",
      actual: /No appointments/.test(m.text) ? "present" : "absent",
      ok: /No appointments/.test(m.text),
    });

    // Switching scope through the SELECTOR must move heading and rows together.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    await page.selectOption("[data-scope-selector]", { label: "Shared Team" });
    await page.waitForTimeout(2500);
    const afterSwitch = await read(page);
    rec.check({
      id: "DB-10 switching scope updates heading, selector and rows together (CRITICAL)",
      actor: "KC", setup: "started on All Operations",
      action: "choose Shared Team in the selector",
      expected: "heading and selector say Shared Team, and the private row disappears",
      actual: `heading="${afterSwitch.heading}" selector="${afterSwitch.selector}" `
            + `private=${afterSwitch.text.includes(SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name)}`,
      ok: afterSwitch.heading.startsWith("Shared Team")
          && afterSwitch.selector === "Shared Team"
          && !afterSwitch.text.includes(SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name),
    });

    // And the scope survives navigating to another page.
    await page.click('nav a:has-text("Calendar")');
    await page.waitForTimeout(2500);
    const onCalendar = await page.evaluate(() => ({
      url: location.search,
      selector: (() => {
        const s = document.querySelector("[data-scope-selector]");
        return s ? s.options[s.selectedIndex].textContent.trim() : null;
      })(),
      heading: document.body.innerText.split("\n").find((l) => /Shared Team|All Operations|KC Private/.test(l)) ?? "",
    }));
    rec.check({
      id: "DB-11 the chosen scope survives navigation", actor: "KC", setup: "Shared Team selected",
      action: "click Calendar in the nav",
      expected: "still Shared Team, in the URL and both labels",
      actual: `url="${onCalendar.url}" selector="${onCalendar.selector}" heading="${onCalendar.heading}"`,
      ok: onCalendar.url.includes(ids.ws.shared) && onCalendar.selector === "Shared Team",
    });
    await ctx.close();
  }

  // =========================================================================
  // 2. Nick — one workspace, no selector, nothing private anywhere
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    const m = await read(page);

    rec.check({
      id: "DB-12 Nick sees no scope selector", actor: "NICK", setup: "one visible workspace",
      action: "look for the selector",
      expected: "absent — a selector would imply another workspace exists",
      actual: m.selector === null ? "absent" : `PRESENT (${m.selector})`,
      ok: m.selector === null, security: true,
    });

    rec.check({
      id: "DB-13 Nick's heading names his own workspace", actor: "NICK", setup: "-",
      action: "read the heading",
      expected: "Shared Team",
      actual: m.heading, ok: m.heading.startsWith("Shared Team"),
    });

    for (const [label, hay] of [
      ["visible text", m.text], ["HTML", m.html], ["RSC payload", m.flight],
    ]) {
      const found = KC_ONLY.filter(([, needle]) => hay.includes(needle)).map(([l]) => l);
      rec.check({
        id: `DB-14 dashboard ${label} clean (CRITICAL)`, actor: "NICK",
        setup: "a private appointment exists next week",
        action: `scan the ${label}`,
        expected: "0 traces",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }

    // A forged private scope must fall back silently, in BOTH the data and the
    // label — a heading that echoed "KC Private Team" would disclose the name.
    await page.goto(`${BASE}/dashboard?ws=${ids.ws.private}`, { waitUntil: "load" });
    await settle(page);
    const forged = await read(page);
    rec.check({
      id: "DB-15 a forged private scope does not reach the heading (CRITICAL)", actor: "NICK",
      setup: "?ws=<private workspace id>",
      action: "read the heading and scan the page",
      expected: "Shared Team, and no private trace",
      actual: `heading="${forged.heading}" leaks=${KC_ONLY.filter(([, n]) => forged.text.includes(n)).length}`,
      ok: forged.heading.startsWith("Shared Team")
          && !KC_ONLY.some(([, n]) => forged.text.includes(n)),
      security: true,
    });
    await ctx.close();
  }

  // =========================================================================
  // 3. Responsive
  // =========================================================================
  for (const width of [390, 768, 850, 1440]) {
    const { page, ctx } = await session(ids.email.kc, { width, height: 900 });
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    const m = await read(page);

    rec.check({
      id: `DB-16 ${width}px no horizontal overflow`, actor: "KC", setup: `${width}px`,
      action: "measure horizontal overflow",
      expected: "none",
      actual: m.overflow > 0 ? `${m.overflow}px` : "none", ok: m.overflow <= 0,
    });
    rec.check({
      id: `DB-17 ${width}px rows stay compact`, actor: "KC", setup: `${width}px`,
      action: "measure row heights",
      expected: "no row taller than 96px even when stacked on a phone",
      actual: m.rowHeights.length ? `${Math.max(...m.rowHeights)}px tallest` : "no rows",
      ok: m.rowHeights.length > 0 && Math.max(...m.rowHeights) <= 96,
    });
    rec.check({
      id: `DB-18 ${width}px both weeks reachable`, actor: "KC", setup: `${width}px`,
      action: "look for both week sections",
      expected: "both present",
      actual: `thisWeek=${m.hasThisWeek} nextWeek=${m.hasNextWeek}`,
      ok: m.hasThisWeek && m.hasNextWeek,
    });
    await ctx.close();
  }
} finally {
  const summary = rec.summary();
  if (browser) await browser.close();
  // Only what this suite created — manual DEV appointments are left alone.
  await db.query(`delete from public.appointment_items where appointment_id in
    (select id from public.appointments where customer_name like 'TEST CUSTOMER DASH%')`);
  await db.query(`delete from public.audit_logs where entity_id in
    (select id from public.appointments where customer_name like 'TEST CUSTOMER DASH%')`);
  await db.query(`delete from public.appointments where customer_name like 'TEST CUSTOMER DASH%'`);
  await fx.cleanup();
  await db.end();
  process.exitCode = summary.fail === 0 ? 0 : 1;
}

async function assertAppIsUp() {
  try {
    const r = await fetch(`${BASE}/login`, { redirect: "manual" });
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`\nCannot reach the app at ${BASE} (${e.message}). Start it first.\n`);
    process.exit(2);
  }
}
