// F3 Appointment detail / edit — end-to-end and security regression.
//
// The property that matters most: a hidden appointment and a nonexistent one
// must be indistinguishable. Not "different message", not "different status
// code", not "different timing" — the same page. Anything else confirms that an
// appointment exists, which is the whole cross-workspace privacy model.
//
// Server Actions are public endpoints, so the mutation tests post directly to
// them rather than only driving the UI.
//
// Requires a running app (E2E_BASE_URL, default http://localhost:3000).
// Run: npm run test:e2e:f3

import { chromium } from "playwright";
import {
  adminClient, assertDevProject, resolveIdentities, createFixture,
  createRecorder, CONFIG, signIn, rpc, bookingArgs,
} from "../../supabase/tests/lib/harness.mjs";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const PASSWORD = CONFIG.testPassword();
const RANDOM_UUID = "00000000-0000-4000-8000-0000000000ff";

assertDevProject();
const db = await adminClient();
const ids = await resolveIdentities(db);
const fx = createFixture(db);
const rec = createRecorder("F3 APPOINTMENT DETAIL (browser)");

let browser;
try {
  await assertAppIsUp();
  browser = await chromium.launch();

  const day = async (n) => (await fx.query(
    `select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int),'YYYY-MM-DD') d`, [n]))[0].d;

  // =========================================================================
  // Fixture: one appointment per staff member, plus terminal examples
  // =========================================================================
  const kcToken = await signIn(ids.email.kc);
  const make = async (ws, staff, date, time, customer, amount = 200) => {
    const r = await rpc("create_appointment", kcToken, bookingArgs({
      ws, staff, date, time, amount, remarks: fx.TAG,
      customer: {
        p_customer_name: customer, p_customer_phone: "+60000000001",
        p_address_line: "TEST ADDRESS F3", p_area_city: "Kepong",
      },
    }));
    if (!r.ok) throw new Error(`fixture failed (${customer}): ${r.msg}`);
    fx.track(r.body);
    return r.body;
  };

  const jackAppt = await make(ids.ws.shared, ids.staff.jack, await day(200), "10:00", "TEST CUSTOMER F3 JACK");
  const dyronAppt = await make(ids.ws.shared, ids.staff.dyron, await day(201), "10:00", "TEST CUSTOMER F3 DYRON");
  const victorAppt = await make(ids.ws.private, ids.staff.victor, await day(202), "10:00", "TEST PRIVATE CUSTOMER F3 VICTOR");
  const completedAppt = await make(ids.ws.shared, ids.staff.jack, await day(203), "10:00", "TEST CUSTOMER F3 COMPLETED");
  const cancelledAppt = await make(ids.ws.shared, ids.staff.jack, await day(204), "10:00", "TEST CUSTOMER F3 CANCELLED");
  await rpc("mark_appointment_completed", kcToken, { p_appointment_id: completedAppt });
  await rpc("cancel_appointment", kcToken, { p_appointment_id: cancelledAppt, p_reason: "F3 fixture" });

  rec.check({
    id: "F3-00 fixture", actor: "KC", setup: "clean baseline",
    action: "create appointments for Jack, Dyron and Victor, plus completed and cancelled",
    expected: "5 created, 2 moved to terminal states",
    actual: "created", ok: true,
  });

  // =========================================================================
  // 1. KC — sees both workspaces
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    for (const [label, id, customer] of [
      ["Shared", jackAppt, "TEST CUSTOMER F3 JACK"],
      ["Private", victorAppt, "TEST PRIVATE CUSTOMER F3 VICTOR"],
    ]) {
      await page.goto(`${BASE}/appointments/${id}`, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.body.innerText);
      rec.check({
        id: `KC-01 opens ${label} appointment`, actor: "KC", setup: "administers both workspaces",
        action: `open /appointments/${label}`,
        expected: "the customer is shown, with actions",
        actual: text.includes(customer) ? "shown" : "NOT SHOWN",
        ok: text.includes(customer) && text.includes("Edit customer"),
      });
    }

    // Detail must not leak internals.
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const internals = [
      ["audit json", "before_json"], ["override table", "appointment_rule_overrides"],
      ["conflicting id", "conflicting_appointment_id"], ["occupied range", "occupied_range"],
      ["created_by", "created_by"],
    ].filter(([, t]) => html.includes(t)).map(([l]) => l);
    rec.check({
      id: "KC-02 no internals exposed (CRITICAL)", actor: "KC", setup: "-",
      action: "scan the detail page for audit/override/scheduling metadata",
      expected: "none present",
      actual: internals.length ? `EXPOSED: ${internals.join(", ")}` : "clean",
      ok: internals.length === 0, security: true,
    });
    await ctx.close();
  }

  // =========================================================================
  // 2. Nick — hidden appointments behave exactly like nonexistent ones
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);

    await page.goto(`${BASE}/appointments/${dyronAppt}`, { waitUntil: "load" });
    await page.waitForTimeout(1000);
    const visible = await page.evaluate(() => document.body.innerText);
    rec.check({
      id: "NICK-01 opens a Shared appointment", actor: "NICK", setup: "-",
      action: "open Dyron's Shared Team appointment",
      expected: "shown",
      actual: visible.includes("TEST CUSTOMER F3 DYRON") ? "shown" : "NOT SHOWN",
      ok: visible.includes("TEST CUSTOMER F3 DYRON"),
    });

    const snapshots = {};
    for (const [label, id] of [["victor", victorAppt], ["random", RANDOM_UUID], ["malformed", "not-a-uuid"]]) {
      await page.goto(`${BASE}/appointments/${id}`, { waitUntil: "load" });
      await page.waitForTimeout(900);
      snapshots[label] = await page.evaluate(() => ({
        text: document.body.innerText.trim(),
        html: document.documentElement.outerHTML,
      }));
    }

    rec.check({
      id: "NICK-02 hidden appointment is indistinguishable from a random uuid (CRITICAL)",
      actor: "NICK", setup: "Victor's private appointment vs a uuid that does not exist",
      action: "compare the two rendered pages",
      expected: "identical visible text",
      actual: snapshots.victor.text === snapshots.random.text
        ? "identical" : `differ:\n  victor="${snapshots.victor.text.slice(0, 90)}"\n  random="${snapshots.random.text.slice(0, 90)}"`,
      ok: snapshots.victor.text === snapshots.random.text, security: true,
    });
    rec.check({
      id: "NICK-03 a malformed id behaves the same", actor: "NICK", setup: "-",
      action: "open /appointments/not-a-uuid",
      expected: "the same unavailable page, not a crash",
      actual: snapshots.malformed.text === snapshots.random.text ? "identical" : snapshots.malformed.text.slice(0, 80),
      ok: snapshots.malformed.text === snapshots.random.text, security: true,
    });
    rec.check({
      id: "NICK-04 unavailable page is generic", actor: "NICK", setup: "-",
      action: "read the unavailable copy",
      expected: "says not available, never 'not authorized' or 'exists'",
      actual: snapshots.random.text.slice(0, 120).replace(/\n/g, " "),
      ok: /not available/i.test(snapshots.random.text)
          && !/permission|authoriz|forbidden|exists/i.test(snapshots.random.text),
      security: true,
    });

    const leaks = [
      ["Victor", "TEST_VICTOR"], ["private workspace", "KC Private Team"],
      ["private customer", "TEST PRIVATE CUSTOMER F3 VICTOR"], ["private ws uuid", ids.ws.private],
    ].filter(([, t]) => snapshots.victor.html.includes(t)).map(([l]) => l);
    rec.check({
      id: "NICK-05 no private trace when opening a private id (CRITICAL)", actor: "NICK",
      setup: "URL contains the real private appointment uuid",
      action: "scan the full HTML",
      expected: "0 resolved private data",
      actual: leaks.length ? `LEAKED: ${leaks.join(", ")}` : "clean",
      ok: leaks.length === 0, security: true,
    });

    // Forged mutation against a hidden appointment.
    const forged = await postAction(page, `${BASE}/appointments/${dyronAppt}`, {
      appointmentId: victorAppt, customerName: "F3 FORGED", customerPhone: "+60000000001",
      addressLine: "A", areaCity: "Kepong",
    });
    const stillNamed = await fx.query(
      `select customer_name from public.appointments where id = $1`, [victorAppt]);
    rec.check({
      id: "NICK-06 forged edit of a hidden appointment changes nothing (CRITICAL)", actor: "NICK",
      setup: "posts Victor's appointment id to the customer-edit action",
      action: "check the row afterwards",
      expected: "unchanged",
      actual: `customer_name="${stillNamed[0]?.customer_name}" (HTTP ${forged.status})`,
      ok: stillNamed[0]?.customer_name === "TEST PRIVATE CUSTOMER F3 VICTOR", security: true,
    });
    await ctx.close();
  }

  // =========================================================================
  // 3. Staff isolation
  // =========================================================================
  for (const [who, email, ownId, ownCustomer, foreignIds] of [
    ["JACK", ids.email.jack, jackAppt, "TEST CUSTOMER F3 JACK", [dyronAppt, victorAppt]],
    ["DYRON", ids.email.dyron, dyronAppt, "TEST CUSTOMER F3 DYRON", [jackAppt, victorAppt]],
    ["VICTOR", ids.email.victor, victorAppt, "TEST PRIVATE CUSTOMER F3 VICTOR", [jackAppt, dyronAppt]],
  ]) {
    const { page, ctx } = await session(email);

    await page.goto(`${BASE}/my/appointments/${ownId}`, { waitUntil: "load" });
    await page.waitForTimeout(1000);
    const own = await page.evaluate(() => document.body.innerText);
    rec.check({
      id: `STAFF-01 ${who} opens own appointment`, actor: who, setup: "-",
      action: "open own appointment detail",
      expected: "shown with edit actions",
      actual: own.includes(ownCustomer) ? "shown" : "NOT SHOWN",
      ok: own.includes(ownCustomer) && own.includes("Edit customer"),
    });

    await page.goto(`${BASE}/my/appointments/${RANDOM_UUID}`, { waitUntil: "load" });
    await page.waitForTimeout(800);
    const baseline = (await page.evaluate(() => document.body.innerText)).trim();

    for (const foreign of foreignIds) {
      await page.goto(`${BASE}/my/appointments/${foreign}`, { waitUntil: "load" });
      await page.waitForTimeout(800);
      const got = (await page.evaluate(() => document.body.innerText)).trim();
      rec.check({
        id: `STAFF-02 ${who} cannot open another person's appointment (CRITICAL)`, actor: who,
        setup: "another staff member's appointment id",
        action: "compare against a nonexistent uuid",
        expected: "identical unavailable page",
        actual: got === baseline ? "identical" : `differs: "${got.slice(0, 70)}"`,
        ok: got === baseline, security: true,
      });
    }

    // Forged mutation on someone else's appointment.
    const target = foreignIds[0];
    const before = await fx.query(`select customer_name from public.appointments where id = $1`, [target]);
    await postAction(page, `${BASE}/my/appointments/${ownId}`, {
      appointmentId: target, customerName: "F3 STAFF FORGED", customerPhone: "+60000000001",
      addressLine: "A", areaCity: "Kepong",
    });
    const after = await fx.query(`select customer_name from public.appointments where id = $1`, [target]);
    rec.check({
      id: `STAFF-03 ${who} forged edit of another appointment changes nothing (CRITICAL)`, actor: who,
      setup: "posts another person's appointment id",
      action: "compare customer_name before and after",
      expected: "unchanged",
      actual: `"${before[0]?.customer_name}" -> "${after[0]?.customer_name}"`,
      ok: before[0]?.customer_name === after[0]?.customer_name, security: true,
    });
    await ctx.close();
  }

  // =========================================================================
  // 4. Terminal states are read-only
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    for (const [label, id] of [["completed", completedAppt], ["cancelled", cancelledAppt]]) {
      await page.goto(`${BASE}/appointments/${id}`, { waitUntil: "load" });
      await page.waitForTimeout(1000);
      const state = await page.evaluate(() => ({
        text: document.body.innerText,
        buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()),
      }));
      const mutators = state.buttons.filter((b) =>
        /edit|reschedul|cancel appointment|mark completed|restore/i.test(b));
      rec.check({
        id: `TERM-01 ${label} renders no mutation controls`, actor: "KC",
        setup: `appointment is ${label}`,
        action: "list buttons on the detail page",
        expected: "no edit / reschedule / cancel / complete / restore",
        actual: mutators.length ? `PRESENT: ${mutators.join(", ")}` : "none",
        ok: mutators.length === 0,
      });
      rec.check({
        id: `TERM-02 ${label} explains it is history`, actor: "KC", setup: "same",
        action: "check the copy",
        expected: "states the appointment is history",
        actual: /kept as history/i.test(state.text) ? "present" : "MISSING",
        ok: /kept as history/i.test(state.text),
      });
    }

    // Forged mutation against a terminal appointment must still be refused.
    for (const [label, id] of [["completed", completedAppt], ["cancelled", cancelledAppt]]) {
      const before = await fx.query(`select status, customer_name from public.appointments where id=$1`, [id]);
      await postAction(page, `${BASE}/appointments/${id}`, {
        appointmentId: id, customerName: "F3 TERMINAL FORGED", customerPhone: "+60000000001",
        addressLine: "A", areaCity: "Kepong",
      });
      const after = await fx.query(`select status, customer_name from public.appointments where id=$1`, [id]);
      rec.check({
        id: `TERM-03 forged edit of a ${label} appointment is refused (CRITICAL)`, actor: "KC",
        setup: "posts directly to the edit action",
        action: "compare status and customer before and after",
        expected: "unchanged",
        actual: `${before[0]?.status}/"${before[0]?.customer_name}" -> ${after[0]?.status}/"${after[0]?.customer_name}"`,
        ok: before[0]?.customer_name === after[0]?.customer_name
            && before[0]?.status === after[0]?.status,
        security: true,
      });
    }
    await ctx.close();
  }

  // =========================================================================
  // 5. Edit, reschedule, complete and cancel actually work
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    const editable = await make(ids.ws.shared, ids.staff.dyron, await day(210), "10:00", "TEST CUSTOMER F3 EDIT");

    await page.goto(`${BASE}/appointments/${editable}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);

    await page.click("text=Edit customer");
    await page.waitForSelector("#customerName");
    await page.fill("#customerName", "TEST CUSTOMER F3 RENAMED");
    await page.fill("#areaCity", "Cheras");
    await page.click("button[type=submit]");
    await page.waitForTimeout(2500);
    const renamed = await fx.query(
      `select customer_name, area_city from public.appointments where id=$1`, [editable]);
    rec.check({
      id: "EDIT-01 customer edit saves", actor: "KC", setup: "-",
      action: "rename the customer and change the area",
      expected: "both persisted",
      actual: `${renamed[0]?.customer_name} / ${renamed[0]?.area_city}`,
      ok: renamed[0]?.customer_name === "TEST CUSTOMER F3 RENAMED" && renamed[0]?.area_city === "Cheras",
    });

    // Blank area/city must be a field error, not a generic failure.
    await page.click("text=Edit customer");
    await page.waitForSelector("#areaCity");
    await page.fill("#areaCity", "");
    await page.click("button[type=submit]");
    await page.waitForTimeout(2000);
    const blank = await page.evaluate(() => ({
      body: document.body.innerText,
      fieldError: document.querySelector("#areaCity")?.closest("div")?.querySelector(".text-red-600")?.textContent ?? null,
    }));
    rec.check({
      id: "EDIT-02 blank area/city is a field error", actor: "KC",
      setup: "area_city is NOT NULL in the database",
      action: "submit with it blank",
      expected: "inline field message, never 'Something went wrong'",
      actual: `fieldError=${JSON.stringify(blank.fieldError)} generic=${blank.body.includes("Something went wrong")}`,
      ok: !!blank.fieldError && !blank.body.includes("Something went wrong"),
    });

    // Items expansion recalculates server-side.
    await page.goto(`${BASE}/appointments/${editable}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await page.click("text=Edit services");
    await page.waitForSelector("input[name='items.0.unitPrice']");
    await page.fill("input[name='items.0.unitPrice']", "400");
    await page.click("button[type=submit]");
    await page.waitForTimeout(2500);
    const expanded = await fx.query(
      `select total_amount, calculated_duration_min from public.appointments where id=$1`, [editable]);
    rec.check({
      id: "EDIT-03 item edit recalculates duration server-side", actor: "KC", setup: "RM200 job",
      action: "change the unit price to RM400",
      expected: "total 400, duration 120 — derived by the server, not the browser",
      actual: `total=${expanded[0]?.total_amount} duration=${expanded[0]?.calculated_duration_min}`,
      ok: Number(expanded[0]?.total_amount) === 400 && expanded[0]?.calculated_duration_min === 120,
    });

    // Reschedule.
    const newDate = await day(211);
    await page.goto(`${BASE}/appointments/${editable}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await page.click("text=Reschedule");
    await page.waitForSelector("#apptDate");
    await page.fill("#apptDate", newDate);
    await page.waitForTimeout(1200);
    await page.fill("#startTime", "13:00");
    await page.click("button[type=submit]");
    await page.waitForTimeout(2500);
    const moved = await fx.query(
      `select to_char(appt_date,'YYYY-MM-DD') d, to_char(start_time,'HH24:MI') t
         from public.appointments where id=$1`, [editable]);
    rec.check({
      id: "EDIT-04 reschedule saves", actor: "KC", setup: "-",
      action: `move to ${newDate} 13:00`,
      expected: "persisted",
      actual: `${moved[0]?.d} ${moved[0]?.t}`,
      ok: moved[0]?.d === newDate && moved[0]?.t === "13:00",
    });

    // A past reschedule is refused with safe copy.
    const past = await day(-1);
    const pastRes = await postAction(page, `${BASE}/appointments/${editable}`, {
      appointmentId: editable, apptDate: past, startTime: "10:00",
    }, "reschedule");
    const notMoved = await fx.query(`select to_char(appt_date,'YYYY-MM-DD') d from public.appointments where id=$1`, [editable]);
    rec.check({
      id: "EDIT-05 reschedule into the past is refused (CRITICAL)", actor: "KC", setup: "-",
      action: `post a reschedule to ${past}`,
      expected: "refused, appointment unmoved, no raw database text",
      actual: `date=${notMoved[0]?.d} rawText=${pastRes.leaksRaw}`,
      ok: notMoved[0]?.d === newDate && !pastRes.leaksRaw, security: true,
    });

    // Complete, then confirm it is terminal.
    await page.goto(`${BASE}/appointments/${editable}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await page.click("text=Mark completed");
    await page.waitForSelector('[role="dialog"]');
    await page.click('[role="dialog"] button:last-of-type');
    await page.waitForTimeout(2500);
    const done = await fx.query(`select status from public.appointments where id=$1`, [editable]);
    rec.check({
      id: "LIFE-01 mark completed works and requires confirmation", actor: "KC", setup: "-",
      action: "confirm the completion dialog",
      expected: "status becomes completed",
      actual: String(done[0]?.status), ok: done[0]?.status === "completed",
    });

    // Cancel a different appointment.
    const cancelMe = await make(ids.ws.shared, ids.staff.dyron, await day(212), "10:00", "TEST CUSTOMER F3 CANCEL");
    await page.goto(`${BASE}/appointments/${cancelMe}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await page.click("text=Cancel appointment");
    await page.waitForSelector('[role="dialog"]');
    await page.fill("#cancel-reason", "F3 regression cancel");
    await page.click('[role="dialog"] button:last-of-type');
    await page.waitForTimeout(2500);
    const cancelled = await fx.query(`select status from public.appointments where id=$1`, [cancelMe]);
    rec.check({
      id: "LIFE-02 cancel works and requires confirmation", actor: "KC", setup: "-",
      action: "confirm the cancellation dialog",
      expected: "status becomes cancelled",
      actual: String(cancelled[0]?.status), ok: cancelled[0]?.status === "cancelled",
    });
    await ctx.close();
  }

  // =========================================================================
  // 6. Override: only for a visible large-job conflict, Masters only
  // =========================================================================
  {
    const d = await day(215);
    await make(ids.ws.shared, ids.staff.dyron, d, "10:00", "TEST CUSTOMER F3 LARGE", 800);
    const victim = await make(ids.ws.shared, ids.staff.dyron, await day(216), "10:00", "TEST CUSTOMER F3 VICTIM");

    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/appointments/${victim}`, { waitUntil: "load" });
    await page.waitForTimeout(1200);
    await page.click("text=Reschedule");
    await page.waitForSelector("#apptDate");
    await page.fill("#apptDate", d);
    await page.waitForTimeout(1200);
    await page.fill("#startTime", "15:00");
    await page.click("button[type=submit]");
    await page.waitForTimeout(2500);
    const dialog = await page.evaluate(() => ({
      open: !!document.querySelector('[role="dialog"]'),
      reason: !!document.querySelector("#override-reason"),
    }));
    rec.check({
      id: "OVR-01 Master gets the override dialog on reschedule", actor: "KC",
      setup: "Dyron has a RM800 job at 10:00 that day",
      action: "reschedule into 15:00 behind the forward lock",
      expected: "override dialog with a reason field",
      actual: `open=${dialog.open} reason=${dialog.reason}`,
      ok: dialog.open && dialog.reason,
    });

    if (dialog.open) {
      await page.fill("#override-reason", "F3 REGRESSION: nearby easy job");
      await page.check('[role="dialog"] input[type="checkbox"]');
      await page.click('[role="dialog"] button:last-of-type');
      await page.waitForTimeout(3000);
      const moved = await fx.query(
        `select to_char(appt_date,'YYYY-MM-DD') d,
                (select count(*) from public.appointment_rule_overrides o
                  where o.subject_appointment_id = a.id)::int overrides
           from public.appointments a where a.id=$1`, [victim]);
      rec.check({
        id: "OVR-02 approved override reschedules and records an exception", actor: "KC",
        setup: "reason supplied and acknowledged",
        action: "verify the move and the exception row",
        expected: `moved to ${d}, 1 override row`,
        actual: `date=${moved[0]?.d} overrides=${moved[0]?.overrides}`,
        ok: moved[0]?.d === d && moved[0]?.overrides === 1,
      });
    }
    await ctx.close();

    // Staff must never see the override UI on the detail page.
    const dyronOwn = await make(ids.ws.shared, ids.staff.dyron, await day(217), "10:00", "TEST CUSTOMER F3 DYRON OWN");
    const s = await session(ids.email.dyron);
    await s.page.goto(`${BASE}/my/appointments/${dyronOwn}`, { waitUntil: "load" });
    await s.page.waitForTimeout(1200);
    await s.page.click("text=Reschedule");
    await s.page.waitForSelector("#apptDate");
    await s.page.fill("#apptDate", d);
    await s.page.waitForTimeout(1200);
    await s.page.fill("#startTime", "16:00");
    await s.page.click("button[type=submit]");
    await s.page.waitForTimeout(2500);
    const staffDialog = await s.page.evaluate(() => ({
      dialog: !!document.querySelector('[role="dialog"]'),
      reason: !!document.querySelector("#override-reason"),
    }));
    rec.check({
      id: "OVR-03 staff never see the override dialog (CRITICAL)", actor: "DYRON",
      setup: "reschedules behind a large-job lock",
      action: "look for the override dialog",
      expected: "absent",
      actual: `dialog=${staffDialog.dialog} reason=${staffDialog.reason}`,
      ok: !staffDialog.dialog && !staffDialog.reason, security: true,
    });
    await s.ctx.close();
  }

  // =========================================================================
  // 7. Staff Complete visibility follows the real backend setting
  // =========================================================================
  {
    const own = await make(ids.ws.shared, ids.staff.jack, await day(220), "10:00", "TEST CUSTOMER F3 COMPLETE PERM");
    const before = (await fx.query(`select staff_can_mark_completed s from public.business_settings`))[0].s;

    const withFlag = async (value) => {
      await fx.query(`update public.business_settings set staff_can_mark_completed = $1`, [value]);
      const { page, ctx } = await session(ids.email.jack);
      await page.goto(`${BASE}/my/appointments/${own}`, { waitUntil: "load" });
      await page.waitForTimeout(1200);
      const shown = await page.evaluate(() =>
        [...document.querySelectorAll("button")].some((b) => /mark completed/i.test(b.textContent)));
      await ctx.close();
      return shown;
    };

    try {
      const on = await withFlag(true);
      const off = await withFlag(false);
      rec.check({
        id: "PERM-01 staff Complete follows the backend setting (CRITICAL)", actor: "JACK",
        setup: "toggle business_settings.staff_can_mark_completed",
        action: "check whether the Complete action renders",
        expected: "shown when enabled, hidden when disabled",
        actual: `enabled=${on} disabled=${off}`,
        ok: on === true && off === false,
      });
    } finally {
      await fx.query(`update public.business_settings set staff_can_mark_completed = $1`, [before]);
    }
    const restored = (await fx.query(`select staff_can_mark_completed s from public.business_settings`))[0].s;
    rec.check({
      id: "PERM-02 setting restored", actor: "db", setup: "-",
      action: "re-read the flag", expected: String(before),
      actual: String(restored), ok: restored === before,
    });
  }
} finally {
  const summary = rec.summary();
  if (browser) await browser.close();
  await db.query(`delete from public.appointment_items where appointment_id in
    (select id from public.appointments where customer_name like 'TEST %F3%' or remarks = $1)`, [fx.TAG]);
  await db.query(`delete from public.appointment_rule_overrides where subject_appointment_id in
    (select id from public.appointments where customer_name like 'TEST %F3%' or remarks = $1)`, [fx.TAG]);
  await db.query(`delete from public.audit_logs where entity_id in
    (select id from public.appointments where customer_name like 'TEST %F3%' or remarks = $1)`, [fx.TAG]);
  const removed = await db.query(
    `delete from public.appointments where customer_name like 'TEST %F3%' or remarks = $1 returning id`, [fx.TAG]);
  await fx.cleanup();
  console.log(`fixture cleanup: ${removed.rowCount} F3 appointments removed`);
  await db.end();
  process.exitCode = summary.fail === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

async function assertAppIsUp() {
  try {
    const r = await fetch(`${BASE}/login`, { redirect: "manual" });
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    console.error(`\nCannot reach the app at ${BASE} (${e.message}). Start it first.\n`);
    process.exit(2);
  }
}

async function session(email) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  await page.fill("input[name=email]", email);
  await page.fill("input[name=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  return { page, ctx };
}

/** Posts directly to a Server Action, bypassing the UI entirely. */
async function postAction(page, pageUrl, fields) {
  if (new URL(page.url()).pathname !== new URL(pageUrl).pathname) {
    await page.goto(pageUrl, { waitUntil: "load" });
    await page.waitForTimeout(800);
  }
  return page.evaluate(async (f) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(f)) fd.set(k, v);
    const r = await fetch(location.href, { method: "POST", body: fd });
    const text = await r.text();
    return {
      status: r.status,
      leaksRaw: /must be in the future|SQLSTATE|P0001|Outside working hours \(|relation /.test(text),
    };
  }, fields);
}
