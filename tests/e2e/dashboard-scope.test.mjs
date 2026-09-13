// Dashboard month operations overview, scope consistency, and privacy.
//
// The dashboard is a MONTH calendar: the question on logging in is "how full
// are we", which is a shape, not a sequence. So the properties under test are
// calendar properties — the right month, today marked, navigation that moves
// the query, cells that stay compact when a day is busy — plus the two that
// were true of the old dashboard and must stay true: the scope named in the
// heading agrees with the selector AND the rows, and nothing private reaches a
// Master who cannot see it.
//
// Both layouts (month grid, and mini-grid + day agenda) are in the DOM at once,
// switched by CSS. Every query here is therefore filtered to what is actually
// VISIBLE at the current width — counting both would have made every assertion
// double, and a broken breakpoint would still have looked green.
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
const rec = createRecorder("DASHBOARD MONTH + SCOPE (browser)");
// How many checks this suite intends to reach. A run that reaches a different
// number fails, whatever the pass tally says: F2 once reported 31 PASS / 0 FAIL
// with fifteen checks never executed, because a fixture threw and the summary
// only described what had run. Adding or removing a check means updating this
// number — deliberately, in the same diff.
rec.plan(58);


const KC_ONLY = [
  ["Victor name", "TEST_VICTOR"],
  ["Victor staff id", ids.staff.victor],
  ["private workspace id", ids.ws.private],
  ["private workspace name", "KC Private Team"],
  ["private customer", SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name],
];

/** "2026-09-11" -> "September 2026", matching monthLabel() in the read layer. */
const monthLabelOf = (iso) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, 1)));

const monthKeyShift = (iso, n) => {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

let browser;
try {
  await assertAppIsUp();
  browser = await chromium.launch();

  await fx.watchAppointments(`customer_name like 'TEST CUSTOMER DASH%'`, []);

  const scalar = async (sql, params = []) => (await fx.query(sql, params))[0].v;
  const today = await scalar(
    `select to_char((now() at time zone 'Asia/Kuala_Lumpur')::date,'YYYY-MM-DD') v`);
  const thisMonth = today.slice(0, 7);

  /**
   * A date inside the CURRENT month on which none of `staffIds` is booked.
   *
   * Fixed offsets used to be fine and are not any more: the owner works in DEV,
   * so a chosen day may already be taken. Anything in the month is acceptable,
   * including a past one — historical recording is allowed and the month grid
   * shows the whole month regardless.
   */
  const freeInMonth = async (staffIds, exclude = []) => {
    const rows = await fx.query(
      `select to_char(d, 'YYYY-MM-DD') dt
         from generate_series(
                date_trunc('month', $1::date)::date,
                (date_trunc('month', $1::date) + interval '1 month - 1 day')::date,
                interval '1 day') d
        where not exists (
                select 1 from public.appointments a
                 where a.appt_date = d::date
                   and a.staff_id = any($2::uuid[])
                   and a.status <> 'cancelled')
          and to_char(d, 'YYYY-MM-DD') <> all($3::text[])
        order by d`,
      [today, staffIds, exclude]);
    return rows.length ? rows[0].dt : null;
  };

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
    await page.waitForSelector("[data-month-grid]", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(500);
  };

  // ---- fixtures ----------------------------------------------------------
  const kcToken = await signIn(ids.email.kc);
  const seed = async (label, { staff, ws, date, time, amount, customer }) => {
    const r = await rpc("create_appointment", kcToken, {
      ...bookingArgs({ ws, staff, date, time, amount, remarks: fx.TAG, customer }),
      // The slot may be earlier this month; historical recording is allowed.
      p_confirm_past: true,
    });
    if (r.ok) fx.track(r.body);
    else console.log(`  seed ${label} failed: ${r.msg}`);
    return r;
  };
  const cust = (name, extra = {}) => ({
    p_customer_name: name, p_customer_phone: "+60123456789",
    p_address_line: "88 Jalan Very Long Address Damansara Perdana Petaling Jaya",
    p_area_city: "Damansara Perdana", ...extra,
  });

  // A day with FOUR appointments, one more than a cell shows, so "+N more" has
  // something to reveal. Two staff, two times each: no staff member overlaps
  // themselves, so the scheduling engine accepts all four.
  const denseDate = await freeInMonth([ids.staff.jack, ids.staff.dyron]);
  const largeDate = await freeInMonth([ids.staff.jack], [denseDate]);
  const privateDate = await freeInMonth([ids.staff.victor], [denseDate, largeDate]);

  const dense = [];
  if (denseDate) {
    for (const [i, [staff, time]] of [
      [ids.staff.jack, "09:00"], [ids.staff.dyron, "09:00"],
      [ids.staff.jack, "14:00"], [ids.staff.dyron, "14:00"],
    ].entries()) {
      dense.push(await seed(`dense-${i}`, {
        staff, ws: ids.ws.shared, date: denseDate, time, amount: 100 + i,
        customer: cust(`TEST CUSTOMER DASH DENSE ${i}`),
      }));
    }
  }
  // Over the RM600 full-day threshold, so the engine marks it a large job.
  const large = largeDate ? await seed("large", {
    staff: ids.staff.jack, ws: ids.ws.shared, date: largeDate, time: "10:00", amount: 700,
    customer: cust("TEST CUSTOMER DASH LARGE"),
  }) : { ok: false };
  const priv = privateDate ? await seed("private", {
    staff: ids.staff.victor, ws: ids.ws.private, date: privateDate, time: "15:00", amount: 300,
    customer: SYNTHETIC_PRIVATE_CUSTOMER,
  }) : { ok: false };

  const seeded = dense.every((r) => r.ok) && large.ok && priv.ok && dense.length === 4;
  rec.check({
    id: "DB-00 fixtures created", actor: "KC", setup: "-",
    action: "seed a four-appointment day, a large job and a private job, all this month",
    expected: "all six created",
    actual: `dense=${dense.filter((r) => r.ok).length}/4 large=${large.ok} private=${priv.ok}`,
    ok: seeded,
  });

  /**
   * What is on screen — VISIBLE elements only, because the grid and the
   * mini-grid + agenda are both in the DOM and CSS picks between them.
   */
  const read = (page) => page.evaluate(() => {
    const vis = (el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    };
    const all = (sel) => [...document.querySelectorAll(sel)].filter(vis);
    const rows = all("[data-appointment-row]");
    return {
      heading: document.querySelector("[data-scope-label]")?.textContent?.trim() ?? "",
      selector: (() => {
        const s = document.querySelector("[data-scope-selector]");
        return s ? s.options[s.selectedIndex].textContent.trim() : null;
      })(),
      monthLabel: document.querySelector("[data-month-label]")?.textContent?.trim() ?? "",
      summary: document.querySelector("[data-month-summary]")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      weekdays: all("[data-month-grid] .grid-cols-7 > div")
        .slice(0, 7).map((d) => d.textContent.trim()).filter(Boolean),
      dayCells: all("[data-day-cell]").length,
      miniDays: all("[data-mini-day]").length,
      outsideMonth: all("[data-outside-month]").length,
      todayMarkers: all('[data-today="true"]').length,
      rowCount: rows.length,
      rowText: rows.map((r) => r.innerText.replace(/\s+/g, " ").trim()),
      rowHeights: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
      firstHref: rows[0]?.getAttribute("href") ?? null,
      moreButtons: all("[data-more-on]").map((b) => ({
        date: b.getAttribute("data-more-on"), label: b.textContent.trim(),
      })),
      largeBadges: all("[data-large-job]").length,
      addButtons: all("[data-add-on]").length,
      actionButtons: [...document.querySelectorAll("a")]
        .filter((a) => /^(Directions|Call|WhatsApp)$/.test(a.textContent.trim())).length,
      layout: all("[data-day-cell]").length ? "month-grid"
            : all("[data-mini-day]").length ? "mini-grid+agenda" : "none",
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
      flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  // =========================================================================
  // 1. The month itself
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    const m = await read(page);

    rec.check({
      id: "DB-01 defaults to the current month", actor: "KC", setup: "no ?month",
      action: "read the month heading",
      expected: monthLabelOf(today),
      actual: m.monthLabel || "(none)", ok: m.monthLabel === monthLabelOf(today),
    });

    rec.check({
      id: "DB-02 a full Sunday-first grid", actor: "KC", setup: "1440px",
      action: "count day cells and read the weekday header",
      expected: "42 cells, SUN…SAT",
      actual: `${m.dayCells} cells, ${m.weekdays.join(" ")}`,
      ok: m.dayCells === 42
          && m.weekdays.join(",") === "SUN,MON,TUE,WED,THU,FRI,SAT",
    });

    rec.check({
      id: "DB-03 today is marked, exactly once in the visible layout", actor: "KC", setup: "-",
      action: "count today markers",
      expected: "1",
      actual: `${m.todayMarkers}`, ok: m.todayMarkers === 1,
    });

    rec.check({
      id: "DB-04 adjacent-month days are shown, de-emphasised", actor: "KC", setup: "-",
      action: "count cells flagged as outside the active month",
      expected: "between 1 and 13 of the 42",
      actual: `${m.outsideMonth}`,
      ok: m.outsideMonth >= 1 && m.outsideMonth <= 13,
    });

    rec.check({
      id: "DB-05 empty days say nothing about availability (CRITICAL)", actor: "KC",
      setup: "hidden work and physical conflicts are invisible here by design",
      action: "look for Free / Available / No appointments in the grid",
      expected: "none of them",
      actual: (() => {
        const bad = ["Free", "Available", "No appointments"].filter((w) =>
          new RegExp(`\\b${w}\\b`).test(m.text));
        return bad.length ? `FOUND: ${bad.join(", ")}` : "none";
      })(),
      ok: !/\bFree\b|\bAvailable\b|No appointments/.test(m.text),
      security: true,
    });

    // ---- navigation ----
    const prev = monthKeyShift(today, -1);
    const next = monthKeyShift(today, 1);

    await page.click("[data-month-prev]");
    await page.waitForURL((u) => u.searchParams.get("month") === prev, { timeout: 20_000 }).catch(() => {});
    await settle(page);
    const onPrev = await read(page);
    rec.check({
      id: "DB-06 previous month", actor: "KC", setup: "-",
      action: "click ←",
      expected: monthLabelOf(`${prev}-01`),
      actual: onPrev.monthLabel, ok: onPrev.monthLabel === monthLabelOf(`${prev}-01`),
    });
    rec.check({
      id: "DB-07 an off-month has no today marker", actor: "KC", setup: "previous month",
      action: "count today markers",
      expected: "0 — today is not in view",
      actual: `${onPrev.todayMarkers}`, ok: onPrev.todayMarkers === 0,
    });

    await page.goto(`${BASE}/dashboard?month=${next}`, { waitUntil: "load" });
    await settle(page);
    const onNext = await read(page);
    rec.check({
      id: "DB-08 next month", actor: "KC", setup: "-",
      action: "load ?month=next",
      expected: monthLabelOf(`${next}-01`),
      actual: onNext.monthLabel, ok: onNext.monthLabel === monthLabelOf(`${next}-01`),
    });

    await page.click("[data-month-today]");
    await page.waitForURL((u) => u.searchParams.get("month") === thisMonth, { timeout: 20_000 }).catch(() => {});
    await settle(page);
    const backHome = await read(page);
    rec.check({
      id: "DB-09 Today returns to the current month", actor: "KC", setup: "was on next month",
      action: "click Today",
      expected: `${monthLabelOf(today)}, today marked`,
      actual: `${backHome.monthLabel}, markers=${backHome.todayMarkers}`,
      ok: backHome.monthLabel === monthLabelOf(today) && backHome.todayMarkers === 1,
    });

    await ctx.close();
  }

  // =========================================================================
  // 2. Appointment entries
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    const m = await read(page);

    rec.check({
      id: "DB-10 an entry carries time, customer, staff and amount", actor: "KC", setup: "-",
      action: "read the large-job entry",
      expected: "all four",
      actual: m.rowText.find((t) => t.includes("TEST CUSTOMER DASH LARGE")) ?? "(entry not found)",
      ok: (() => {
        const row = m.rowText.find((t) => t.includes("TEST CUSTOMER DASH LARGE")) ?? "";
        return ["10:00", "TEST CUSTOMER DASH LARGE", "TEST_JACK", "RM700"].every((f) => row.includes(f));
      })(),
    });

    rec.check({
      id: "DB-11 entries are calendar entries, not cards", actor: "KC", setup: "1440px",
      action: "measure entry heights",
      expected: "none taller than 48px",
      actual: m.rowHeights.length ? `${Math.max(...m.rowHeights)}px tallest` : "no entries",
      ok: m.rowHeights.length > 0 && Math.max(...m.rowHeights) <= 48,
    });

    rec.check({
      id: "DB-12 no per-appointment action buttons", actor: "KC",
      setup: "those belong on the appointment itself",
      action: "count Directions / Call / WhatsApp links",
      expected: "0", actual: `${m.actionButtons}`, ok: m.actionButtons === 0,
    });

    rec.check({
      id: "DB-13 address, phone and remarks are not in the month payload", actor: "KC",
      setup: "a cell shows time, customer, staff, amount — nothing else",
      action: "scan the HTML and the RSC payload for the seeded address, phone and remark tag",
      expected: "absent from both",
      actual: (() => {
        const hay = `${m.html}\n${m.flight}`;
        const found = [
          ["address", "88 Jalan Very Long Address"],
          ["phone", "+60123456789"],
          ["remarks", fx.TAG],
        ].filter(([, n]) => hay.includes(n)).map(([l]) => l);
        return found.length ? `LEAKED: ${found.join(", ")}` : "absent";
      })(),
      ok: !`${m.html}\n${m.flight}`.includes("88 Jalan Very Long Address")
          && !`${m.html}\n${m.flight}`.includes("+60123456789")
          && !`${m.html}\n${m.flight}`.includes(fx.TAG),
    });

    rec.check({
      id: "DB-14 an entry links to the appointment detail", actor: "KC", setup: "-",
      action: "read an entry's href",
      expected: "/appointments/<uuid>",
      actual: m.firstHref ?? "(none)",
      ok: !!m.firstHref && /^\/appointments\/[0-9a-f-]{36}$/i.test(m.firstHref),
    });

    rec.check({
      id: "DB-15 the large job is badged", actor: "KC", setup: "RM700, over the threshold",
      action: "count LARGE badges",
      expected: "at least 1",
      actual: `${m.largeBadges}`, ok: m.largeBadges >= 1,
    });

    // ---- high density ----
    const more = m.moreButtons.find((b) => b.date === denseDate);
    rec.check({
      id: "DB-16 a busy day collapses instead of growing", actor: "KC",
      setup: `4 appointments on ${denseDate}`,
      action: "look for the overflow control on that cell",
      expected: '"+1 more"',
      actual: more ? more.label : "(no overflow control)",
      ok: !!more && /^\+\d+ more$/.test(more.label),
    });

    if (more) {
      const beforeCount = await page.evaluate((d) =>
        document.querySelectorAll(`[data-day-cell="${d}"] [data-appointment-row]`).length, denseDate);
      await page.click(`[data-more-on="${denseDate}"]`);
      await page.waitForTimeout(300);
      const after = await page.evaluate((d) => ({
        popover: !!document.querySelector(`[data-day-popover="${d}"]`),
        rows: document.querySelectorAll(`[data-day-popover="${d}"] [data-appointment-row]`).length,
      }), denseDate);
      rec.check({
        id: "DB-17 +N more reveals the whole day", actor: "KC", setup: `${beforeCount} shown in the cell`,
        action: "click the overflow control",
        expected: "a day panel listing all 4",
        actual: `popover=${after.popover} rows=${after.rows}`,
        ok: after.popover && after.rows === 4,
      });

      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      const closed = await page.evaluate((d) =>
        !document.querySelector(`[data-day-popover="${d}"]`), denseDate);
      rec.check({
        id: "DB-18 the day panel closes on Escape", actor: "KC", setup: "panel open",
        action: "press Escape",
        expected: "closed", actual: closed ? "closed" : "still open", ok: closed,
      });
    } else {
      rec.skip({ id: "DB-17 +N more reveals the whole day", actor: "KC", reason: "no overflow control to click" });
      rec.skip({ id: "DB-18 the day panel closes on Escape", actor: "KC", reason: "depends on DB-17" });
    }

    rec.check({
      id: "DB-19 the dashboard is not the calendar", actor: "KC",
      setup: "/calendar is the staff x day scheduling matrix",
      action: "look for a staff-column matrix on the dashboard",
      expected: "absent — different question, different surface",
      actual: /TEST_JACK\s*\n\s*TEST_DYRON/.test(m.text) ? "matrix present" : "absent",
      ok: !/TEST_JACK\s*\n\s*TEST_DYRON/.test(m.text),
    });

    await ctx.close();
  }

  // =========================================================================
  // 3. Scope — heading, selector and cells move together
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
        id: `DB-20 ${label}: heading and selector agree (CRITICAL)`, actor: "KC", setup: label,
        action: "compare the page heading against the nav selector",
        expected: `both say "${expectLabel}"`,
        actual: `heading="${m.heading}" selector="${m.selector}"`,
        ok: m.heading.startsWith(expectLabel) && m.selector === expectLabel,
      });

      const hasPrivate = m.text.includes(SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name);
      const hasShared = m.text.includes("TEST CUSTOMER DASH LARGE");
      rec.check({
        id: `DB-21 ${label}: the grid follows the same scope`, actor: "KC", setup: label,
        action: "check which seeded appointments appear in the month",
        expected: `private=${expectPrivate} shared=${expectShared}`,
        actual: `private=${hasPrivate} shared=${hasShared}`,
        ok: hasPrivate === expectPrivate && hasShared === expectShared,
      });
    }

    // Month navigation must not silently widen the scope.
    await page.goto(`${BASE}/dashboard?ws=${ids.ws.shared}`, { waitUntil: "load" });
    await settle(page);
    await page.click("[data-month-next]");
    await page.waitForTimeout(2000);
    const afterNav = await read(page);
    rec.check({
      id: "DB-22 month navigation preserves the scope (CRITICAL)", actor: "KC",
      setup: "Shared Team selected",
      action: "click → and read the heading, selector and URL",
      expected: "still Shared Team",
      actual: `heading="${afterNav.heading}" selector="${afterNav.selector}" url=${new URL(page.url()).search}`,
      ok: afterNav.heading.startsWith("Shared Team")
          && afterNav.selector === "Shared Team"
          && page.url().includes(ids.ws.shared),
      security: true,
    });

    // Switching scope through the SELECTOR must move everything together.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    await page.selectOption("[data-scope-selector]", { label: "Shared Team" });
    await page.waitForTimeout(2500);
    const afterSwitch = await read(page);
    rec.check({
      id: "DB-23 switching scope updates heading, selector and grid together (CRITICAL)",
      actor: "KC", setup: "started on All Operations",
      action: "choose Shared Team in the selector",
      expected: "heading and selector say Shared Team, and the private job disappears",
      actual: `heading="${afterSwitch.heading}" selector="${afterSwitch.selector}" `
            + `private=${afterSwitch.text.includes(SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name)}`,
      ok: afterSwitch.heading.startsWith("Shared Team")
          && afterSwitch.selector === "Shared Team"
          && !afterSwitch.text.includes(SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name),
    });

    await page.click('nav a:has-text("Calendar")');
    await page.waitForTimeout(2500);
    const onCalendar = await page.evaluate(() => ({
      url: location.search,
      selector: (() => {
        const s = document.querySelector("[data-scope-selector]");
        return s ? s.options[s.selectedIndex].textContent.trim() : null;
      })(),
    }));
    rec.check({
      id: "DB-24 the chosen scope survives navigation", actor: "KC", setup: "Shared Team selected",
      action: "click Calendar in the nav",
      expected: "still Shared Team, in the URL and the selector",
      actual: `url="${onCalendar.url}" selector="${onCalendar.selector}"`,
      ok: onCalendar.url.includes(ids.ws.shared) && onCalendar.selector === "Shared Team",
    });
    await ctx.close();
  }

  // =========================================================================
  // 4. Month aggregates — computed from visible rows, never a shared total
  // =========================================================================
  let kcSummary = "";
  {
    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    const m = await read(page);
    kcSummary = m.summary;

    const expected = (await fx.query(
      `select count(*)::int n, coalesce(sum(total_amount), 0)::numeric amt,
              count(*) filter (where is_large_job)::int big
         from public.appointments
        where status <> 'cancelled'
          and to_char(appt_date, 'YYYY-MM') = $1`, [thisMonth]))[0];

    rec.check({
      id: "DB-25 the summary counts the MONTH, not the 42-day grid", actor: "KC", setup: "-",
      action: "compare the summary against every appointment dated in this month",
      expected: `${expected.n} appointments, ${expected.big} large`,
      actual: m.summary || "(none)",
      ok: m.summary.startsWith(`${expected.n} appointment`)
          && (expected.big === 0
              ? !/large job/.test(m.summary)
              : m.summary.includes(`${expected.big} large job`)),
    });
    await ctx.close();
  }

  // =========================================================================
  // 5. Nick — one workspace, nothing private anywhere
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    const m = await read(page);

    rec.check({
      id: "DB-26 Nick sees no scope selector", actor: "NICK", setup: "one visible workspace",
      action: "look for the selector",
      expected: "absent — a selector would imply another workspace exists",
      actual: m.selector === null ? "absent" : `PRESENT (${m.selector})`,
      ok: m.selector === null, security: true,
    });

    rec.check({
      id: "DB-27 Nick's heading names his own workspace", actor: "NICK", setup: "-",
      action: "read the heading",
      expected: "Shared Team",
      actual: m.heading, ok: m.heading.startsWith("Shared Team"),
    });

    for (const [label, hay] of [
      ["visible text", m.text], ["HTML", m.html], ["RSC payload", m.flight],
    ]) {
      const found = KC_ONLY.filter(([, needle]) => hay.includes(needle)).map(([l]) => l);
      rec.check({
        id: `DB-28 month ${label} clean (CRITICAL)`, actor: "NICK",
        setup: "a private appointment exists this month",
        action: `scan the ${label}`,
        expected: "0 traces",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }

    rec.check({
      id: "DB-29 a hidden appointment leaves no placeholder (CRITICAL)", actor: "NICK",
      setup: `a private job exists on ${privateDate}`,
      action: "read that cell and look for a blocker, a time, or explanatory text",
      expected: "the cell is simply empty",
      actual: await page.evaluate((d) => {
        const cell = document.querySelector(`[data-day-cell="${d}"]`);
        if (!cell) return "(cell not rendered)";
        return `entries=${cell.querySelectorAll("[data-appointment-row]").length} ` +
               `text="${cell.innerText.replace(/\s+/g, " ").trim()}"`;
      }, privateDate),
      ok: await page.evaluate((d) => {
        const cell = document.querySelector(`[data-day-cell="${d}"]`);
        if (!cell) return false;
        const text = cell.innerText.replace(/\s+/g, " ").trim();
        return cell.querySelectorAll("[data-appointment-row]").length === 0
          && !/private|busy|unavailable|booked|blocked|15:00/i.test(text);
      }, privateDate),
      security: true,
    });

    rec.check({
      id: "DB-30 Nick's month totals are his own (CRITICAL)", actor: "NICK",
      setup: "KC can see a private job this month that Nick cannot",
      action: "compare the two summaries",
      expected: "different, and Nick's matches only what he can see",
      actual: `KC="${kcSummary}" NICK="${m.summary}"`,
      ok: (() => {
        const n = (s) => Number((/^(\d+)/.exec(s) ?? [])[1] ?? -1);
        const visible = m.rowText.length;
        return m.summary !== kcSummary && n(m.summary) >= 0 && n(m.summary) < n(kcSummary)
          && visible <= n(m.summary);
      })(),
      security: true,
    });

    await page.goto(`${BASE}/dashboard?ws=${ids.ws.private}`, { waitUntil: "load" });
    await settle(page);
    const forged = await read(page);
    rec.check({
      id: "DB-31 a forged private scope does not reach the heading (CRITICAL)", actor: "NICK",
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
  // 6. Responsive — the layout is chosen by geometry, not by hope
  // =========================================================================
  for (const [width, expectLayout] of [
    [390, "mini-grid+agenda"],
    [768, "mini-grid+agenda"],
    [850, "mini-grid+agenda"],
    [1024, "month-grid"],
    [1440, "month-grid"],
  ]) {
    const { page, ctx } = await session(ids.email.kc, { width, height: 900 });
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);
    const m = await read(page);

    rec.check({
      id: `DB-32 ${width}px no horizontal overflow`, actor: "KC", setup: `${width}px`,
      action: "measure horizontal overflow",
      expected: "none",
      actual: m.overflow > 0 ? `${m.overflow}px` : "none", ok: m.overflow <= 0,
    });

    rec.check({
      id: `DB-33 ${width}px uses the right layout`, actor: "KC", setup: `${width}px`,
      action: "see which layout is visible",
      expected: expectLayout,
      actual: m.layout, ok: m.layout === expectLayout,
    });

    if (expectLayout === "mini-grid+agenda") {
      rec.check({
        id: `DB-34 ${width}px the mini grid is a whole month`, actor: "KC", setup: `${width}px`,
        action: "count mini date buttons",
        expected: "42",
        actual: `${m.miniDays}`, ok: m.miniDays === 42,
      });

      // Tapping a date must load that date's appointments, without a round trip.
      const beforeAgenda = await page.evaluate(() =>
        document.querySelector("[data-day-agenda]")?.getAttribute("data-day-agenda"));
      await page.click(`[data-mini-day="${denseDate}"]`);
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => {
        const a = document.querySelector("[data-day-agenda]");
        return { date: a?.getAttribute("data-day-agenda"), rows: a?.querySelectorAll("[data-appointment-row]").length ?? 0 };
      });
      rec.check({
        id: `DB-35 ${width}px tapping a date loads that day`, actor: "KC",
        setup: `was showing ${beforeAgenda}`,
        action: `tap ${denseDate}`,
        expected: `${denseDate}, all 4 appointments`,
        actual: `${after.date}, ${after.rows} entries`,
        ok: after.date === denseDate && after.rows === 4,
      });
    } else {
      rec.check({
        id: `DB-36 ${width}px the grid fits without clipping an entry`, actor: "KC", setup: `${width}px`,
        action: "measure the narrowest visible cell against its entries",
        expected: "every entry fits inside its cell",
        actual: await page.evaluate(() => {
          const bad = [...document.querySelectorAll("[data-day-cell]")].filter((c) =>
            [...c.querySelectorAll("[data-appointment-row]")].some((r) =>
              r.getBoundingClientRect().right > c.getBoundingClientRect().right + 1));
          return bad.length ? `${bad.length} cell(s) clipped` : "none clipped";
        }),
        ok: await page.evaluate(() =>
          ![...document.querySelectorAll("[data-day-cell]")].some((c) =>
            [...c.querySelectorAll("[data-appointment-row]")].some((r) =>
              r.getBoundingClientRect().right > c.getBoundingClientRect().right + 1))),
      });
    }
    await ctx.close();
  }

  // =========================================================================
  // 7. Quick Add opens on the date you clicked
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await settle(page);

    // A date cell's + hands the date to the ONE Quick Add sheet in the shell,
    // rather than mounting a second booking form.
    await page.click(`[data-add-on="${largeDate}"]`, { force: true });
    await page.waitForSelector("text=Enter manually instead", { timeout: 20_000 });
    await page.click("text=Enter manually instead");
    await page.waitForSelector("#qa-date", { timeout: 20_000 });
    const prefilled = await page.evaluate(() => document.querySelector("#qa-date")?.value ?? "");

    rec.check({
      id: "DB-37 a date cell pre-fills Quick Add with that date (CRITICAL)", actor: "KC",
      setup: `clicked + on ${largeDate}`,
      action: "open Quick Add from the cell and read the date field",
      expected: largeDate,
      actual: prefilled || "(empty)", ok: prefilled === largeDate,
    });

    rec.check({
      id: "DB-38 it is the existing Quick Add, not a second form", actor: "KC", setup: "-",
      action: "look for Quick Add's own paste step and item editor",
      expected: "present",
      actual: await page.evaluate(() =>
        `items=${!!document.querySelector("#qa-date")?.form?.querySelector("input,select,textarea")}`),
      ok: await page.evaluate(() => !!document.querySelector("#qa-date")),
    });

    await ctx.close();
  }
} catch (e) {
  // An exception that escapes the body must not vanish into a green summary.
  // Recorded here, so cleanup still runs and the verdict still prints — but the
  // run is no longer a pass. See tests/unit/harness-accounting.test.mjs.
  rec.aborted(e);
} finally {
  if (browser) await browser.close();
  // Take ownership of rows that APPEARED while this suite ran, then delete by
  // exact id. A manual booking matching the same pattern existed at baseline
  // and is therefore never adopted, never touched.
  const adopted = await fx.adoptNew();
  const removed = await fx.cleanup();
  console.log(`fixture cleanup: ${removed.appointments} appointment(s) owned by this run `
    + `(${adopted} adopted from the UI), manual rows untouched`);
  await db.end();
  // Summary LAST, and it owns the exit code: a failed check, an escaped
  // exception, or fewer checks than planned each make this non-zero.
  rec.finish();
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
