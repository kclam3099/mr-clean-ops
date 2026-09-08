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

const BASE = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const PASSWORD = CONFIG.testPassword();
const RANDOM_WS = "11111111-2222-4333-8444-555555555555";

assertDevProject();
const db = await adminClient();
const ids = await resolveIdentities(db);
const fx = createFixture(db);
const rec = createRecorder("F5 CALENDAR + AVAILABILITY (browser)");

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
  // 3. Availability tool
  // =========================================================================
  {
    const { page, ctx } = await session(ids.email.kc);
    await page.goto(`${BASE}/availability`, { waitUntil: "load" });
    await settle(page);
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll("[data-staff-chip]")].map((b) => b.textContent.trim()));
    rec.check({
      id: "AVL-01 KC can search all three staff", actor: "KC", setup: "All Operations",
      action: "read the staff chips",
      expected: "Jack, Dyron and Victor",
      actual: chips.join(", ") || "(none)",
      ok: ["TEST_JACK", "TEST_DYRON", "TEST_VICTOR"].every((n) => chips.includes(n)),
    });

    await page.click("[data-range-preset]");
    await page.waitForTimeout(2500);
    const results = await page.evaluate(() => ({
      books: [...document.querySelectorAll("[data-book-slot]")].map((a) => a.getAttribute("href")),
      caption: document.body.innerText.includes(
        "Suggested for a standard job. Final availability is confirmed when saving."),
      reasons: /unavailable|because|blocked|conflict/i.test(document.body.innerText),
    }));
    rec.check({
      id: "AVL-02 results carry a Book link with date, time and staff", actor: "KC", setup: "-",
      action: "read a Book this time link",
      expected: "staff, date, time and return=availability",
      actual: results.books[0] ?? "(no results)",
      ok: !!results.books[0] && ["staff=", "date=", "time=", "return=availability"]
        .every((p) => results.books[0].includes(p)),
    });
    rec.check({
      id: "AVL-03 the standard-job caption is shown", actor: "KC", setup: "-",
      action: "look for the caption",
      expected: "present — a suggestion is not a guarantee",
      actual: results.caption ? "present" : "MISSING", ok: results.caption,
    });
    rec.check({
      id: "AVL-04 no reasons are given for missing times (CRITICAL)", actor: "KC", setup: "-",
      action: "scan the results for explanations",
      expected: "available rows only, no 'why not'",
      actual: results.reasons ? "REASON TEXT FOUND" : "none", ok: !results.reasons, security: true,
    });

    // Range guard, checked before the RPC so the message is precise.
    const horizon = await day(30);
    await page.evaluate((d) => {
      const inputs = [...document.querySelectorAll('input[type="date"]')];
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inputs[1], d);
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    }, horizon);
    await page.waitForTimeout(300);
    await page.click("text=Find times");
    await page.waitForTimeout(2000);
    const rangeMsg = await page.evaluate(() =>
      document.querySelector('[role="alert"]')?.textContent?.trim() ?? null);
    rec.check({
      id: "AVL-05 an over-long range is refused with a precise message", actor: "KC",
      setup: "a range wider than the 14-day horizon",
      action: "search",
      expected: "a specific message, never raw Postgres text",
      actual: rangeMsg ?? "(no message)",
      ok: !!rangeMsg && /14 days or fewer/i.test(rangeMsg) && !/postgres|pgrst|exception/i.test(rangeMsg),
    });
    await ctx.close();
  }

  {
    const { page, ctx } = await session(ids.email.nick);
    await page.goto(`${BASE}/availability`, { waitUntil: "load" });
    await settle(page);
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll("[data-staff-chip]")].map((b) => b.textContent.trim()));
    await page.click("[data-range-preset]");
    await page.waitForTimeout(2500);
    const surfaces = await page.evaluate(() => ({
      names: [...document.querySelectorAll("li")].map((l) => l.textContent).join(" "),
      html: document.documentElement.outerHTML,
      flight: (globalThis.self?.__next_f ?? []).map((c) => JSON.stringify(c)).join("\n"),
    }));

    rec.check({
      id: "AVL-06 Nick can search only Jack and Dyron (CRITICAL)", actor: "NICK",
      setup: "Shared Team only",
      action: "read the staff chips",
      expected: "exactly 2",
      actual: `${chips.length}: ${chips.join(", ")}`,
      ok: chips.length === 2 && chips.includes("TEST_JACK") && chips.includes("TEST_DYRON"),
      security: true,
    });

    for (const [label, hay] of [
      ["results", surfaces.names], ["HTML", surfaces.html], ["RSC payload", surfaces.flight],
    ]) {
      const found = KC_ONLY.filter(([, needle]) => hay.includes(needle)).map(([l]) => l);
      rec.check({
        id: `AVL-07 availability ${label} clean (CRITICAL)`, actor: "NICK", setup: "-",
        action: `scan the ${label}`,
        expected: "0 traces of Victor or the private workspace",
        actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
        ok: found.length === 0, security: true,
      });
    }
    await ctx.close();
  }

  // =========================================================================
  // 4. A hidden appointment removes a slot, silently
  // =========================================================================
  {
    // Jack gets a temporary private membership and a hidden private job, so a
    // slot disappears from NICK's suggestions with no explanation available.
    const hiddenDate = await fx.freeDate(ids.staff.jack, { offsetDays: 6 });
    const existing = await fx.query(
      `select id, is_active from public.staff_workspaces where staff_id = $1 and workspace_id = $2`,
      [ids.staff.jack, ids.ws.private]);
    fx.trackMembership(ids.staff.jack, ids.ws.private, existing.length > 0 && existing[0].is_active);
    if (existing.length > 0) {
      await db.query(`update public.staff_workspaces set is_active = true, ended_at = null where id = $1`,
        [existing[0].id]);
    } else {
      await db.query(
        `insert into public.staff_workspaces (staff_id, workspace_id, is_active) values ($1,$2,true)`,
        [ids.staff.jack, ids.ws.private]);
    }

    const { page, ctx } = await session(ids.email.nick);
    const readSlots = async () => {
      await page.goto(`${BASE}/availability`, { waitUntil: "load" });
      await settle(page);
      await page.evaluate((d) => {
        const inputs = [...document.querySelectorAll('input[type="date"]')];
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(inputs[0], d); inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
        setter.call(inputs[1], d); inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      }, hiddenDate);
      await page.waitForTimeout(300);
      await page.click("text=Find times");
      await page.waitForTimeout(2500);
      return page.evaluate(() =>
        [...document.querySelectorAll("li")]
          .map((l) => l.textContent.replace(/\s+/g, " ").trim())
          .filter((t) => /\d{2}:\d{2}/.test(t)));
    };

    const before = await readSlots();
    const hidden = await rpc("create_appointment", kcToken, bookingArgs({
      ws: ids.ws.private, staff: ids.staff.jack, date: hiddenDate, time: "10:00", amount: 200,
      remarks: fx.TAG, customer: SYNTHETIC_PRIVATE_CUSTOMER }));
    if (hidden.ok) fx.track(hidden.body);
    const after = await readSlots();

    const jackTen = (list) => list.some((t) => t.includes("10:00") && t.includes("TEST_JACK"));
    rec.check({
      id: "AVL-08 a hidden appointment removes the slot, with no explanation (CRITICAL)",
      actor: "NICK",
      setup: "Jack given a hidden private job at 10:00 that Nick cannot see",
      action: "search the same day before and after",
      expected: "the 10:00 Jack row disappears and nothing says why",
      actual: `before jack@10:00=${jackTen(before)} after=${jackTen(after)} (${before.length} -> ${after.length} rows)`,
      ok: hidden.ok && jackTen(before) && !jackTen(after),
      security: true,
    });

    const text = await page.evaluate(() => document.body.innerText);
    const found = KC_ONLY.filter(([, n]) => text.includes(n)).map(([l]) => l);
    rec.check({
      id: "AVL-09 the removal discloses nothing (CRITICAL)", actor: "NICK", setup: "-",
      action: "scan the page after the slot vanished",
      expected: "no private customer, workspace or staff trace",
      actual: found.length ? `LEAKED: ${found.join(", ")}` : "clean",
      ok: found.length === 0, security: true,
    });
    await ctx.close();
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
} finally {
  const summary = rec.summary();
  if (browser) await browser.close();
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
