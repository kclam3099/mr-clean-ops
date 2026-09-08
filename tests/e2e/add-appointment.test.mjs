// F2 Add Appointment — end-to-end and security regression.
//
// Real browsers, real JWTs, real RPCs. Creates only synthetic customers and
// removes everything it creates.
//
// The security half matters most: a Server Action is a public endpoint, so the
// tests exercise what a caller can actually submit, not merely what the form
// chose to render.
//
// Requires a running app (E2E_BASE_URL, default http://localhost:3100).
// Run: npm run test:e2e:f2

import { chromium } from "playwright";
import {
  adminClient, assertDevProject, resolveIdentities, createFixture,
  createRecorder, CONFIG,
} from "../../supabase/tests/lib/harness.mjs";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const PASSWORD = CONFIG.testPassword();
const RANDOM_UUID = "00000000-0000-4000-8000-0000000000ff";

assertDevProject();
const db = await adminClient();
const ids = await resolveIdentities(db);
const fx = createFixture(db);
const rec = createRecorder("F2 ADD APPOINTMENT (browser)");

let browser;
try {
  await assertAppIsUp();
  browser = await chromium.launch();

  const day = async (n) => (await fx.query(
    `select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int),'YYYY-MM-DD') d`, [n]))[0].d;
  // The nearest day Jack is genuinely free, rather than a flat "tomorrow": a
  // real appointment sitting in tomorrow's 10:00 slot made this whole suite
  // fail on a PHYSICAL_OVERLAP that had nothing to do with what it tests.
  const tomorrow = await fx.freeDate(ids.staff.jack, { offsetDays: 1 });

  // =========================================================================
  // 1. KC — Shared Team for Jack, then KC Private Team for Victor
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);

    await page.goto(`${BASE}/appointments/new?return=calendar`, { waitUntil: "load" });
    await page.waitForSelector("#workspaceId", { timeout: 20_000 });

    const wsOptions = await optionLabels(page, "#workspaceId");
    rec.check({
      id: "KC-01 workspace options", actor: "KC", setup: "entered from All Operations",
      action: "read the workspace selector",
      expected: "both administered workspaces, and no 'All Operations' entry",
      actual: wsOptions.join(" | "),
      ok: wsOptions.includes("Shared Team") && wsOptions.includes("KC Private Team")
          && !wsOptions.some((o) => /all operations/i.test(o)),
    });

    await page.selectOption("#workspaceId", { label: "Shared Team" });
    await page.waitForTimeout(300);
    const sharedStaff = await optionLabels(page, "#staffId");
    rec.check({
      id: "KC-02 Shared Team staff", actor: "KC", setup: "Shared Team selected",
      action: "read the staff selector",
      expected: "Jack and Dyron, not Victor",
      actual: sharedStaff.join(" | "),
      ok: sharedStaff.includes("TEST_JACK") && sharedStaff.includes("TEST_DYRON")
          && !sharedStaff.includes("TEST_VICTOR"),
    });

    const jackId = await fillAndSave(page, {
      staffLabel: "TEST_JACK", date: tomorrow, time: "10:00",
      customer: "F2 CUSTOMER SHARED", items: [["Sofa cleaning", "1", "200"]],
    });
    await verifyCreated(rec, fx, ids, "KC-03", "KC", jackId, {
      staffId: ids.staff.jack, workspaceId: ids.ws.shared,
      total: 200, duration: 60, customer: "F2 CUSTOMER SHARED",
    });
    rec.check({
      id: "KC-04 returned to calendar", actor: "KC", setup: "return=calendar",
      action: "check the destination after save",
      expected: "/calendar", actual: new URL(page.url()).pathname,
      ok: new URL(page.url()).pathname === "/calendar",
    });

    // KC Private Team for Victor
    await page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await page.waitForSelector("#workspaceId");
    await page.selectOption("#workspaceId", { label: "KC Private Team" });
    await page.waitForTimeout(300);
    const privStaff = await optionLabels(page, "#staffId");
    rec.check({
      id: "KC-05 Private Team staff", actor: "KC", setup: "KC Private Team selected",
      action: "read the staff selector", expected: "Victor only",
      actual: privStaff.join(" | "),
      ok: privStaff.includes("TEST_VICTOR") && !privStaff.includes("TEST_JACK"),
    });

    const victorId = await fillAndSave(page, {
      staffLabel: "TEST_VICTOR", date: tomorrow, time: "13:00",
      customer: "F2 PRIVATE CUSTOMER OMEGA", items: [["Deep clean", "2", "150"]],
    });
    await verifyCreated(rec, fx, ids, "KC-06", "KC", victorId, {
      staffId: ids.staff.victor, workspaceId: ids.ws.private,
      total: 300, duration: 90, customer: "F2 PRIVATE CUSTOMER OMEGA",
    });

    await ctx.close();
  }

  // =========================================================================
  // 2. Nick — Shared only, and hostile prefill is ignored
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);

    await page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await page.waitForSelector("#staffId", { timeout: 20_000 });

    const hasWsSelect = (await page.locator("#workspaceId").count()) > 0;
    rec.check({
      id: "NICK-01 no workspace selector", actor: "NICK", setup: "one visible workspace",
      action: "look for a workspace <select>",
      expected: "absent — a selector would imply another workspace exists",
      actual: hasWsSelect ? "PRESENT" : "absent", ok: !hasWsSelect, security: true,
    });

    const nickStaff = await optionLabels(page, "#staffId");
    rec.check({
      id: "NICK-02 staff options", actor: "NICK", setup: "-",
      action: "read the staff selector", expected: "Jack and Dyron only",
      actual: nickStaff.join(" | "),
      ok: nickStaff.includes("TEST_JACK") && nickStaff.includes("TEST_DYRON")
          && !nickStaff.includes("TEST_VICTOR"),
      security: true,
    });

    // Hostile prefill: Victor's staff id and the private workspace id.
    await page.goto(
      `${BASE}/appointments/new?ws=${ids.ws.private}&staff=${ids.staff.victor}`,
      { waitUntil: "load" });
    await page.waitForSelector("#staffId");
    const afterHint = await page.evaluate(() => ({
      staffValue: document.querySelector("#staffId")?.value ?? "",
      options: [...document.querySelectorAll("#staffId option")].map((o) => o.textContent.trim()),
      hasWorkspaceSelect: !!document.querySelector("#workspaceId"),
      html: document.documentElement.outerHTML,
      flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
    }));

    rec.check({
      id: "NICK-03 hostile prefill ignored (CRITICAL)", actor: "NICK",
      setup: "?ws=<private uuid>&staff=<Victor uuid>",
      action: "check what the form resolved",
      expected: "no selection, no Victor option, no error",
      actual: `staffValue="${afterHint.staffValue}" options=[${afterHint.options.join(", ")}]`,
      ok: afterHint.staffValue === "" && !afterHint.options.includes("TEST_VICTOR"),
      security: true,
    });

    // Scan for RESOLVED private data. The uuids themselves are excluded on
    // purpose: Next.js echoes the request URL into its routing metadata, so a
    // uuid Nick typed appears in the payload no matter what the app does — and
    // a random uuid he invents appears identically. Their presence therefore
    // conveys nothing. What must never appear is anything the server RESOLVED
    // from them: names, options, or the private customer.
    const leakTerms = [
      ["Victor's name", "TEST_VICTOR"],
      ["private workspace name", "KC Private Team"],
      ["private customer", "F2 PRIVATE CUSTOMER OMEGA"],
    ];
    for (const [surface, haystack] of [["HTML", afterHint.html], ["RSC payload", afterHint.flight]]) {
      const found = leakTerms.filter(([, t]) => haystack.includes(t)).map(([l]) => l);
      rec.check({
        id: `NICK-04 no resolved private data in ${surface} (CRITICAL)`, actor: "NICK",
        setup: "even with both uuids supplied in the URL",
        action: `scan the ${surface} (${haystack.length} chars) for resolved private data`,
        expected: "0 traces — the uuids resolve to nothing",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }

    // The decisive check: supplying Victor's real uuid must produce the same
    // response as supplying a uuid that does not exist. If these differ, the
    // page is an existence oracle regardless of what it renders.
    await page.goto(
      `${BASE}/appointments/new?ws=${RANDOM_UUID}&staff=${RANDOM_UUID}`, { waitUntil: "load" });
    await page.waitForSelector("#staffId");
    const withRandom = await page.evaluate(() => ({
      staffValue: document.querySelector("#staffId")?.value ?? "",
      options: [...document.querySelectorAll("#staffId option")].map((o) => o.textContent.trim()),
      hasWorkspaceSelect: !!document.querySelector("#workspaceId"),
    }));
    const same =
      withRandom.staffValue === afterHint.staffValue &&
      withRandom.hasWorkspaceSelect === afterHint.hasWorkspaceSelect &&
      withRandom.options.join("|") === afterHint.options.join("|");
    rec.check({
      id: "NICK-04b real hidden uuid is indistinguishable from a random one (CRITICAL)",
      actor: "NICK", setup: "compare ?staff=<Victor> against ?staff=<nonexistent>",
      action: "compare resolved selection, options and controls",
      expected: "identical — the page cannot confirm Victor exists",
      actual: same ? "identical" : `differ: victor=${JSON.stringify(afterHint.options)} random=${JSON.stringify(withRandom.options)}`,
      ok: same, security: true,
    });

    // Server Action must refuse the same thing the form refused to render.
    const forged = await page.evaluate(async ([ws, staff, date]) => {
      const fd = new FormData();
      fd.set("workspaceId", ws); fd.set("staffId", staff);
      fd.set("customerName", "F2 FORGED"); fd.set("customerPhone", "+60000000001");
      fd.set("addressLine", "A"); fd.set("areaCity", "Kepong");
      fd.set("apptDate", date); fd.set("startTime", "11:00");
      fd.set("items.0.description", "X"); fd.set("items.0.quantity", "1"); fd.set("items.0.unitPrice", "200");
      const r = await fetch(location.href, { method: "POST", body: fd });
      return { status: r.status, text: (await r.text()).slice(0, 400) };
    }, [ids.ws.private, ids.staff.victor, tomorrow]);
    const forgedRows = await fx.query(
      `select count(*)::int n from public.appointments where customer_name = 'F2 FORGED'`);
    rec.check({
      id: "NICK-05 forged submission creates nothing (CRITICAL)", actor: "NICK",
      setup: "posts the private workspace and Victor directly to the Server Action",
      action: "count rows created",
      expected: "0",
      actual: `${forgedRows[0].n} rows (HTTP ${forged.status})`,
      ok: forgedRows[0].n === 0, security: true,
    });

    // Legitimate booking for Dyron
    await page.goto(`${BASE}/appointments/new?return=appointments`, { waitUntil: "load" });
    await page.waitForSelector("#staffId");
    const dyronId = await fillAndSave(page, {
      staffLabel: "TEST_DYRON", date: tomorrow, time: "15:00",
      customer: "F2 CUSTOMER NICK", items: [["Carpet", "1", "400"]],
    });
    await verifyCreated(rec, fx, ids, "NICK-06", "NICK", dyronId, {
      staffId: ids.staff.dyron, workspaceId: ids.ws.shared,
      total: 400, duration: 120, customer: "F2 CUSTOMER NICK",
    });

    await ctx.close();
  }

  // =========================================================================
  // 3. Staff — identity fixed, no selector, no override
  // =========================================================================
  for (const [who, email, staffId, time, customer] of [
    ["JACK", ids.email.jack, ids.staff.jack, "16:00", "F2 CUSTOMER JACK"],
    ["VICTOR", ids.email.victor, ids.staff.victor, "16:00", "F2 PRIVATE CUSTOMER VICTOR"],
  ]) {
    const { page, ctx } = await session(email);
    await page.goto(`${BASE}/my/appointments/new`, { waitUntil: "load" });
    await page.waitForSelector("#customerName", { timeout: 20_000 });

    const controls = await page.evaluate(() => ({
      staffSelect: document.querySelectorAll("#staffId").length,
      wsSelect: document.querySelectorAll("#workspaceId").length,
      bookingFor: document.body.innerText.match(/Booking for\s+(\S+)/)?.[1] ?? null,
    }));
    rec.check({
      id: `STAFF-01 ${who} has no staff selector (CRITICAL)`, actor: who, setup: "-",
      action: "look for a staff <select>",
      expected: "absent — identity is server-derived",
      actual: `staffSelect=${controls.staffSelect} bookingFor=${controls.bookingFor}`,
      ok: controls.staffSelect === 0, security: true,
    });
    rec.check({
      id: `STAFF-02 ${who} single workspace, no selector`, actor: who,
      setup: "one active membership",
      action: "look for a workspace <select>",
      expected: "absent — derived silently",
      actual: `wsSelect=${controls.wsSelect}`, ok: controls.wsSelect === 0,
    });

    const id = await fillAndSave(page, {
      staffLabel: null, date: tomorrow, time,
      customer, items: [["Standard clean", "1", "200"]],
    });
    await verifyCreated(rec, fx, ids, `STAFF-03 ${who}`, who, id, {
      staffId,
      workspaceId: who === "VICTOR" ? ids.ws.private : ids.ws.shared,
      total: 200, duration: 60, customer,
    });
    rec.check({
      id: `STAFF-04 ${who} returned to own agenda`, actor: who, setup: "-",
      action: "check destination", expected: "/my/today",
      actual: new URL(page.url()).pathname, ok: new URL(page.url()).pathname === "/my/today",
    });

    await ctx.close();
  }

  // Jack cannot create for Dyron even by forging the field.
  {
    const { page, ctx } = await session(ids.email.jack);
    await page.goto(`${BASE}/my/appointments/new`, { waitUntil: "load" });
    await page.waitForSelector("#customerName");
    await page.evaluate(async ([ws, otherStaff, date]) => {
      const fd = new FormData();
      fd.set("workspaceId", ws); fd.set("staffId", otherStaff);
      fd.set("customerName", "F2 IDENTITY PROBE"); fd.set("customerPhone", "+60000000001");
      fd.set("addressLine", "A"); fd.set("areaCity", "Kepong");
      fd.set("apptDate", date); fd.set("startTime", "17:00");
      fd.set("items.0.description", "X"); fd.set("items.0.quantity", "1"); fd.set("items.0.unitPrice", "200");
      await fetch(location.href, { method: "POST", body: fd });
    }, [ids.ws.shared, ids.staff.dyron, tomorrow]);
    const probe = await fx.query(
      `select staff_id from public.appointments where customer_name = 'F2 IDENTITY PROBE'`);
    probe.forEach((r) => fx.track(r.id));
    rec.check({
      id: "STAFF-05 forged staff id never creates for another person (CRITICAL)", actor: "JACK",
      setup: "posts Dyron's staff id to the Server Action",
      action: "check what was created",
      expected: "nothing, or bound to Jack — never Dyron",
      actual: probe.length === 0 ? "nothing created"
        : probe[0].staff_id === ids.staff.jack ? "bound to Jack" : "CREATED FOR DYRON",
      ok: probe.length === 0 || probe[0].staff_id === ids.staff.jack, security: true,
    });
    await ctx.close();
  }

  // =========================================================================
  // 4. Availability semantics (0007)
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);
    const calls = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/appointments/new")) {
        calls.push(r.postData()?.slice(0, 2000) ?? "");
      }
    });

    await page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await page.waitForSelector("#staffId");
    await page.selectOption("#staffId", { label: "TEST_JACK" });
    await page.fill("#apptDate", await day(3));
    await page.waitForTimeout(1500);

    const before = calls.length;
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll("button[aria-pressed]")]
        .map((b) => b.textContent.trim()).filter((t) => /^\d{2}:\d{2}$/.test(t)));
    rec.check({
      id: "AVAIL-01 standard suggestions render", actor: "NICK", setup: "empty day",
      action: "read the suggestion chips",
      expected: "the configured slots 10:00 / 13:00 / 15:00",
      actual: chips.join(", ") || "(none)",
      ok: chips.includes("10:00") && chips.includes("13:00") && chips.includes("15:00"),
    });

    const caption = await page.evaluate(() => document.body.innerText.includes(
      "Available when checked — final availability is confirmed when saving."));
    rec.check({
      id: "AVAIL-02 caption present", actor: "NICK", setup: "-",
      action: "check the availability caption",
      expected: "states that availability is confirmed on save",
      actual: caption ? "present" : "MISSING", ok: caption,
    });

    // Change the item total. Availability must NOT re-run — that is the 0007
    // oracle. This is the regression that keeps it closed at the UI layer too.
    await page.fill("input[name='items.0.description']", "Big job");
    await page.fill("input[name='items.0.unitPrice']", "1400");
    await page.waitForTimeout(1800);
    rec.check({
      id: "AVAIL-03 item total does NOT re-run availability (CRITICAL)", actor: "NICK",
      setup: "changed the unit price from blank to RM1400",
      action: "count availability calls triggered by the change",
      expected: "0 new calls — amount must never influence the probe window",
      actual: `${calls.length - before} new call(s)`,
      ok: calls.length === before, security: true,
    });

    const sentAmount = calls.some((c) => /total_amount|unitPrice|amount/i.test(c) && /find|avail/i.test(c));
    rec.check({
      id: "AVAIL-04 no amount in any availability request (CRITICAL)", actor: "NICK",
      setup: "-", action: "scan captured request bodies",
      expected: "no amount/duration/buffer sent to availability",
      actual: sentAmount ? "AMOUNT PRESENT" : "clean", ok: !sentAmount, security: true,
    });

    await ctx.close();
  }

  // =========================================================================
  // 5. Redirect safety
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);
    const hostile = ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/settings", "../../etc"];
    const landed = [];
    for (const value of hostile) {
      await page.goto(`${BASE}/appointments/new?return=${encodeURIComponent(value)}`, { waitUntil: "load" });
      await page.waitForSelector("#staffId");
      const id = await fillAndSave(page, {
        staffLabel: "TEST_JACK", date: await day(4), time: "10:00",
        customer: "F2 REDIRECT PROBE", items: [["X", "1", "200"]],
      });
      await page.waitForTimeout(1200);
      landed.push(new URL(page.url()).origin + new URL(page.url()).pathname);
      if (id) await cancelById(fx, id);
      // Each iteration books the same slot, so clear it before the next one.
      await fx.query(`delete from public.appointment_items where appointment_id in
        (select id from public.appointments where customer_name = 'F2 REDIRECT PROBE')`);
      await fx.query(`delete from public.audit_logs where entity_id in
        (select id from public.appointments where customer_name = 'F2 REDIRECT PROBE')`);
      await fx.query(`delete from public.appointments where customer_name = 'F2 REDIRECT PROBE'`);
    }
    rec.check({
      id: "REDIRECT-01 hostile return values cannot leave the app (CRITICAL)", actor: "NICK",
      setup: `tried: ${hostile.join(", ")}`,
      action: "check where each save landed",
      expected: `always ${BASE}/calendar`,
      actual: [...new Set(landed)].join(" | "),
      ok: landed.every((u) => u === `${BASE}/calendar`), security: true,
    });
    await ctx.close();
  }


  // =========================================================================
  // 5b. Override, past dates, double submit
  // =========================================================================
  {
    const dOverride = await day(5);

    // KC creates a RM800 large job, then books a later slot the same day. The
    // second booking must be refused with LARGE_JOB_OVERRIDE_REQUIRED and the
    // dialog must appear.
    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await page.waitForSelector("#workspaceId");
    await page.selectOption("#workspaceId", { label: "Shared Team" });
    await page.waitForTimeout(300);
    await fillAndSave(page, {
      staffLabel: "TEST_DYRON", date: dOverride, time: "10:00",
      customer: "F2 LARGE JOB", items: [["Whole house", "1", "800"]],
    });

    await page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await page.waitForSelector("#workspaceId");
    await page.selectOption("#workspaceId", { label: "Shared Team" });
    await page.waitForTimeout(300);
    await fillAndSave(page, {
      staffLabel: "TEST_DYRON", date: dOverride, time: "15:00",
      customer: "F2 BLOCKED BY LARGE", items: [["Quick job", "1", "200"]],
    });

    const dialog = await page.evaluate(() => ({
      open: !!document.querySelector('[role="dialog"]'),
      hasReason: !!document.querySelector("#override-reason"),
      hasCheckbox: !!document.querySelector('[role="dialog"] input[type="checkbox"]'),
    }));
    rec.check({
      id: "OVERRIDE-01 Master gets the dialog for LARGE_JOB_OVERRIDE_REQUIRED", actor: "KC",
      setup: "Dyron has a RM800 job at 10:00 that day",
      action: "attempt 15:00 and inspect the dialog",
      expected: "dialog open, with a required reason and an explicit acknowledgement",
      actual: `open=${dialog.open} reason=${dialog.hasReason} ack=${dialog.hasCheckbox}`,
      ok: dialog.open && dialog.hasReason && dialog.hasCheckbox,
    });

    const disabledBefore = await page.evaluate(() =>
      document.querySelector('[role="dialog"] button:last-of-type')?.disabled ?? null);
    rec.check({
      id: "OVERRIDE-02 approval blocked until reason and acknowledgement", actor: "KC",
      setup: "dialog open, nothing filled",
      action: "check the approve button",
      expected: "disabled", actual: `disabled=${disabledBefore}`, ok: disabledBefore === true,
    });

    await page.fill("#override-reason", "F2 REGRESSION: nearby easy job");
    await page.check('[role="dialog"] input[type="checkbox"]');
    await page.click('[role="dialog"] button:last-of-type');
    await page.waitForTimeout(4000);
    const overrideRows = await fx.query(
      `select a.id, (select count(*) from public.appointment_rule_overrides o
                      where o.subject_appointment_id = a.id)::int overrides
       from public.appointments a where a.customer_name = 'F2 BLOCKED BY LARGE'`);
    rec.check({
      id: "OVERRIDE-03 approved booking is created with an exception row", actor: "KC",
      setup: "reason supplied and acknowledged",
      action: "verify the appointment and its override record",
      expected: "1 appointment, 1 override row",
      actual: overrideRows.length
        ? `${overrideRows.length} appointment(s), ${overrideRows[0].overrides} override row(s)`
        : "NOT CREATED",
      ok: overrideRows.length === 1 && overrideRows[0].overrides === 1,
    });
    await ctx.close();

    // STAFF_UNAVAILABLE must NEVER open the dialog. Jack gets a temporary
    // private membership and a hidden private job; Nick attempts that slot.
    const membership = await fx.query(
      `select is_active from public.staff_workspaces where staff_id=$1 and workspace_id=$2`,
      [ids.staff.jack, ids.ws.private]);
    fx.trackMembership(ids.staff.jack, ids.ws.private, membership.length > 0 && membership[0].is_active);
    // No unique constraint on (staff_id, workspace_id), so ON CONFLICT is not
    // available — update-then-insert-if-absent instead.
    await db.query(
      `update public.staff_workspaces set is_active = true
        where staff_id = $1 and workspace_id = $2`, [ids.staff.jack, ids.ws.private]);
    await db.query(
      `insert into public.staff_workspaces (staff_id, workspace_id, is_active)
       select $1, $2, true
        where not exists (select 1 from public.staff_workspaces
                           where staff_id = $1 and workspace_id = $2)`,
      [ids.staff.jack, ids.ws.private]);

    const dHidden = await day(8);
    const hiddenIns = await db.query(
      `insert into public.appointments (workspace_id,staff_id,customer_name,customer_phone,
         address_line,area_city,appt_date,start_time,calculated_duration_min,final_duration_min,
         buffer_minutes,total_amount,is_large_job,status,remarks,created_by)
       values ($1,$2,'F2 HIDDEN PRIVATE','+60000009999','A','C',$3,'10:00',60,60,30,200,false,
               'booked','F2 HIDDEN',$4) returning id`,
      [ids.ws.private, ids.staff.jack, dHidden, ids.profile.kc]);
    fx.track(hiddenIns.rows[0].id);

    const n = await session(ids.email.nick);
    await n.page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await n.page.waitForSelector("#staffId");
    await fillAndSave(n.page, {
      staffLabel: "TEST_JACK", date: dHidden, time: "10:00",
      customer: "F2 HIDDEN CONFLICT", items: [["Quick job", "1", "200"]],
    });
    const unavailable = await n.page.evaluate(() => ({
      dialogOpen: !!document.querySelector('[role="dialog"]'),
      text: document.body.innerText,
    }));
    const created = await fx.query(
      `select count(*)::int n from public.appointments where customer_name = 'F2 HIDDEN CONFLICT'`);
    rec.check({
      id: "OVERRIDE-04 STAFF_UNAVAILABLE never opens the override dialog (CRITICAL)", actor: "NICK",
      setup: "Jack blocked by a hidden KC Private Team job at 10:00",
      action: "attempt the blocked slot",
      expected: "generic unavailable message, NO dialog, nothing created",
      actual: `dialog=${unavailable.dialogOpen} created=${created[0].n}`,
      ok: !unavailable.dialogOpen && created[0].n === 0
          && unavailable.text.includes("This team member is not available at that time"),
      security: true,
    });
    const leaked = ["F2 HIDDEN PRIVATE", "KC Private Team", "TEST_VICTOR", ids.ws.private]
      .filter((t) => unavailable.text.includes(t));
    rec.check({
      id: "OVERRIDE-05 unavailable message discloses nothing (CRITICAL)", actor: "NICK",
      setup: "same", action: "scan the visible message",
      expected: "no hidden customer, workspace, time or reason",
      actual: leaked.length ? `LEAKED: ${leaked.join(", ")}` : "clean",
      ok: leaked.length === 0, security: true,
    });
    await n.ctx.close();

    // Staff never see the override UI at all.
    //
    // Jack now has TWO active memberships (the hidden-conflict setup above gave
    // him one), so this also exercises the multi-workspace staff case: the
    // in-form workspace selector must appear, and Save must stay disabled until
    // a workspace is chosen. Still no staff selector — identity is fixed.
    const j = await session(ids.email.jack);
    await j.page.goto(`${BASE}/my/appointments/new`, { waitUntil: "load" });
    await j.page.waitForSelector("#customerName");

    const multi = await j.page.evaluate(() => ({
      wsSelect: document.querySelectorAll("#workspaceId").length,
      staffSelect: document.querySelectorAll("#staffId").length,
      saveDisabled: document.querySelector('button[type="submit"]')?.disabled ?? null,
      wsOptions: [...document.querySelectorAll("#workspaceId option")]
        .map((o) => o.textContent.trim()).filter((t) => !/^Choose/.test(t)),
    }));
    rec.check({
      id: "STAFF-06 multi-workspace staff get an in-form workspace selector", actor: "JACK",
      setup: "Jack temporarily belongs to two workspaces",
      action: "inspect the booking-context controls",
      expected: "workspace selector present, still NO staff selector, Save disabled until chosen",
      actual: `wsSelect=${multi.wsSelect} staffSelect=${multi.staffSelect} ` +
              `saveDisabled=${multi.saveDisabled} options=[${multi.wsOptions.join(", ")}]`,
      ok: multi.wsSelect === 1 && multi.staffSelect === 0 && multi.saveDisabled === true,
      security: true,
    });

    await j.page.selectOption("#workspaceId", { label: "Shared Team" });
    await j.page.waitForTimeout(300);
    await fillAndSave(j.page, {
      staffLabel: null, date: dOverride, time: "15:30",
      customer: "F2 STAFF LARGE", items: [["Big job", "1", "800"]],
    });
    const staffDialog = await j.page.evaluate(() => ({
      dialog: !!document.querySelector('[role="dialog"]'),
      hasOverrideField: !!document.querySelector("#override-reason"),
    }));
    rec.check({
      id: "OVERRIDE-06 staff never see override UI (CRITICAL)", actor: "JACK",
      setup: "submits a job that could require an override",
      action: "look for the dialog or a reason field",
      expected: "neither present",
      actual: `dialog=${staffDialog.dialog} reasonField=${staffDialog.hasOverrideField}`,
      ok: !staffDialog.dialog && !staffDialog.hasOverrideField, security: true,
    });
    await j.ctx.close();

    // Past dates: the picker discourages them, and a forged submission is
    // refused by the database with safe copy.
    const k = await session(ids.email.kc);
    await k.page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await k.page.waitForSelector("#apptDate");
    const minAttr = await k.page.getAttribute("#apptDate", "min");
    rec.check({
      id: "PAST-01 the date input no longer blocks past dates", actor: "KC",
      setup: "0010 made historical recording possible",
      action: "read the date input min attribute",
      expected: "absent — blocking at the input would contradict a rule the database now allows",
      actual: String(minAttr), ok: minAttr === null,
    });

    const yesterday = await day(-1);
    const forgedPast = await k.page.evaluate(async (args) => {
      const [ws, staff, date] = args;
      const fd = new FormData();
      fd.set("workspaceId", ws); fd.set("staffId", staff);
      fd.set("customerName", "F2 PAST PROBE"); fd.set("customerPhone", "+60000000001");
      fd.set("addressLine", "A"); fd.set("areaCity", "Kepong");
      fd.set("apptDate", date); fd.set("startTime", "10:00");
      fd.set("items.0.description", "X"); fd.set("items.0.quantity", "1"); fd.set("items.0.unitPrice", "200");
      const r = await fetch(location.href, { method: "POST", body: fd });
      const text = await r.text();
      return { status: r.status, leaksRaw: /must be in the future|SQLSTATE|P0001|relation /.test(text) };
    }, [ids.ws.shared, ids.staff.jack, yesterday]);
    const pastRows = await fx.query(
      `select count(*)::int n from public.appointments where customer_name = 'F2 PAST PROBE'`);
    rec.check({
      id: "PAST-02 forged past date refused, no raw error text (CRITICAL)", actor: "KC",
      setup: "posts yesterday directly to the Server Action",
      action: "check rows created and whether raw server text is echoed",
      expected: "0 rows, no raw database wording in the response",
      actual: `rows=${pastRows[0].n} rawTextInResponse=${forgedPast.leaksRaw}`,
      ok: pastRows[0].n === 0 && !forgedPast.leaksRaw, security: true,
    });

    // Double submit: rapid clicks must not create two appointments.
    await k.page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
    await k.page.waitForSelector("#workspaceId");
    await k.page.selectOption("#workspaceId", { label: "Shared Team" });
    await k.page.waitForTimeout(300);
    await k.page.selectOption("#staffId", { label: "TEST_DYRON" });
    await k.page.fill("#customerName", "F2 DOUBLE SUBMIT");
    await k.page.fill("#customerPhone", "+60000000001");
    await k.page.fill("#addressLine", "A");
    await k.page.fill("#areaCity", "Kepong");
    await k.page.fill("input[name='items.0.description']", "X");
    await k.page.fill("input[name='items.0.quantity']", "1");
    await k.page.fill("input[name='items.0.unitPrice']", "200");
    await k.page.fill("#apptDate", await day(9));
    await k.page.waitForTimeout(900);
    await k.page.fill("#startTime", "10:00");
    // Let React re-render so Save is genuinely enabled. Clicking a disabled
    // button is a no-op, which would make this test pass for the wrong reason.
    await k.page.waitForFunction(
      () => document.querySelector('button[type="submit"]')?.disabled === false,
      { timeout: 10_000 });
    const enabledBeforeClicks = await k.page.evaluate(
      () => document.querySelector('button[type="submit"]')?.disabled === false);
    await k.page.evaluate(() => {
      const b = document.querySelector('button[type="submit"]');
      b.click(); b.click(); b.click();
    });
    await k.page.waitForTimeout(5000);
    const dup = await fx.query(
      `select count(*)::int n from public.appointments where customer_name = 'F2 DOUBLE SUBMIT'`);
    rec.check({
      id: "DOUBLE-01 rapid clicks create exactly one appointment (CRITICAL)", actor: "KC",
      setup: `three synchronous clicks on an enabled Save button (enabled=${enabledBeforeClicks})`,
      action: "count rows created",
      expected: "exactly 1 — not 0 (nothing happened) and not 2+ (duplicate)",
      actual: `${dup[0].n} rows`,
      ok: enabledBeforeClicks && dup[0].n === 1, security: true,
    });
    await k.ctx.close();
  }


  // =========================================================================
  // 5c. Required-field validation
  // =========================================================================
  // Regression for a defect found during F2: area_city is NOT NULL in the
  // database, but the schema treated it as optional and sent null. The user got
  // "Something went wrong" and lost the booking. Every NOT NULL column must
  // produce a field-level message instead.
  {
    const { page, ctx } = await session(ids.email.kc);
    const dValidation = await day(10);

    for (const blank of ["customerName", "customerPhone", "addressLine", "areaCity"]) {
      await page.goto(`${BASE}/appointments/new`, { waitUntil: "load" });
      await page.waitForSelector("#workspaceId");
      await page.selectOption("#workspaceId", { label: "Shared Team" });
      await page.waitForTimeout(300);
      await page.selectOption("#staffId", { label: "TEST_DYRON" });

      const values = {
        customerName: "F2 VALIDATION", customerPhone: "+60000000001",
        addressLine: "12 Jalan Test", areaCity: "Kepong",
      };
      for (const [field, value] of Object.entries(values)) {
        await page.fill(`#${field}`, field === blank ? "" : value);
      }
      await page.fill("input[name='items.0.description']", "X");
      await page.fill("input[name='items.0.quantity']", "1");
      await page.fill("input[name='items.0.unitPrice']", "200");
      await page.fill("#apptDate", dValidation);
      await page.waitForTimeout(900);
      await page.fill("#startTime", "10:00");
      await page.click('button[type="submit"]');
      await page.waitForTimeout(3000);

      const state = await page.evaluate((field) => {
        const input = document.querySelector(`#${field}`);
        const err = input?.closest("div")?.querySelector(".text-red-600")?.textContent?.trim() ?? null;
        return { fieldError: err, body: document.body.innerText };
      }, blank);
      const rows = await fx.query(
        `select count(*)::int n from public.appointments where customer_name = 'F2 VALIDATION'`);

      rec.check({
        id: `VALID-01 blank ${blank} gives a field error, not a generic failure`, actor: "KC",
        setup: `every field filled except ${blank}`,
        action: "submit and inspect the response",
        expected: "an inline message on that field, no 'Something went wrong', nothing created",
        actual: `fieldError=${JSON.stringify(state.fieldError)} rows=${rows[0].n} ` +
                `generic=${state.body.includes("Something went wrong")}`,
        ok: rows[0].n === 0 && !state.body.includes("Something went wrong")
            && !!state.fieldError,
      });
    }
    await ctx.close();
  }

  // =========================================================================
  // 6. Privacy regression after both Shared and Private rows exist
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);
    await page.goto(`${BASE}/calendar?week=${tomorrow}`, { waitUntil: "load" });
    // The header lives in the layout and renders immediately, so waiting for it
    // proves nothing about the calendar — against a production build the
    // snapshot below caught the loading skeleton instead of the appointments,
    // which would have made the PRIV-01 scan pass over an empty page. Wait for
    // streaming to finish, then for the grid itself.
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), { timeout: 20_000 })
      .catch(() => {});
    await page.waitForSelector("table, nav[aria-label='Day of week']", { timeout: 20_000 });
    await page.waitForTimeout(500);
    const snap = await page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
      text: document.body.innerText,
    }));
    const terms = [
      ["Victor", "TEST_VICTOR"], ["KC Private Team", "KC Private Team"],
      ["private workspace uuid", ids.ws.private],
      ["private customer (KC)", "F2 PRIVATE CUSTOMER OMEGA"],
      ["private customer (Victor)", "F2 PRIVATE CUSTOMER VICTOR"],
    ];
    for (const [surface, hay] of [["visible text", snap.text], ["HTML", snap.html], ["RSC payload", snap.flight]]) {
      const found = terms.filter(([, t]) => hay.includes(t)).map(([l]) => l);
      rec.check({
        id: `PRIV-01 ${surface} clean after F2 creates (CRITICAL)`, actor: "NICK",
        setup: "Shared and Private appointments both created today",
        action: `scan the ${surface}`,
        expected: "0 traces",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }
    rec.check({
      id: "PRIV-02 Nick still sees his own new row", actor: "NICK", setup: "-",
      action: "look for the Shared Team customer he created",
      expected: "present — proves the scan is not vacuous",
      actual: snap.text.includes("F2 CUSTOMER NICK") || snap.text.includes("F2 CUSTOMER SHARED")
        ? "present" : "MISSING",
      ok: snap.text.includes("F2 CUSTOMER NICK") || snap.text.includes("F2 CUSTOMER SHARED"),
    });
    await ctx.close();
  }
} finally {
  const summary = rec.summary();
  if (browser) await browser.close();
  // Anything the flow created carries an F2 customer name.
  await db.query(`delete from public.appointment_items where appointment_id in
    (select id from public.appointments where customer_name like 'F2 %')`);
  await db.query(`delete from public.appointment_rule_overrides where subject_appointment_id in
    (select id from public.appointments where customer_name like 'F2 %')`);
  await db.query(`delete from public.audit_logs where entity_id in
    (select id from public.appointments where customer_name like 'F2 %')`);
  const removed = await db.query(`delete from public.appointments where customer_name like 'F2 %' returning id`);
  await fx.cleanup();
  console.log(`fixture cleanup: ${removed.rowCount} F2 appointments removed`);
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

async function optionLabels(page, selector) {
  return page.evaluate(
    (sel) => [...document.querySelectorAll(`${sel} option`)]
      .map((o) => o.textContent.trim()).filter((t) => !/^Choose|^No /.test(t)),
    selector,
  );
}

/** Fills the form and saves, returning the created appointment id (or null). */
async function fillAndSave(page, { staffLabel, date, time, customer, items }) {
  if (staffLabel) await page.selectOption("#staffId", { label: staffLabel });
  await page.fill("#customerName", customer);
  await page.fill("#customerPhone", "+60000000001");
  await page.fill("#addressLine", "12 Jalan Test");
  await page.fill("#areaCity", "Kepong");
  for (const [i, [desc, qty, price]] of items.entries()) {
    if (i > 0) await page.click("text=+ Add another service");
    await page.fill(`input[name='items.${i}.description']`, desc);
    await page.fill(`input[name='items.${i}.quantity']`, qty);
    await page.fill(`input[name='items.${i}.unitPrice']`, price);
  }
  await page.fill("#apptDate", date);
  await page.waitForTimeout(900);
  await page.fill("#startTime", time);
  await page.click("button[type=submit]");
  await page.waitForTimeout(3500);
  return null; // the row is looked up by customer name in verifyCreated
}

async function verifyCreated(rec, fx, ids, id, actor, _unused, expected) {
  const rows = await fx.query(
    `select a.id, a.staff_id, a.workspace_id, a.total_amount, a.calculated_duration_min,
            a.buffer_minutes, a.is_large_job, a.status,
            (select count(*) from public.appointment_items i where i.appointment_id = a.id)::int items
     from public.appointments a where a.customer_name = $1`, [expected.customer]);
  const row = rows[0];
  const ok = !!row
    && row.staff_id === expected.staffId
    && row.workspace_id === expected.workspaceId
    && Number(row.total_amount) === expected.total
    && row.calculated_duration_min === expected.duration
    && row.buffer_minutes === 30
    && row.status === "booked"
    && row.items >= 1;
  rec.check({
    id: `${id} row created correctly`, actor, setup: `customer "${expected.customer}"`,
    action: "verify the database row",
    expected: `staff+workspace correct, total ${expected.total}, duration ${expected.duration}, buffer 30, ${"≥"}1 item`,
    actual: row
      ? `staff=${row.staff_id === expected.staffId} ws=${row.workspace_id === expected.workspaceId} ` +
        `total=${row.total_amount} dur=${row.calculated_duration_min} buf=${row.buffer_minutes} ` +
        `items=${row.items} status=${row.status}`
      : "NO ROW CREATED",
    ok,
  });
}

async function cancelById(fx, id) {
  if (id) await fx.query(`delete from public.appointments where id = $1`, [id]);
}
