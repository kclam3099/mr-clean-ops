// Responsive / UX quality checks.
//
// Measures the rendered layout at three widths instead of eyeballing
// screenshots: horizontal overflow, tap-target size on mobile, dialog
// semantics, and that empty states actually say something.
//
// These are the defects that are cheap to introduce and easy to miss — a wide
// <select>, a table, or a long customer name silently pushing the page into
// horizontal scroll on a phone.
//
// Run: npm run test:e2e:qa

import { chromium } from "playwright";
import {
  adminClient, assertDevProject, resolveIdentities, createFixture,
  createRecorder, CONFIG, signIn, rpc, bookingArgs,
} from "../../supabase/tests/lib/harness.mjs";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const PASSWORD = CONFIG.testPassword();

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

assertDevProject();
const db = await adminClient();
const ids = await resolveIdentities(db);
const fx = createFixture(db);
const rec = createRecorder("RESPONSIVE / UX QA (browser)");

let browser;
try {
  await assertAppIsUp();
  browser = await chromium.launch();

  // A long customer name and address are the realistic stress case for
  // truncation and overflow.
  //
  // The date is chosen from Jack's own working hours on a day he has nothing
  // booked, so this fixture cannot collide with existing DEV data — a booking
  // that quietly failed would silently skip the detail-page checks below.
  // Effective hours resolve staff row first, company default second — the same
  // order the engine uses, so this picks a day the booking will actually pass.
  const [workDay] = await fx.query(
    `select d.dow as day_of_week
       from generate_series(0, 6) as d(dow)
       cross join lateral (
         select w.start_time, w.end_time
           from public.staff_working_hours w
          where w.day_of_week = d.dow
            and (w.staff_id = $1 or w.staff_id is null)
          order by (w.staff_id is null)      -- the staff's own row wins
          limit 1
       ) h
      where h.start_time <= '10:00' and h.end_time >= '13:00'
      order by d.dow limit 1`, [ids.staff.jack]);
  // With no hours configured at all the engine imposes no window, so any day
  // is bookable; only insist on a matching weekday when hours actually exist.
  const [configured] = await fx.query(
    `select count(*)::int n from public.staff_working_hours
      where staff_id = $1 or staff_id is null`, [ids.staff.jack]);
  if (configured.n > 0 && !workDay) {
    throw new Error("TEST_JACK has working hours configured but none covering 10:00-13:00");
  }
  const apptDate = await fx.freeDate(ids.staff.jack,
    { dayOfWeek: workDay ? workDay.day_of_week : null });

  const kcToken = await signIn(ids.email.kc);
  const LONG_NAME = "TEST CUSTOMER QA Abdul Rahman bin Mohamed Zainal Abidin";
  const made = await rpc("create_appointment", kcToken, bookingArgs({
    ws: ids.ws.shared, staff: ids.staff.jack, date: apptDate, time: "10:00", amount: 200,
    remarks: fx.TAG,
    customer: {
      p_customer_name: LONG_NAME, p_customer_phone: "+60123456789",
      p_address_line: "Lot 12345, Jalan Persiaran Dato Menteri Seksyen 7 Bandar Baru",
      p_area_city: "Kepong Baru",
    },
  }));
  if (!made.ok) throw new Error(`QA fixture booking failed: ${JSON.stringify(made.body)}`);
  const apptId = fx.track(made.body);

  const MASTER_ROUTES = [
    ["/dashboard", "Master dashboard"],
    ["/calendar", "Master calendar"],
    ["/appointments", "Master appointments"],
    ["/appointments/new", "Add appointment"],
    ...(apptId ? [[`/appointments/${apptId}`, "Appointment detail"]] : []),
  ];
  const STAFF_ROUTES = [
    ["/my/today", "Staff today"],
    ["/my/tomorrow", "Staff tomorrow"],
    ["/my/month", "Staff month"],
    ["/my/appointments/new", "Staff add appointment"],
  ];

  for (const vp of VIEWPORTS) {
    for (const [email, routes, who] of [
      [ids.email.kc, MASTER_ROUTES, "KC"],
      [ids.email.jack, STAFF_ROUTES, "JACK"],
    ]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      await login(page, email);

      for (const [path, label] of routes) {
        const nav = await gotoStable(page, `${BASE}${path}`);
        if (!nav.ok) {
          // Record it rather than throwing: a crash here would abandon every
          // remaining check and the run would look shorter, not failed.
          rec.check({
            id: `QA-${vp.name} ${label}: navigation`, actor: who, setup: `${vp.width}px viewport`,
            action: `load ${path} (2 attempts)`,
            expected: "the page loads",
            actual: nav.error, ok: false,
          });
          continue;
        }
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 20_000 })
          .catch(() => {});
        await page.waitForTimeout(500);

        const m = await page.evaluate(() => {
          const doc = document.documentElement;
          const overflow = doc.scrollWidth - doc.clientWidth;
          // Which elements actually stick out past the viewport?
          const culprits = [...document.querySelectorAll("body *")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.right > doc.clientWidth + 1;
            })
            .slice(0, 3)
            .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || "?"}`);
          // Interactive controls that are too small to tap reliably.
          const small = [...document.querySelectorAll("button, a[href], select, input")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.height < 32;
            })
            .slice(0, 6)
            .map((el) => `${el.tagName.toLowerCase()}:"${(el.textContent || el.getAttribute("name") || "").trim().slice(0, 18)}"`);
          return {
            overflow, culprits, small,
            bodyText: (document.body.innerText || "").trim().length,
          };
        });

        rec.check({
          id: `QA-${vp.name} ${label}: no horizontal overflow`, actor: who,
          setup: `${vp.width}px viewport`,
          action: `load ${path}`,
          expected: "the page never scrolls sideways",
          actual: m.overflow > 0 ? `${m.overflow}px overflow from ${m.culprits.join(", ")}` : "none",
          ok: m.overflow <= 0,
        });

        rec.check({
          id: `QA-${vp.name} ${label}: page rendered`, actor: who, setup: "-",
          action: "check there is content",
          expected: "more than a skeleton",
          actual: `${m.bodyText} chars`, ok: m.bodyText > 80,
        });

        if (vp.name === "mobile") {
          rec.check({
            id: `QA-mobile ${label}: tap targets`, actor: who,
            setup: "390px viewport",
            action: "measure interactive control heights",
            expected: "every control at least 32px tall",
            actual: m.small.length ? `too small: ${m.small.join(", ")}` : "all adequate",
            ok: m.small.length === 0,
          });
        }
      }
      await ctx.close();
    }
  }

  // ---- dialogs ----
  if (apptId) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await login(page, ids.email.kc);
    await gotoStable(page, `${BASE}/appointments/${apptId}`);
    await page.waitForTimeout(1200);
    await page.click("text=Cancel appointment");
    await page.waitForSelector('[role="dialog"]');
    const dialog = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const r = d.getBoundingClientRect();
      return {
        modal: d.getAttribute("aria-modal"),
        labelled: !!d.getAttribute("aria-labelledby"),
        withinViewport: r.right <= document.documentElement.clientWidth + 1 && r.left >= -1,
        buttons: [...d.querySelectorAll("button")].map((b) => b.textContent.trim()),
      };
    });
    rec.check({
      id: "QA-dialog semantics and fit", actor: "KC", setup: "390px viewport",
      action: "open the cancel confirmation",
      expected: "aria-modal, labelled, fits the viewport, offers a way out",
      actual: `modal=${dialog.modal} labelled=${dialog.labelled} fits=${dialog.withinViewport} buttons=${dialog.buttons.join(" | ")}`,
      ok: dialog.modal === "true" && dialog.labelled && dialog.withinViewport
          && dialog.buttons.length >= 2,
    });
    await ctx.close();
  }

  // ---- empty states ----
  // Pick a staff member who genuinely has nothing today rather than assuming
  // it, so a PASS here means the empty state really rendered.
  {
    const [idle] = await fx.query(
      `select s.id, p.full_name
         from public.staff s join public.profiles p on p.id = s.profile_id
        where p.full_name like 'TEST_%'
          and not exists (
            select 1 from public.appointments a
             where a.staff_id = s.id and a.status = 'booked'
               and a.appt_date = (now() at time zone 'Asia/Kuala_Lumpur')::date)
        order by p.full_name limit 1`);
    if (!idle) throw new Error("every TEST_ staff has an appointment today; cannot check the empty state");
    const idleEmail = `${idle.full_name.toLowerCase().replace("_", "-")}@mrcleanclean.dev.test`;

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await login(page, idleEmail);
    await page.goto(`${BASE}/my/today`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => document.body.innerText);
    rec.check({
      id: "QA-empty state says something useful", actor: idle.full_name,
      setup: "no appointments today",
      action: "read the page",
      expected: "an explanatory empty state, not a blank area",
      actual: /nothing scheduled/i.test(text) ? "present" : text.slice(0, 80),
      ok: /nothing scheduled/i.test(text),
    });
    await ctx.close();
  }

  // =========================================================================
  // Dashboard card consistency
  // =========================================================================
  // Today and Tomorrow used to reach their cards by different routes — Today
  // through a grid of per-staff columns, Tomorrow through a single stacked list
  // — so one appointment rendered at a third of the width and the other at full
  // width. They now share one grid, and a card is a card wherever it sits.
  {
    const today = (await fx.query(
      `select to_char((now() at time zone 'Asia/Kuala_Lumpur')::date,'YYYY-MM-DD') d`))[0].d;
    const tomorrow = (await fx.query(
      `select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + 1),'YYYY-MM-DD') d`))[0].d;

    // Today's job is recorded as history if the hour has already passed, which
    // is exactly what 0010 makes possible.
    const todayJob = await rpc("create_appointment", kcToken, {
      ...bookingArgs({ ws: ids.ws.shared, staff: ids.staff.dyron, date: today, time: "10:00",
        amount: 200, remarks: fx.TAG,
        customer: { p_customer_name: "TEST CUSTOMER QA TODAY", p_customer_phone: "+60123456789",
          p_address_line: "1 Jalan Test", p_area_city: "Kepong" } }),
      p_confirm_past: true,
    });
    if (todayJob.ok) fx.track(todayJob.body);
    const tomorrowJob = await rpc("create_appointment", kcToken, bookingArgs({
      ws: ids.ws.shared, staff: ids.staff.dyron, date: tomorrow, time: "13:00", amount: 200,
      remarks: fx.TAG,
      customer: { p_customer_name: "TEST CUSTOMER QA TOMORROW", p_customer_phone: "+60123456789",
        p_address_line: "2 Jalan Test", p_area_city: "Kepong" } }));
    if (tomorrowJob.ok) fx.track(tomorrowJob.body);

    rec.check({
      id: "DASHQA-00 one Today and one Tomorrow appointment exist", actor: "KC", setup: "-",
      action: "seed the two cards to compare",
      expected: "both created",
      actual: `today=${todayJob.ok ? "ok" : todayJob.msg} tomorrow=${tomorrowJob.ok ? "ok" : tomorrowJob.msg}`,
      ok: todayJob.ok && tomorrowJob.ok,
    });

    if (todayJob.ok && tomorrowJob.ok) {
      for (const width of [390, 768, 850, 1440]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await ctx.newPage();
        await login(page, ids.email.kc);
        await gotoStable(page, `${BASE}/dashboard`);
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 20_000 })
          .catch(() => {});
        await page.waitForTimeout(700);

        const m = await page.evaluate(() => {
          const cardOf = (name) => {
            const card = [...document.querySelectorAll("article")]
              .find((a) => a.innerText.includes(name));
            return card ? Math.round(card.getBoundingClientRect().width) : null;
          };
          const doc = document.documentElement;
          return {
            todayW: cardOf("TEST CUSTOMER QA TODAY"),
            tomorrowW: cardOf("TEST CUSTOMER QA TOMORROW"),
            overflow: doc.scrollWidth - doc.clientWidth,
          };
        });

        rec.check({
          id: `DASHQA-01 ${width}px Today and Tomorrow cards match`, actor: "KC",
          setup: `${width}px viewport`,
          action: "measure both appointment cards",
          expected: "identical widths",
          actual: `today=${m.todayW} tomorrow=${m.tomorrowW}`,
          ok: m.todayW !== null && m.todayW === m.tomorrowW,
        });

        rec.check({
          id: `DASHQA-02 ${width}px dashboard does not scroll sideways`, actor: "KC",
          setup: `${width}px viewport`, action: "measure horizontal overflow",
          expected: "none",
          actual: m.overflow > 0 ? `${m.overflow}px` : "none", ok: m.overflow <= 0,
        });
        await ctx.close();
      }
    }
  }

} finally {
  const summary = rec.summary();
  if (browser) await browser.close();
  await db.query(`delete from public.appointment_items where appointment_id in
    (select id from public.appointments where remarks = $1)`, [fx.TAG]);
  await db.query(`delete from public.audit_logs where entity_id in
    (select id from public.appointments where remarks = $1)`, [fx.TAG]);
  await db.query(`delete from public.appointments where remarks = $1`, [fx.TAG]);
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

/**
 * `next dev` compiles routes on demand, and a route being compiled for the
 * first time while a prefetch is already in flight can abort the navigation.
 * That is a dev-server artefact, not a product defect, so retry once — but
 * report a second failure rather than swallowing it.
 */
async function gotoStable(page, url) {
  let last = "";
  for (const attempt of [1, 2]) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      return { ok: true };
    } catch (e) {
      last = e.message.split("\n")[0];
      if (attempt === 1) await page.waitForTimeout(1500);
    }
  }
  return { ok: false, error: last };
}

async function login(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
}
