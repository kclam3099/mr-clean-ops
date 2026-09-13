// F5 — calendar operations and the availability tool.
//
// The calendar is the surface where an extra staff ROW would disclose someone
// even with no appointment in it, so the row set gets the same scrutiny as the
// appointments. And the honesty rule gets an assertion of its own: an empty
// cell must never be labelled "Free" or "Available", because a hidden
// cross-workspace appointment can still block that staff member.
//
// Run: npm run test:e2e:f5

import { chromium } from "playwright";
import {
  adminClient, assertDevProject, resolveIdentities, createFixture,
  createRecorder, CONFIG, signIn, rpc, bookingArgs, SYNTHETIC_PRIVATE_CUSTOMER,
} from "../../supabase/tests/lib/harness.mjs";

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3100").replace(/\/+$/, "");
const PASSWORD = CONFIG.testPassword();
const RANDOM_WS = "11111111-2222-4333-8444-555555555555";

assertDevProject();
const db = await adminClient();
const ids = await resolveIdentities(db);
const fx = createFixture(db);
const rec = createRecorder("F5 CALENDAR + AVAILABILITY (browser)");
// How many checks this suite intends to reach. A run that reaches a different
// number fails, whatever the pass tally says: F2 once reported 31 PASS / 0 FAIL
// with fifteen checks never executed, because a fixture threw and the summary
// only described what had run. Adding or removing a check means updating this
// number — deliberately, in the same diff.
rec.plan(43);


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

  const day = async (n) => (await fx.query(
    `select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int),'YYYY-MM-DD') d`, [n]))[0].d;

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
    await page.waitForTimeout(700);
  };

  // ---- fixtures: one shared job and one PRIVATE job on the same day --------
  const kcToken = await signIn(ids.email.kc);
  const target = await day(2);
  const shared = await rpc("create_appointment", kcToken, bookingArgs({
    ws: ids.ws.shared, staff: ids.staff.jack, date: target, time: "10:00", amount: 200, remarks: fx.TAG }));
  if (shared.ok) fx.track(shared.body);
  const priv = await rpc("create_appointment", kcToken, bookingArgs({
    ws: ids.ws.private, staff: ids.staff.victor, date: target, time: "13:00", amount: 300,
    remarks: fx.TAG, customer: SYNTHETIC_PRIVATE_CUSTOMER }));
  if (priv.ok) fx.track(priv.body);

  rec.check({
    id: "CAL-00 fixtures created", actor: "KC", setup: "-",
    action: "seed one Shared and one Private appointment on the same day",
    expected: "both created",
    actual: `shared=${shared.ok ? "ok" : shared.msg} private=${priv.ok ? "ok" : priv.msg}`,
    ok: shared.ok && priv.ok,
  });

  const readGrid = (page) => page.evaluate(() => ({
    rows: [...document.querySelectorAll("tbody tr th")].map((t) => t.textContent.trim()),
    headers: [...document.querySelectorAll("thead th")].map((t) => t.textContent.trim()),
    text: document.body.innerText,
    html: document.documentElement.outerHTML,
    flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    emptyCellHrefs: [...document.querySelectorAll('a[aria-label^="Book "]')]
      .map((a) => a.getAttribute("href")),
  }));

  // =========================================================================
  // 1. KC — rows follow the scope
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    for (const [label, query, expected] of [
      ["All Operations", "", ["TEST_DYRON", "TEST_JACK", "TEST_VICTOR"]],
      ["Shared Team", `?ws=${ids.ws.shared}`, ["TEST_DYRON", "TEST_JACK"]],
      ["KC Private Team", `?ws=${ids.ws.private}`, ["TEST_VICTOR"]],
    ]) {
      await page.goto(`${BASE}/calendar${query}`, { waitUntil: "load" });
      await settle(page);
      const grid = await readGrid(page);
      rec.check({
        id: `CAL-01 rows match scope: ${label}`, actor: "KC (super_master)",
        setup: label, action: "read the staff rows",
        expected: expected.join(", "),
        actual: grid.rows.join(", ") || "(none)",
        ok: grid.rows.length === expected.length && expected.every((n) => grid.rows.includes(n)),
      });
    }

    await page.goto(`${BASE}/calendar`, { waitUntil: "load" });
    await settle(page);
    const grid = await readGrid(page);

    rec.check({
      id: "CAL-02 today is marked", actor: "KC", setup: "-",
      action: "look for the Today indicator",
      expected: "present in the day headings",
      actual: grid.headers.some((h) => /Today/.test(h)) ? "present" : grid.headers.join(" | "),
      ok: grid.headers.some((h) => /Today/.test(h)),
    });

    rec.check({
      id: "CAL-03 an empty cell is never called Free or Available (CRITICAL)", actor: "KC",
      setup: "a hidden cross-workspace job can still block a staff member",
      action: "scan the calendar text for those words",
      expected: "absent — the calendar shows visibility, not availability",
      actual: /\b(Free|Available)\b/.test(grid.text)
        ? `FOUND: "${/\b(Free|Available)\b/.exec(grid.text)[0]}"` : "absent",
      ok: !/\b(Free|Available)\b/.test(grid.text),
    });

    const allOpsHrefs = grid.emptyCellHrefs;
    rec.check({
      id: "CAL-04 All Operations never emits a workspace id (CRITICAL)", actor: "KC",
      setup: "All Operations is virtual and has no id",
      action: "read every empty-cell booking link",
      expected: "no ws= parameter, and never ws=all",
      actual: `${allOpsHrefs.length} links, ${allOpsHrefs.filter((h) => h.includes("ws=")).length} with ws=`,
      ok: allOpsHrefs.length > 0 && allOpsHrefs.every((h) => !h.includes("ws=")),
      security: true,
    });

    await page.goto(`${BASE}/calendar?ws=${ids.ws.shared}`, { waitUntil: "load" });
    await settle(page);
    const scoped = await readGrid(page);
    rec.check({
      id: "CAL-05 a real scope prefills the workspace", actor: "KC", setup: "Shared Team",
      action: "read an empty-cell booking link",
      expected: `ws=${ids.ws.shared} plus staff, date and return`,
      actual: scoped.emptyCellHrefs[0] ?? "(none)",
      ok: !!scoped.emptyCellHrefs[0]
          && scoped.emptyCellHrefs[0].includes(`ws=${ids.ws.shared}`)
          && scoped.emptyCellHrefs[0].includes("staff=")
          && scoped.emptyCellHrefs[0].includes("return=calendar"),
    });

    // Appointment click-through reuses F3 rather than duplicating it.
    const detailHref = await page.evaluate(() =>
      document.querySelector('a[href^="/appointments/"]:not([href*="new"])')?.getAttribute("href") ?? null);
    rec.check({
      id: "CAL-06 appointments link to the F3 detail route", actor: "KC", setup: "-",
      action: "read an appointment card link",
      expected: "/appointments/<uuid>",
      actual: detailHref ?? "(none)",
      ok: !!detailHref && /^\/appointments\/[0-9a-f-]{36}$/i.test(detailHref),
    });
    await ctx.close();
  }

  // =========================================================================
  // 2. NICK — no Victor row, no private appointment, nothing in any payload
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.nick);
    await page.goto(`${BASE}/calendar`, { waitUntil: "load" });
    await settle(page);
    const grid = await readGrid(page);

    rec.check({
      id: "CAL-07 Nick's calendar has no Victor row (CRITICAL)", actor: "NICK (partner_master)",
      setup: "Victor works only in the private workspace",
      action: "read the staff rows",
      expected: "exactly TEST_DYRON and TEST_JACK",
      actual: grid.rows.join(", ") || "(none)",
      ok: grid.rows.length === 2 && grid.rows.includes("TEST_JACK") && grid.rows.includes("TEST_DYRON"),
      security: true,
    });

    for (const [label, hay] of [
      ["visible text", grid.text], ["HTML", grid.html], ["RSC payload", grid.flight],
    ]) {
      const found = KC_ONLY.filter(([, needle]) => hay.includes(needle)).map(([l]) => l);
      rec.check({
        id: `CAL-08 calendar ${label} clean (CRITICAL)`, actor: "NICK", setup: "-",
        action: `scan the calendar ${label}`,
        expected: "0 traces",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }

    rec.check({
      id: "CAL-09 no 'Private booking' placeholder is invented (CRITICAL)", actor: "NICK",
      setup: "Victor has a private job at 13:00 that day",
      action: "look for a greyed placeholder card",
      expected: "none — a placeholder at 13:00 announces that something exists at 13:00",
      actual: /private|reserved|unavailable|blocked/i.test(grid.text) ? "PLACEHOLDER FOUND" : "none",
      ok: !/private|reserved|unavailable|blocked/i.test(grid.text), security: true,
    });

    // A forged private workspace must behave like a workspace that does not
    // exist: fall back silently, never error in a way that confirms it.
    await page.goto(`${BASE}/calendar?ws=${ids.ws.private}`, { waitUntil: "load" });
    await settle(page);
    const forged = await readGrid(page);
    await page.goto(`${BASE}/calendar?ws=${RANDOM_WS}`, { waitUntil: "load" });
    await settle(page);
    const random = await readGrid(page);

    // A page echoes the query string the caller sent, so the supplied uuid
    // appears in both payloads by definition. That is not disclosure — Nick
    // typed it — and it is symmetric, so it carries no signal. Redact the
    // supplied value from each page and require what is LEFT to be identical:
    // that is the property that would break if the private workspace were
    // treated differently from a nonexistent one.
    const redact = (html, uuid) => html.split(uuid).join("<SUPPLIED-UUID>");
    const forgedBody = redact(forged.html, ids.ws.private);
    const randomBody = redact(random.html, RANDOM_WS);
    const residue = KC_ONLY.filter(([, n]) => forgedBody.includes(n)).map(([l]) => l);

    rec.check({
      id: "CAL-10 forged private workspace == random workspace (CRITICAL)", actor: "NICK",
      setup: "?ws= the real private workspace id, then a uuid that does not exist",
      action: "compare the rendered pages with each supplied uuid redacted",
      expected: "same rows, same length, and no KC-only trace beyond the echoed input",
      actual: `rows forged=[${forged.rows.join(",")}] random=[${random.rows.join(",")}] · `
            + `residue=${residue.length ? residue.join(",") : "none"} · `
            + `size delta=${Math.abs(forgedBody.length - randomBody.length)}`,
      ok: forged.rows.join(",") === random.rows.join(",")
          && residue.length === 0
          && Math.abs(forgedBody.length - randomBody.length) < 64,
      security: true,
    });
    await ctx.close();
  }

  // =========================================================================
  // 3. The customer availability message
  // =========================================================================
  // The output goes straight to a customer, so what it must NOT contain
  // matters more than what it does.
  {
    const { page, ctx } = await session(ids.email.kc);
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`${BASE}/availability`, { waitUntil: "load" });
    await page.waitForSelector("[data-customer-message]", { timeout: 20_000 });
    await settle(page);

    const message = await page.evaluate(() =>
      document.querySelector("[data-customer-message]").value);

    rec.check({
      id: "AVL-01 the page produces a ready-to-send message", actor: "KC",
      setup: "This week, generated on the server",
      action: "read the message box",
      expected: "a Chinese heading followed by weekday and time lines",
      actual: message.replace(/\n/g, " | ").slice(0, 90),
      ok: /^(这个星期可预约时间 😊|这个星期暂时没有可预约时间)/.test(message),
    });

    rec.check({
      id: "AVL-02 the message names no staff member (CRITICAL)", actor: "KC",
      setup: "the customer does not care who comes",
      action: "scan the message for staff names",
      expected: "none",
      actual: ["TEST_JACK", "TEST_DYRON", "TEST_VICTOR", "Jack", "Dyron", "Victor"]
        .filter((n) => message.includes(n)).join(", ") || "none",
      ok: !["TEST_JACK", "TEST_DYRON", "TEST_VICTOR", "Jack", "Dyron", "Victor"]
        .some((n) => message.includes(n)),
      security: true,
    });

    rec.check({
      id: "AVL-03 the message carries no workspace, count or reason (CRITICAL)", actor: "KC",
      setup: "-", action: "scan for schedule information",
      expected: "none",
      actual: ["Shared Team", "KC Private Team", "busy", "unavailable", "booked", "conflict"]
        .filter((t) => message.includes(t)).join(", ") || "none",
      ok: !["Shared Team", "KC Private Team", "busy", "unavailable", "booked", "conflict"]
        .some((t) => message.includes(t)),
      security: true,
    });

    rec.check({
      id: "AVL-04 there is no staff picker to operate", actor: "KC",
      setup: "the owner chooses WHEN, not WHO",
      action: "look for staff selection controls",
      expected: "absent",
      actual: `${await page.evaluate(() => document.querySelectorAll("[data-staff-chip]").length)} chip(s)`,
      ok: (await page.evaluate(() => document.querySelectorAll("[data-staff-chip]").length)) === 0,
    });

    // 2.13 #11 — a slot that has already passed today must not be advertised.
    const nowHHMM = (await fx.query(
      `select to_char((now() at time zone 'Asia/Kuala_Lumpur'),'HH24:MI') t`))[0].t;
    await page.click('[data-range-preset="today"]');
    await page.waitForTimeout(2500);
    const todayMessage = await page.evaluate(() =>
      document.querySelector("[data-customer-message]").value);
    const advertised = [...todayMessage.matchAll(/(\d{1,2})(?:\.(\d{2}))?(am|pm)/g)].map((m) => {
      let h = Number(m[1]) % 12;
      if (m[3] === "pm") h += 12;
      return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
    });
    rec.check({
      id: "AVL-05 a slot already past today is never advertised (CRITICAL)", actor: "KC",
      setup: `it is ${nowHHMM} MYT`,
      action: "read the Today message and compare each time against the clock",
      expected: "every advertised time is still ahead",
      actual: advertised.length ? `${advertised.join(", ")} vs now ${nowHHMM}` : "no times offered",
      ok: advertised.every((t) => t > nowHHMM),
    });

    // Copy must reproduce EXACTLY what is on screen.
    await page.click('[data-range-preset="thisWeek"]');
    await page.waitForTimeout(2500);
    const shown = await page.evaluate(() =>
      document.querySelector("[data-customer-message]").value);
    await page.click("[data-copy-message]");
    await page.waitForTimeout(800);
    const clip = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch (e) { return `FAILED: ${e.message}`; }
    });
    // Windows hands back CRLF from the OS clipboard; the text is otherwise
    // identical and pastes the same, so compare on normalised line endings.
    const norm = (t) => t.replace(/\r\n/g, "\n");
    rec.check({
      id: "AVL-06 Copy reproduces the visible message exactly", actor: "KC", setup: "-",
      action: "press Copy and read the clipboard back",
      expected: "identical to the message on screen",
      actual: norm(clip) === shown
        ? `${shown.length} chars, identical`
        : `clipboard ${clip.length} vs shown ${shown.length}`,
      ok: norm(clip) === shown,
    });

    rec.check({
      id: "AVL-07 copying gives concise feedback", actor: "KC", setup: "-",
      action: "read the button and status after copying",
      expected: "Copied",
      actual: await page.evaluate(() =>
        document.querySelector("[data-copy-message]").textContent.trim()),
      ok: (await page.evaluate(() =>
        document.querySelector("[data-copy-message]").textContent.trim())) === "Copied",
    });
    await ctx.close();
  }

  // Nick gets the same customer-facing output, built from the same operational
  // team, with no trace of anything he cannot see.
  {
    const { page, ctx } = await session(ids.email.nick);
    await page.goto(`${BASE}/availability`, { waitUntil: "load" });
    await page.waitForSelector("[data-customer-message]", { timeout: 20_000 });
    await settle(page);

    const surfaces = await page.evaluate(() => ({
      message: document.querySelector("[data-customer-message]").value,
      html: document.documentElement.outerHTML,
      flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
    }));

    rec.check({
      id: "AVL-08 Nick gets the same customer format", actor: "NICK", setup: "Shared Team only",
      action: "read the message",
      expected: "the same heading shape as KC's",
      actual: surfaces.message.split("\n")[0],
      ok: /^(这个星期可预约时间 😊|这个星期暂时没有可预约时间)/.test(surfaces.message),
    });

    for (const [label, hay] of [
      ["message", surfaces.message], ["HTML", surfaces.html], ["RSC payload", surfaces.flight],
    ]) {
      const found = KC_ONLY.filter(([, needle]) => hay.includes(needle)).map(([l]) => l);
      rec.check({
        id: `AVL-09 availability ${label} clean (CRITICAL)`, actor: "NICK", setup: "-",
        action: `scan the ${label}`,
        expected: "0 traces of Victor or the private workspace",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }
    await ctx.close();
  }

  // =========================================================================
  // 4. A hidden appointment removes a time, silently
  // =========================================================================
  {
    // Give Jack a hidden private job, and check the customer message loses that
    // time without ever explaining why. Dyron is booked at the same time first,
    // so the union rule cannot keep the slot alive.
    // The experiment has to run on a day the CUSTOMER MESSAGE actually covers,
    // which is this week only. Picking a free date by offset kept landing in
    // next week, so "before" was empty and the comparison proved nothing.
    //
    // So read the message first and take a day it already offers at 10am, then
    // fill that slot for both staff and require the time to disappear. If no
    // day offers 10am there is nothing to remove, and that is reported as a
    // skip rather than passing over an empty string.
    const existing = await fx.query(
      `select id, is_active from public.staff_workspaces where staff_id = $1 and workspace_id = $2`,
      [ids.staff.jack, ids.ws.private]);
    void existing;
    await fx.setMembership(ids.staff.jack, ids.ws.private, true);

    const readMessage = async (page) => {
      await page.goto(`${BASE}/availability`, { waitUntil: "load" });
      await page.waitForSelector("[data-customer-message]", { timeout: 20_000 });
      await settle(page);
      return page.evaluate(() => document.querySelector("[data-customer-message]").value);
    };

    const { page, ctx } = await session(ids.email.nick);
    const before = await readMessage(page);

    // Which weekday does the message offer at 10am, and what date is that?
    // The message offers a time when ANY staff member is free — that union is
    // the whole privacy design. So "the message offers 10am" does NOT mean Jack
    // is free at 10am; it may be Dyron who is. Taking the first offered day and
    // booking Jack on it failed with PHYSICAL_OVERLAP, and the check then
    // reported "10am disappeared", which reads exactly like the pass it was not.
    //
    // So walk every (day, time) the message actually offers and take the first
    // pair where Dyron AND Jack are both genuinely free. Fixing on "10am" left
    // the check unrunnable once the suite's earlier fixtures had taken that hour
    // all week — two CRITICAL security checks skipping is barely better than
    // them failing for the wrong reason.
    const ZH = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
    const TIMES = [["10am", "10:00"], ["1pm", "13:00"], ["3pm", "15:00"]];
    const lines = before.split("\n");

    const offered = [];
    for (let i = 0; i < lines.length; i++) {
      if (!ZH.includes(lines[i])) continue;
      const times = lines[i + 1] ?? "";
      for (const [label, hhmm] of TIMES) {
        if (times.includes(label)) offered.push({ day: lines[i], label, hhmm });
      }
    }

    let zh = null;
    let hiddenDate = null;
    let hiddenTime = null;
    let hiddenLabel = null;
    for (const candidate of offered) {
      const isoDow = ZH.indexOf(candidate.day) + 1;   // 1 = Monday, matching to_char(..., 'ID')
      const found = await fx.query(
        `select to_char(d, 'YYYY-MM-DD') dt
           from generate_series(
                  (now() at time zone 'Asia/Kuala_Lumpur')::date,
                  (date_trunc('week', (now() at time zone 'Asia/Kuala_Lumpur')::date)::date + 6),
                  interval '1 day') d
          where to_char(d, 'ID')::int = $1
            and not exists (
                  select 1 from public.appointments a
                   where a.appt_date = d::date
                     and a.staff_id = any($2::uuid[])
                     and a.status <> 'cancelled'
                     and a.start_time <= $3::time
                     and (a.start_time + make_interval(mins => a.final_duration_min)) > $3::time)
          limit 1`, [isoDow, [ids.staff.dyron, ids.staff.jack], candidate.hhmm]);
      if (found.length) {
        zh = candidate.day;
        hiddenDate = found[0].dt;
        hiddenTime = candidate.hhmm;
        hiddenLabel = candidate.label;
        break;
      }
    }

    if (!hiddenDate) {
      rec.skip({
        id: "AVL-10 a hidden appointment removes the time (CRITICAL)", actor: "NICK",
        reason: "no day this week offers any slot with BOTH Dyron and Jack free, so the union "
              + "rule cannot be exercised here (AVL-04 asserts the same privacy property)",
      });
      rec.skip({
        id: "AVL-11 the removal explains nothing (CRITICAL)", actor: "NICK",
        reason: "depends on AVL-10 having a slot to remove",
      });
      await ctx.close();
      await fx.restoreMembership(ids.staff.jack, ids.ws.private);
    } else {

    // Dyron in the open, Jack hidden — both at 10:00, so the union rule cannot
    // keep the slot alive.
    const dyronJob = await rpc("create_appointment", kcToken, bookingArgs({
      ws: ids.ws.shared, staff: ids.staff.dyron, date: hiddenDate, time: hiddenTime,
      amount: 200, remarks: fx.TAG, confirmPast: undefined }));
    if (dyronJob.ok) fx.track(dyronJob.body);
    const hidden = await rpc("create_appointment", kcToken, bookingArgs({
      ws: ids.ws.private, staff: ids.staff.jack, date: hiddenDate, time: hiddenTime, amount: 200,
      remarks: fx.TAG, customer: SYNTHETIC_PRIVATE_CUSTOMER }));
    if (hidden.ok) fx.track(hidden.body);

    const after = await readMessage(page);
    const dayTimes = (msg) => {
      const l = msg.split("\n");
      const i = l.indexOf(zh);
      return i === -1 ? "" : (l[i + 1] ?? "");
    };

    rec.check({
      id: "AVL-10 a hidden appointment removes the time (CRITICAL)", actor: "NICK",
      setup: `Dyron booked openly and Jack booked privately, both ${hiddenTime} on ${hiddenDate}`,
      action: "compare that weekday's times before and after",
      expected: `${hiddenLabel} disappears`,
      // The booking outcomes are part of the evidence: this check failed once
      // with "10am disappeared" in the actual column, which reads like a pass,
      // because one of the two fixtures had silently not been created.
      actual: `dyron=${dyronJob.ok ? "ok" : dyronJob.msg} hidden=${hidden.ok ? "ok" : hidden.msg} `
            + `before "${dayTimes(before)}" after "${dayTimes(after)}"`,
      ok: dyronJob.ok && hidden.ok
          && dayTimes(before).includes(hiddenLabel) && !dayTimes(after).includes(hiddenLabel),
      security: true,
    });

    rec.check({
      id: "AVL-11 the removal explains nothing (CRITICAL)", actor: "NICK", setup: "-",
      action: "scan the message and page after the time vanished",
      expected: "no private customer, workspace, staff or reason",
      actual: (() => {
        const found = KC_ONLY.filter(([, n]) => after.includes(n)).map(([l]) => l);
        return found.length ? `LEAKED: ${found.join(", ")}` : "clean";
      })(),
      ok: !KC_ONLY.some(([, n]) => after.includes(n))
          && !/busy|unavailable|conflict|booked/i.test(after),
      security: true,
    });
    await ctx.close();
    await fx.restoreMembership(ids.staff.jack, ids.ws.private);
    }

    // Undo it now: left in place it would give Jack two eligible workspaces for
    // every later block. Restored by exact row id.
    await fx.restoreMembership(ids.staff.jack, ids.ws.private);
  }


  // =========================================================================
  // 5. Responsive
  // =========================================================================
  for (const [name, width] of [["mobile", 390], ["tablet", 768], ["desktop", 1440]]) {
    const { page, ctx } = await session(ids.email.kc, { width, height: 900 });
    for (const path of ["/calendar", "/availability"]) {
      await page.goto(`${BASE}${path}`, { waitUntil: "load" });
      await settle(page);
      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const table = document.querySelector("table");
        const picker = document.querySelector('nav[aria-label="Day of week"]');
        const visible = (el) => !!el && el.getClientRects().length > 0;
        const small = [...document.querySelectorAll("a[href], button")]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 32; })
          .slice(0, 4).map((el) => el.textContent.trim().slice(0, 16));
        return {
          overflow: doc.scrollWidth - doc.clientWidth,
          tableVisible: visible(table), pickerVisible: visible(picker), small,
        };
      });
      rec.check({
        id: `CAL-11 ${name} ${path}: no horizontal overflow`, actor: "KC",
        setup: `${width}px viewport`, action: `load ${path}`,
        expected: "the page never scrolls sideways",
        actual: m.overflow > 0 ? `${m.overflow}px` : "none", ok: m.overflow <= 0,
      });
      rec.check({
        id: `CAL-12 ${name} ${path}: tap targets`, actor: "KC", setup: `${width}px`,
        action: "measure control heights",
        expected: "every control at least 32px tall",
        actual: m.small.length ? `too small: ${m.small.join(", ")}` : "all adequate",
        ok: m.small.length === 0,
      });
      if (path === "/calendar") {
        const wantGrid = width >= 1024;
        rec.check({
          id: `CAL-13 ${name} shows the right calendar`, actor: "KC", setup: `${width}px`,
          action: "check which layout is visible",
          expected: wantGrid ? "the staff x day grid" : "the day picker, not the grid",
          actual: `grid=${m.tableVisible} picker=${m.pickerVisible}`,
          ok: wantGrid ? m.tableVisible && !m.pickerVisible : m.pickerVisible && !m.tableVisible,
        });
      }
    }
    await ctx.close();
  }
} catch (e) {
  // An exception that escapes the body must not vanish into a green summary.
  // Recorded here, so cleanup still runs and the verdict still prints — but the
  // run is no longer a pass. See tests/unit/harness-accounting.test.mjs.
  rec.aborted(e);
} finally {
  if (browser) await browser.close();
  await fx.cleanup();
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
