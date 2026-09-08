// Quick Add — behaviour and privacy.
//
// The property that matters most here is negative: from Nick's browser, Victor
// must not exist. Not hidden, not disabled, not counted — absent. So the checks
// below scan the visible text, the full HTML, the RSC flight payload AND the
// Server Action response body, and compare a forged Victor uuid against a
// random one.
//
// Run: npm run test:e2e:quickadd

import { chromium } from "playwright";
import {
  adminClient, assertDevProject, resolveIdentities, createFixture,
  createRecorder, CONFIG, signIn, rpc, bookingArgs,
} from "../../supabase/tests/lib/harness.mjs";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const PASSWORD = CONFIG.testPassword();
const RANDOM_UUID = "3f2b7c58-0000-4000-8000-1234567890ab";

assertDevProject();
const db = await adminClient();
const ids = await resolveIdentities(db);
const fx = createFixture(db);
const rec = createRecorder("F5 QUICK ADD (browser)");

/** Strings that must never reach Nick, by any surface. */
const KC_ONLY = [
  ["Victor name", "TEST_VICTOR"],
  ["Victor staff id", ids.staff.victor],
  ["Victor profile id", ids.profile.victor],
  ["private workspace id", ids.ws.private],
  ["private workspace name", "KC Private Team"],
];

let browser;
try {
  await assertAppIsUp();
  browser = await chromium.launch();

  const day = async (n) => (await fx.query(
    `select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int),'YYYY-MM-DD') d`, [n]))[0].d;

  async function session(email, viewport = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "load" });
    await page.fill("input[name=email]", email);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
    return { ctx, page };
  }

  const openSheet = async (page) => {
    await page.click('button[aria-label="New appointment"]');
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(700);
  };

  async function fillDetails(page, { name, date, time, price = "200" }) {
    await page.fill("#qa-name", name);
    await page.fill("#qa-phone", "+60123456789");
    await page.fill("#qa-address", "1 TEST ROAD");
    await page.fill("#qa-area", "TEST CITY");
    await page.fill("input[name='items.0.description']", "TEST SERVICE");
    await page.fill("input[name='items.0.unitPrice']", price);
    await page.fill("#qa-date", date);
    await page.fill("#qa-time", time);
    await page.waitForTimeout(250);
  }

  const staffOptions = (page) => page.evaluate(() =>
    [...document.querySelectorAll("[data-staff-option]")].map((b) => b.textContent.replace(/Assign$/, "").trim()));

  const pickStaff = async (page, label) => {
    await page.evaluate((l) => {
      const b = [...document.querySelectorAll("[data-staff-option]")]
        .find((x) => x.textContent.includes(l));
      b?.click();
    }, label);
    await page.waitForTimeout(3000);
  };

  const rowFor = async (name) => (await fx.query(
    `select a.id, s.display_name staff, w.name ws, a.appt_date::text d, a.start_time::text t
       from public.appointments a
       left join public.staff s on s.id = a.staff_id
       left join public.workspaces w on w.id = a.workspace_id
      where a.customer_name = $1`, [name]))[0] ?? null;

  const track = async (name) => {
    const r = await rowFor(name);
    if (r) fx.track(r.id);
    return r;
  };

  // =========================================================================
  // 1. KC — sees all three, and the workspace is derived per staff member
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/calendar`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await openSheet(page);
    await fillDetails(page, { name: "TEST CUSTOMER QA1", date: await day(40), time: "10:00" });
    await page.click("text=Assign staff");
    await page.waitForTimeout(600);

    const options = await staffOptions(page);
    rec.check({
      id: "QA-01 KC sees Jack, Dyron and Victor", actor: "KC (super_master)",
      setup: "two workspaces visible",
      action: "read the assignment options",
      expected: "all three authorised staff",
      actual: options.join(", ") || "(none)",
      ok: ["TEST_JACK", "TEST_DYRON", "TEST_VICTOR"].every((n) => options.some((o) => o.includes(n))),
    });

    await pickStaff(page, "TEST_JACK");
    const jackRow = await track("TEST CUSTOMER QA1");
    rec.check({
      id: "QA-02 assigning Jack derives Shared Team", actor: "KC",
      setup: "no workspace was ever chosen in the UI",
      action: "tap Jack",
      expected: "committed, staff = TEST_JACK, workspace = Shared Team",
      actual: jackRow ? `${jackRow.staff} / ${jackRow.ws}` : "NOT CREATED",
      ok: !!jackRow && jackRow.staff === "TEST_JACK" && jackRow.ws === "Shared Team",
    });
    await ctx.close();
  }

  {
    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await openSheet(page);
    await fillDetails(page, { name: "TEST CUSTOMER QA2", date: await day(41), time: "10:00" });
    await page.click("text=Assign staff");
    await page.waitForTimeout(600);
    await pickStaff(page, "TEST_VICTOR");
    const victorRow = await track("TEST CUSTOMER QA2");
    rec.check({
      id: "QA-03 assigning Victor derives KC Private Team", actor: "KC",
      setup: "Victor's only membership is the private workspace",
      action: "tap Victor",
      expected: "committed, staff = TEST_VICTOR, workspace = KC Private Team",
      actual: victorRow ? `${victorRow.staff} / ${victorRow.ws}` : "NOT CREATED",
      ok: !!victorRow && victorRow.staff === "TEST_VICTOR" && victorRow.ws === "KC Private Team",
    });
    await ctx.close();
  }

  // =========================================================================
  // 2. NICK — Victor must not exist, on any surface
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);

    // Capture what the Server Action itself sends back, not only what renders.
    const actionBodies = [];
    page.on("response", async (r) => {
      if (r.request().method() !== "POST") return;
      try { actionBodies.push(await r.text()); } catch { /* body already consumed */ }
    });

    await page.goto(`${BASE}/calendar`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await openSheet(page);
    await fillDetails(page, { name: "TEST CUSTOMER QA3", date: await day(42), time: "10:00" });
    await page.click("text=Assign staff");
    await page.waitForTimeout(800);

    const options = await staffOptions(page);
    rec.check({
      id: "QA-04 Nick sees exactly Jack and Dyron", actor: "NICK (partner_master)",
      setup: "Shared Team is his only workspace",
      action: "read the assignment options",
      expected: "exactly 2 options",
      actual: `${options.length}: ${options.join(", ")}`,
      ok: options.length === 2
          && options.some((o) => o.includes("TEST_JACK"))
          && options.some((o) => o.includes("TEST_DYRON")),
      security: true,
    });

    const surfaces = await page.evaluate(() => ({
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
      flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
    }));

    for (const [label, hay] of [
      ["visible text", surfaces.text],
      ["full HTML", surfaces.html],
      ["RSC flight payload", surfaces.flight],
      ["Server Action response bodies", actionBodies.join("\n")],
    ]) {
      const found = KC_ONLY.filter(([, needle]) => hay.includes(needle)).map(([l]) => l);
      rec.check({
        id: `QA-0${label === "visible text" ? 5 : label === "full HTML" ? 6 : label === "RSC flight payload" ? 7 : 8} ${label} clean (CRITICAL)`,
        actor: "NICK", setup: "assignment step open",
        action: `scan the ${label} for anything KC-only`,
        expected: "0 traces of Victor or the private workspace",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }

    const counts = /(\d+)\s*(staff|team member|hidden|unavailable|total)/i.exec(surfaces.text);
    rec.check({
      id: "QA-11 no staff count is disclosed", actor: "NICK", setup: "-",
      action: "look for '3 staff', '1 hidden', '1 unavailable'",
      expected: "no count of any kind",
      actual: counts ? `FOUND: "${counts[0]}"` : "none",
      ok: counts === null, security: true,
    });

    // Nick's own booking still works — the shorter list is not a broken list.
    await pickStaff(page, "TEST_JACK");
    const nickRow = await track("TEST CUSTOMER QA3");
    rec.check({
      id: "QA-12 Nick can still book his own staff", actor: "NICK", setup: "-",
      action: "tap Jack",
      expected: "committed to Shared Team",
      actual: nickRow ? `${nickRow.staff} / ${nickRow.ws}` : "NOT CREATED",
      ok: !!nickRow && nickRow.staff === "TEST_JACK" && nickRow.ws === "Shared Team",
    });
    await ctx.close();
  }

  // =========================================================================
  // 3. Forged uuids — Victor must behave exactly like a stranger
  // =========================================================================
  {
    // The trusted boundary is the RPC, which is what someone holding Nick's
    // token can actually reach — a Server Action adds no protection the
    // database does not already provide, and this tests the real one.
    const nickToken = await signIn(ids.email.nick);
    const victorAttempt = await rpc("create_appointment", nickToken, bookingArgs({
      ws: ids.ws.private, staff: ids.staff.victor, date: await day(43), time: "10:00",
      amount: 200, remarks: fx.TAG,
    }));
    const randomAttempt = await rpc("create_appointment", nickToken, bookingArgs({
      ws: ids.ws.private, staff: RANDOM_UUID, date: await day(43), time: "10:00",
      amount: 200, remarks: fx.TAG,
    }));

    const victorRows = await fx.query(
      `select count(*)::int n from public.appointments where staff_id = $1 and appt_date = $2`,
      [ids.staff.victor, await day(43)]);

    rec.check({
      id: "QA-09 forged Victor assignment creates nothing (CRITICAL)", actor: "NICK",
      setup: "Nick's own token, Victor's real staff id and the private workspace id",
      action: "call create_appointment directly",
      expected: "refused, and no row",
      actual: `${victorAttempt.ok ? "CREATED" : victorAttempt.msg} · ${victorRows[0].n} row(s)`,
      ok: !victorAttempt.ok && victorRows[0].n === 0, security: true,
    });

    rec.check({
      id: "QA-10 Victor and a random uuid are indistinguishable (CRITICAL)", actor: "NICK",
      setup: "same call, one with Victor's id and one with a uuid that does not exist",
      action: "compare status and message",
      expected: "identical — a difference would confirm Victor exists",
      actual: `victor=${victorAttempt.status}:"${victorAttempt.msg}" random=${randomAttempt.status}:"${randomAttempt.msg}"`,
      ok: victorAttempt.status === randomAttempt.status && victorAttempt.msg === randomAttempt.msg,
      security: true,
    });
  }

  // =========================================================================
  // 4. Staff — no assignment step at all
  // =========================================================================
  for (const [who, email, expectName] of [
    ["JACK", ids.email.jack, "TEST_JACK"],
    ["VICTOR", ids.email.victor, "TEST_VICTOR"],
  ]) {
    const { page, ctx } = await session(email, { width: 390, height: 844 });
    await page.goto(`${BASE}/my/today`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await openSheet(page);

    const hasAssign = await page.evaluate(() =>
      document.querySelectorAll("[data-staff-option]").length > 0
      || /Assign staff/.test(document.body.innerText));
    rec.check({
      id: `QA-13 ${who} gets no assignment step`, actor: who, setup: "staff role",
      action: "open Quick Add and look for staff options",
      expected: "none — identity comes from the session",
      actual: hasAssign ? "ASSIGNMENT UI PRESENT" : "absent",
      ok: !hasAssign, security: true,
    });

    const name = `TEST CUSTOMER QA ${who}`;
    await fillDetails(page, { name, date: await day(44), time: "13:00" });
    await page.click("text=Save appointment");
    await page.waitForTimeout(3000);
    const row = await track(name);
    rec.check({
      id: `QA-14 ${who} books only for themselves`, actor: who, setup: "-",
      action: "save the appointment",
      expected: `committed with staff = ${expectName}`,
      actual: row ? `${row.staff} / ${row.ws}` : "NOT CREATED",
      ok: !!row && row.staff === expectName,
    });
    await ctx.close();
  }

  // =========================================================================
  // 5. Conflict — the typing survives, and no override is offered
  // =========================================================================
  {
    // Block Jack with a real appointment, then try to book the same slot.
    const clashDate = await fx.freeDate(ids.staff.jack, { offsetDays: 300 });
    const kcToken = await signIn(ids.email.kc);
    const blocker = await rpc("create_appointment", kcToken, bookingArgs({
      ws: ids.ws.shared, staff: ids.staff.jack, date: clashDate, time: "10:00",
      amount: 200, remarks: fx.TAG,
    }));
    if (blocker.ok) fx.track(blocker.body);

    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/calendar`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await openSheet(page);
    await fillDetails(page, { name: "TEST CUSTOMER QA CLASH", date: clashDate, time: "10:00" });
    await page.click("text=Assign staff");
    await page.waitForTimeout(600);
    await pickStaff(page, "TEST_JACK");

    const state = await page.evaluate(() => ({
      dialogOpen: !!document.querySelector('[role="dialog"]'),
      overrideOpen: !!document.querySelector("#override-title"),
      alert: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
      options: [...document.querySelectorAll("[data-staff-option]")].length,
    }));

    rec.check({
      id: "QA-15 a refused booking reopens the assignment step", actor: "KC",
      setup: "Jack already has 10:00 that day",
      action: "tap Jack",
      expected: "the sheet stays open and offers the choices again",
      actual: `dialog=${state.dialogOpen} options=${state.options} message="${state.alert}"`,
      ok: state.dialogOpen && state.options > 0 && !!state.alert,
    });

    const preserved = await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Edit");
      b?.click();
      return null;
    });
    void preserved;
    await page.waitForTimeout(400);
    const kept = await page.evaluate(() => ({
      name: document.querySelector("#qa-name")?.value ?? "",
      phone: document.querySelector("#qa-phone")?.value ?? "",
      address: document.querySelector("#qa-address")?.value ?? "",
      area: document.querySelector("#qa-area")?.value ?? "",
      date: document.querySelector("#qa-date")?.value ?? "",
      time: document.querySelector("#qa-time")?.value ?? "",
      price: document.querySelector("input[name='items.0.unitPrice']")?.value ?? "",
    }));
    rec.check({
      id: "QA-16 nothing typed is lost on refusal (CRITICAL)", actor: "KC",
      setup: "the booking was just refused",
      action: "return to the details step and read every field",
      expected: "all fields still populated",
      actual: JSON.stringify(kept),
      ok: kept.name === "TEST CUSTOMER QA CLASH" && kept.phone === "+60123456789"
          && kept.address === "1 TEST ROAD" && kept.area === "TEST CITY"
          && kept.date === clashDate && kept.time === "10:00" && kept.price === "200",
    });

    rec.check({
      id: "QA-17 a hidden conflict never opens the override dialog (CRITICAL)", actor: "KC",
      setup: "-",
      action: "check for the override dialog after the refusal",
      expected: "absent — override is only for a conflict this caller can see",
      actual: state.overrideOpen ? "OVERRIDE SHOWN" : "absent",
      ok: !state.overrideOpen, security: true,
    });
    await ctx.close();
  }

  // =========================================================================
  // 5b. A VISIBLE large-job conflict — the one case override is for
  // =========================================================================
  {
    // A large job locks the rest of that staff member's day forward. Booking
    // a later slot the same day is refused with LARGE_JOB_OVERRIDE_REQUIRED —
    // and because KC can see the blocking job, override is legitimate here.
    const lockDate = await fx.freeDate(ids.staff.dyron, { offsetDays: 350 });
    const kcToken = await signIn(ids.email.kc);
    const large = await rpc("create_appointment", kcToken, bookingArgs({
      ws: ids.ws.shared, staff: ids.staff.dyron, date: lockDate, time: "10:00",
      amount: 800, remarks: fx.TAG,
    }));
    if (large.ok) fx.track(large.body);

    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/calendar`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await openSheet(page);
    await fillDetails(page, { name: "TEST CUSTOMER QA OVERRIDE", date: lockDate, time: "15:00" });
    await page.click("text=Assign staff");
    await page.waitForTimeout(600);
    await pickStaff(page, "TEST_DYRON");

    const shown = await page.evaluate(() => ({
      override: !!document.querySelector("#override-title"),
      title: document.querySelector("#override-title")?.textContent ?? null,
    }));
    rec.check({
      id: "QA-22 a visible large-job conflict DOES offer override", actor: "KC",
      setup: `Dyron has an RM800 job at 10:00 on ${lockDate}`,
      action: "assign Dyron a 15:00 job the same day",
      expected: "the one-time override dialog appears",
      actual: shown.override ? `shown: "${shown.title}"` : "NOT SHOWN",
      ok: shown.override,
    });

    if (shown.override) {
      await page.fill("#override-reason", "REGRESSION: customer asked for the same day");
      await page.check('[role="dialog"] input[type="checkbox"]');
      await page.click("text=Approve and save");
      await page.waitForTimeout(3500);
      const row = await track("TEST CUSTOMER QA OVERRIDE");
      rec.check({
        id: "QA-23 override retries the SAME staff member and commits", actor: "KC",
        setup: "reason given and acknowledged",
        action: "confirm the override",
        expected: "committed to Dyron",
        actual: row ? `${row.staff} / ${row.ws}` : "NOT CREATED",
        ok: !!row && row.staff === "TEST_DYRON",
      });
    }
    await ctx.close();
  }

  // =========================================================================
  // 5c. Staff never see override UI, even for the same conflict
  // =========================================================================
  {
    const lockDate = await fx.freeDate(ids.staff.jack, { offsetDays: 380 });
    const kcToken = await signIn(ids.email.kc);
    const large = await rpc("create_appointment", kcToken, bookingArgs({
      ws: ids.ws.shared, staff: ids.staff.jack, date: lockDate, time: "10:00",
      amount: 800, remarks: fx.TAG,
    }));
    if (large.ok) fx.track(large.body);

    const { page, ctx } = await session(ids.email.jack, { width: 390, height: 844 });
    await page.goto(`${BASE}/my/today`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await openSheet(page);
    await fillDetails(page, { name: "TEST CUSTOMER QA STAFFOVR", date: lockDate, time: "15:00" });
    await page.click("text=Save appointment");
    await page.waitForTimeout(3500);

    const state = await page.evaluate(() => ({
      override: !!document.querySelector("#override-title"),
      alert: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
    }));
    const created = await rowFor("TEST CUSTOMER QA STAFFOVR");
    rec.check({
      id: "QA-24 staff never see override UI (CRITICAL)", actor: "JACK",
      setup: "same large-job lock that offers KC an override",
      action: "attempt the blocked slot as staff",
      expected: "refused with a message, and no override dialog",
      actual: `override=${state.override} created=${!!created} message="${(state.alert ?? "").slice(0, 60)}"`,
      ok: !state.override && !created && !!state.alert, security: true,
    });
    await ctx.close();
  }

  // =========================================================================
  // 6. FAB placement
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc, { width: 390, height: 844 });
    for (const path of ["/dashboard", "/calendar", "/appointments", "/availability"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      await page.waitForTimeout(700);
      const fab = await page.evaluate(() => {
        const b = document.querySelector('button[aria-label="New appointment"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
      rec.check({
        id: `QA-18 FAB present and tappable on ${path}`, actor: "KC", setup: "390px viewport",
        action: "measure the floating button",
        expected: "present, at least 44x44",
        actual: fab ? `${fab.w}x${fab.h}` : "MISSING",
        ok: !!fab && fab.w >= 44 && fab.h >= 44,
      });
    }
    await page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await page.waitForTimeout(700);
    const onForm = await page.evaluate(() => !!document.querySelector('button[aria-label="New appointment"]'));
    rec.check({
      id: "QA-19 FAB suppressed on the full booking page", actor: "KC", setup: "-",
      action: "look for the FAB on /appointments/new",
      expected: "absent — it would float over the form it opens",
      actual: onForm ? "PRESENT" : "absent", ok: !onForm,
    });
    await ctx.close();
  }

  // =========================================================================
  // 7. Multi-workspace exception — asked only when genuinely ambiguous
  // =========================================================================
  {
    // Temporarily give Jack a second visible membership.
    // staff_workspaces is a HISTORY table — no unique (staff, workspace) key,
    // because a membership can start and end more than once. So update an
    // existing row if there is one, and only insert when there is not.
    const existing = await fx.query(
      `select id, is_active from public.staff_workspaces
        where staff_id = $1 and workspace_id = $2`, [ids.staff.jack, ids.ws.private]);
    fx.trackMembership(ids.staff.jack, ids.ws.private, existing.length > 0 && existing[0].is_active);
    if (existing.length > 0) {
      await db.query(
        `update public.staff_workspaces set is_active = true, ended_at = null where id = $1`,
        [existing[0].id]);
    } else {
      await db.query(
        `insert into public.staff_workspaces (staff_id, workspace_id, is_active) values ($1, $2, true)`,
        [ids.staff.jack, ids.ws.private]);
    }

    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/calendar`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    await openSheet(page);
    await fillDetails(page, { name: "TEST CUSTOMER QA MULTI", date: await day(45), time: "10:00" });
    await page.click("text=Assign staff");
    await page.waitForTimeout(600);

    const beforePick = await page.evaluate(() => document.body.innerText.includes("Which team"));
    await pickStaff(page, "TEST_JACK");
    const afterPick = await page.evaluate(() => ({
      asked: !!document.querySelector("[data-workspace-option]"),
      options: [...document.querySelectorAll("[data-workspace-option]")].map((b) => b.textContent.trim()),
    }));

    rec.check({
      id: "QA-20 the workspace question appears only AFTER staff selection", actor: "KC",
      setup: "Jack temporarily belongs to two visible workspaces",
      action: "check before and after tapping Jack",
      expected: "not asked before; asked after, listing both",
      actual: `before=${beforePick} after=${afterPick.asked} [${afterPick.options.join(", ")}]`,
      ok: !beforePick && afterPick.asked && afterPick.options.length === 2,
    });

    if (afterPick.asked) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("[data-workspace-option]")]
          .find((x) => x.textContent.includes("Shared Team"));
        b?.click();
      });
      await page.waitForTimeout(3000);
      const row = await track("TEST CUSTOMER QA MULTI");
      rec.check({
        id: "QA-21 the answer is honoured and re-checked", actor: "KC", setup: "-",
        action: "choose Shared Team",
        expected: "committed to Shared Team",
        actual: row ? `${row.staff} / ${row.ws}` : "NOT CREATED",
        ok: !!row && row.ws === "Shared Team",
      });
    }
    await ctx.close();
  }
} finally {
  const summary = rec.summary();
  if (browser) await browser.close();
  for (const like of ["TEST CUSTOMER QA%"]) {
    await db.query(`delete from public.appointment_items where appointment_id in
      (select id from public.appointments where customer_name like $1)`, [like]);
    await db.query(`delete from public.audit_logs where entity_id in
      (select id from public.appointments where customer_name like $1)`, [like]);
    await db.query(`delete from public.appointment_rule_overrides where subject_appointment_id in
      (select id from public.appointments where customer_name like $1)`, [like]);
    await db.query(`delete from public.appointments where customer_name like $1`, [like]);
  }
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
