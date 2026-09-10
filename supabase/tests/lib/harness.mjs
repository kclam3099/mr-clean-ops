// Shared harness for the DEV regression suites.
//
// These are INTEGRATION tests: they run against a live Supabase DEV project
// using real GoTrue JWTs, so they exercise PostgREST + RLS exactly as the
// browser will. A direct postgres connection is used ONLY to set up and tear
// down fixtures (there is no hard-delete RPC by design) and to read back
// server-computed columns for assertions.
//
// Every suite creates its own fixture and removes it in a finally block. No
// suite may depend on data left behind by another suite or by an earlier run.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');

// ---------------------------------------------------------------------------
// config — never hard-code credentials; .env.local is gitignored
// ---------------------------------------------------------------------------
function loadEnvLocal() {
  const p = resolve(REPO, '.env.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnvLocal();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\nMissing ${name}.\nSet it in .env.local (gitignored) — see supabase/tests/README.md.`);
    process.exit(2);
  }
  return v;
}

export const CONFIG = {
  url: () => required('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, ''),
  anon: () => required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  testPassword: () => required('TEST_IDENTITY_PASSWORD'),
  dbPassword: () => required('SUPABASE_DB_PASSWORD'),
  dbHost: () => process.env.SUPABASE_DB_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com',
  dbUser: () => required('SUPABASE_DB_USER'),
};

/**
 * The project ref these suites are allowed to touch.
 *
 * A ref, not a hostname substring: "dev" or "test" appearing in a URL proves
 * nothing, and a production project could easily contain either word. The ref
 * identifies one specific Supabase project and nothing else.
 *
 * Kept as an allowlist so a future TEST project can be added beside DEV without
 * loosening the check into a pattern.
 */
const TEST_SAFE_PROJECT_REFS = ['ozojfflkchltwqnbflso'];

/** The ref out of a Supabase URL: https://<ref>.supabase.co */
function projectRef(url) {
  const m = /https?:\/\/([a-z0-9]{20})\.supabase\./i.exec(url);
  return m ? m[1] : null;
}

/**
 * Fail-closed guard for anything that writes to the database.
 *
 * Refuses unless the target project is explicitly on the allowlist. An
 * unparseable URL, an unknown ref, or a missing ref all refuse — the default
 * answer is no, so a typo or a copied .env cannot silently point a destructive
 * suite at the wrong project.
 *
 * The old override (ALLOW_NON_DEV_TESTS=true) is deliberately gone. A plain
 * boolean escape hatch is exactly the thing that gets pasted into a shell
 * against production; allowing a new project now means adding its ref above,
 * in a reviewed diff.
 */
export function assertDevProject() {
  const url = CONFIG.url();
  const ref = projectRef(url);

  if (!ref) {
    console.error(`\nRefusing to run: cannot read a Supabase project ref from ${url}.\n` +
      `These suites create and DELETE rows, so an unrecognised target is refused.`);
    process.exit(2);
  }
  if (!TEST_SAFE_PROJECT_REFS.includes(ref)) {
    console.error(`\nRefusing to run against project ${ref}.\n` +
      `Only these projects are marked test-safe: ${TEST_SAFE_PROJECT_REFS.join(', ')}.\n` +
      `These suites create and DELETE rows. To allow a new test project, add its\n` +
      `ref to TEST_SAFE_PROJECT_REFS in supabase/tests/lib/harness.mjs.`);
    process.exit(2);
  }
  return ref;
}

// ---------------------------------------------------------------------------
// HTTP helpers — real JWTs through PostgREST
// ---------------------------------------------------------------------------
/**
 * Access-token cache, shared across suite processes.
 *
 * Every suite runs in its own process and signs in five identities, so a full
 * regression run made ~35 password grants — enough to hit Supabase's auth rate
 * limit. The symptom was nasty: suites after the first two died before their
 * first assertion and reported "0 PASS / 0 FAIL", which reads like a pass at a
 * glance. Caching turns a whole run into a handful of real sign-ins.
 *
 * Kept in the OS temp directory, never in the repo, so DEV tokens cannot be
 * committed. Tokens are re-validated against their own `exp` claim.
 */
const TOKEN_CACHE = resolve(tmpdir(), 'mr-clean-ops-dev-tokens.json');
const memoryTokens = new Map();

function readTokenCache() {
  try { return JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')); } catch { return {}; }
}
function writeTokenCache(cache) {
  try { writeFileSync(TOKEN_CACHE, JSON.stringify(cache), { mode: 0o600 }); } catch { /* best effort */ }
}
/** Seconds until this JWT expires, or 0 if it cannot be read. */
function secondsLeft(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp - Math.floor(Date.now() / 1000) : 0;
  } catch { return 0; }
}

export async function signIn(email) {
  const cached = memoryTokens.get(email) ?? readTokenCache()[email];
  // 120s margin so a token cannot expire mid-suite.
  if (cached && secondsLeft(cached) > 120) {
    memoryTokens.set(email, cached);
    return cached;
  }

  const r = await fetch(`${CONFIG.url()}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: CONFIG.anon(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: CONFIG.testPassword() }),
  });
  const b = await r.json();
  if (!r.ok || !b.access_token) {
    const hint = r.status === 429 || /rate/i.test(JSON.stringify(b))
      ? ' (auth rate limit — wait a few minutes, or reuse the cached tokens)' : '';
    throw new Error(`sign-in failed for ${email}: ${JSON.stringify(b)}${hint}`);
  }

  memoryTokens.set(email, b.access_token);
  writeTokenCache({ ...readTokenCache(), [email]: b.access_token });
  return b.access_token;
}

export async function rpc(fn, token, args) {
  const r = await fetch(`${CONFIG.url()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: CONFIG.anon(), 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(args || {}),
  });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body, msg: body?.message ?? String(text).slice(0, 300) };
}

export async function rest(path, token, init = {}) {
  const r = await fetch(`${CONFIG.url()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: CONFIG.anon(), 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body, rows: Array.isArray(body) ? body : [], msg: body?.message ?? String(text).slice(0, 300) };
}

// ---------------------------------------------------------------------------
// admin connection — fixtures and assertions only, never the system under test
// ---------------------------------------------------------------------------
export async function adminClient() {
  const c = new pg.Client({
    host: CONFIG.dbHost(), port: 5432, user: CONFIG.dbUser(),
    password: CONFIG.dbPassword(), database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  return c;
}

// ---------------------------------------------------------------------------
// result recording
// ---------------------------------------------------------------------------
export function createRecorder(suiteName) {
  const results = [];
  let pass = 0, fail = 0, securityFail = 0, skipped = 0;

  function check({ id, actor = '-', setup = '-', action, expected, actual, ok, security = false }) {
    if (ok) {
      pass++;
    } else {
      fail++;
      if (security) securityFail++;
    }
    results.push({ suite: suiteName, id, actor, setup, action, expected, actual, ok, security });
    const tag = ok ? 'PASS' : (security ? 'SECURITY-FAIL' : 'FAIL');
    console.log(`[${tag}] ${id} (${actor}) :: ${action}`);
    console.log(`        expected: ${expected}`);
    console.log(`        actual  : ${actual}`);
    return ok;
  }

  /**
   * A check that could not be evaluated in these conditions.
   *
   * It is deliberately NOT a pass. Recording a skip as green is how a suite
   * comes to report full marks while a property was never exercised — the
   * time-of-day branches in the past-guard suite did exactly that.
   */
  function skip({ id, actor = '-', reason }) {
    skipped++;
    results.push({ suite: suiteName, id, actor, skipped: true, reason });
    console.log(`[SKIP] ${id} (${actor}) :: ${reason}`);
    return false;
  }

  function summary() {
    console.log(`\n########## ${suiteName}: ${pass} PASS / ${fail} FAIL` +
      `${skipped ? ` / ${skipped} SKIPPED` : ''} (security failures: ${securityFail}) ##########`);
    if (skipped) {
      console.log('\nSKIPPED (not counted as passes):');
      for (const s of results.filter(r => r.skipped)) console.log(`  ${s.id} — ${s.reason}`);
    }
    const bad = results.filter(r => !r.skipped && !r.ok);
    if (bad.length) {
      console.log('\nFAILED:');
      for (const f of bad) {
        console.log(`  ${f.security ? '[SECURITY] ' : ''}${f.id} (${f.actor}) — ${f.action}`);
        console.log(`      expected: ${f.expected}`);
        console.log(`      actual  : ${f.actual}`);
      }
    }
    return { suite: suiteName, pass, fail, securityFail, skipped, results };
  }

  return { check, skip, summary, get counts() { return { pass, fail, securityFail, skipped }; } };
}

// ---------------------------------------------------------------------------
// identities — resolved by name at runtime, never hard-coded UUIDs, so the
// suites survive a DEV data reset that reissues ids
// ---------------------------------------------------------------------------
export async function resolveIdentities(db) {
  const { rows: profiles } = await db.query(
    `select p.id, p.full_name, p.role::text as role from public.profiles p`);
  const { rows: staff } = await db.query(
    `select s.id, s.display_name, s.profile_id from public.staff s`);
  const { rows: workspaces } = await db.query(`select id, name from public.workspaces`);

  const byName = (list, key, name) => {
    const hit = list.find(x => x[key] === name);
    if (!hit) throw new Error(`fixture identity missing: ${name} (run the DEV identity setup first)`);
    return hit;
  };

  const shared = byName(workspaces, 'name', 'Shared Team');
  const priv = byName(workspaces, 'name', 'KC Private Team');

  const P = n => byName(profiles, 'full_name', n);
  const S = n => byName(staff, 'display_name', n);

  return {
    ws: { shared: shared.id, private: priv.id },
    profile: {
      kc: P('TEST_KC').id, nick: P('TEST_NICK').id, jack: P('TEST_JACK').id,
      dyron: P('TEST_DYRON').id, victor: P('TEST_VICTOR').id,
    },
    staff: { jack: S('TEST_JACK').id, dyron: S('TEST_DYRON').id, victor: S('TEST_VICTOR').id },
    email: {
      kc: 'test-kc@mrcleanclean.dev.test', nick: 'test-nick@mrcleanclean.dev.test',
      jack: 'test-jack@mrcleanclean.dev.test', dyron: 'test-dyron@mrcleanclean.dev.test',
      victor: 'test-victor@mrcleanclean.dev.test',
    },
  };
}

export async function signInAll(ids) {
  const T = {};
  for (const [k, email] of Object.entries(ids.email)) T[k] = await signIn(email);
  return T;
}

// ---------------------------------------------------------------------------
// fixture tracker — EXACT-ID OWNERSHIP
//
// A test may delete only rows it can PROVE it created. That proof is the
// primary key captured at creation time, and nothing else.
//
// This rule exists because it was broken. A teardown once deleted rows matching
// `remarks IS NOT NULL`, reasoning that a remark looked like fixture text, and
// destroyed a real appointment the owner had entered. No predicate over
// customer_name, remarks, dates, staff, workspace, amount or status can
// establish ownership: manual data can match any of them.
//
// So the following are PROHIBITED in teardown, permanently:
//   - customer_name LIKE / starts-with / equals
//   - remarks = <tag>  or  remarks IS NOT NULL
//   - date ranges, staff_id, workspace_id, status, amount
//   - "looks like a fixture"
//
// TAG remains, but ONLY as a diagnostic label a human can grep for. It carries
// no authority to delete anything.
//
// Rows a test did not create are left alone, even when they look stale.
// Reporting an unowned leftover is correct; guessing is not.
// ---------------------------------------------------------------------------
export function createFixture(db) {
  const appointments = new Set();          // exact appointment ids
  const timeOff = new Set();               // exact staff_time_off ids
  const insertedWorkingHours = new Set();  // rows THIS run inserted
  const removedWorkingHours = [];          // rows THIS run displaced, for restore
  const insertedMemberships = new Set();   // rows THIS run inserted
  const changedMemberships = [];           // rows THIS run modified, for restore
  const insertedSlots = new Set();         // suggested_time_slots ids
  const membershipSnapshots = [];          // state before a test changed it via RPC
  const workingHourSnapshots = [];         // ditto, for working hours
  const usedDates = new Set();
  const watches = [];                      // pre-existing ids, so only NEW rows are adopted
  const TAG = 'REGRESSION FIXTURE';
  /** Unique per run, so a lookup by name cannot match another run or a manual
   *  booking. Used to FIND ids, never as a licence to delete. */
  const RUN_ID = `R${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase();

  /** True once the pre-test state of this (staff, weekday) has been captured,
   *  by either route. Recording it twice would let a row the TEST created be
   *  restored at teardown as though it had always been there — which is how a
   *  late-window fixture leaked into the database and survived the run. */
  const originalCaptured = (staffId, dayOfWeek) =>
    removedWorkingHours.some((r) => r.staff_id === staffId && r.day_of_week === dayOfWeek)
    || workingHourSnapshots.some((s) => s.staffId === staffId && s.dayOfWeek === dayOfWeek);

  return {
    TAG,
    RUN_ID,
    track(id) { if (id) appointments.add(id); return id; },
    trackTimeOff(id) { if (id) timeOff.add(id); return id; },
    trackSuggestedSlot(id) { if (id) insertedSlots.add(id); return id; },

    /**
     * Take ownership of rows this run created through the UI, where the id was
     * never returned to the caller.
     *
     * The lookup is a DISCOVERY step, not an authorization: whatever it finds
     * is added to the exact-id set, and only that set is ever deleted. Pass a
     * predicate narrow enough to exclude manual data — a RUN_ID-bearing
     * customer name is the intended shape.
     */
    async adopt(whereSql, params) {
      const { rows } = await db.query(
        `select id from public.appointments where ${whereSql}`, params);
      for (const r of rows) appointments.add(r.id);
      return rows.map((r) => r.id);
    },

    /**
     * Watch a set of rows a browser test is about to create.
     *
     * E2E suites drive the real UI, so the new row's id is never returned to
     * them and they used to clean up with `customer_name LIKE ...`. That is
     * ownership by resemblance, and resemblance is exactly what destroyed a
     * real appointment.
     *
     * This records which matching rows ALREADY EXIST, so `adoptNew()` can take
     * ownership of the difference — rows that appeared while the suite ran.
     * A manual booking matching the same pattern was present at baseline and is
     * therefore never adopted, never deleted.
     */
    async watchAppointments(whereSql, params) {
      const { rows } = await db.query(
        `select id from public.appointments where ${whereSql}`, params);
      watches.push({ whereSql, params, baseline: new Set(rows.map((r) => r.id)) });
      return rows.length;
    },

    /** Take ownership of everything that appeared since `watchAppointments`. */
    async adoptNew() {
      let adopted = 0;
      for (const w of watches) {
        const { rows } = await db.query(
          `select id from public.appointments where ${w.whereSql}`, w.params);
        for (const r of rows) {
          if (!w.baseline.has(r.id)) { appointments.add(r.id); adopted++; }
        }
      }
      return adopted;
    },

    /** Ids this run owns, for assertions about its own footprint. */
    ownedAppointmentIds() { return [...appointments]; },

    /**
     * Replace a staff member's working hours for one weekday, remembering the
     * exact row displaced so teardown can put it back.
     *
     * The old code deleted by (staff_id, day_of_week) and never restored, so a
     * manually configured window was destroyed rather than borrowed.
     */
    async setWorkingHours(staffId, dayOfWeek, startTime, endTime) {
      const alreadyCaptured = originalCaptured(staffId, dayOfWeek);
      const { rows: existing } = await db.query(
        `select id, staff_id, day_of_week, start_time, end_time
           from public.staff_working_hours where staff_id = $1 and day_of_week = $2`,
        [staffId, dayOfWeek]);
      for (const row of existing) {
        // Only remember a row this run did NOT create. Recording our own
        // insert as "displaced" would restore it at teardown and collide with
        // uq_working_hours_staff_day; the pre-existing row is the one that has
        // to come back, and it was captured the first time round.
        if (insertedWorkingHours.has(row.id)) insertedWorkingHours.delete(row.id);
        else if (!alreadyCaptured) removedWorkingHours.push(row);
        await db.query(`delete from public.staff_working_hours where id = $1`, [row.id]);
      }
      const { rows } = await db.query(
        `insert into public.staff_working_hours (staff_id, day_of_week, start_time, end_time)
         values ($1,$2,$3::time,$4::time) returning id`,
        [staffId, dayOfWeek, startTime, endTime]);
      insertedWorkingHours.add(rows[0].id);
      return rows[0].id;
    },

    /** Temporarily remove a weekday's window, remembering it for restore. */
    async clearWorkingHours(staffId, dayOfWeek) {
      const alreadyCaptured = originalCaptured(staffId, dayOfWeek);
      const { rows: existing } = await db.query(
        `select id, staff_id, day_of_week, start_time, end_time
           from public.staff_working_hours where staff_id = $1 and day_of_week = $2`,
        [staffId, dayOfWeek]);
      for (const row of existing) {
        // Same rule as setWorkingHours: our own insert is simply dropped, only
        // a pre-existing row is remembered for restore.
        if (insertedWorkingHours.has(row.id)) insertedWorkingHours.delete(row.id);
        else if (!alreadyCaptured) removedWorkingHours.push(row);
        await db.query(`delete from public.staff_working_hours where id = $1`, [row.id]);
      }
      return existing.length;
    },

    /**
     * Give a staff member a workspace membership for the duration of a test.
     * An existing row is UPDATED and its previous values remembered; a new row
     * is inserted and its id remembered. Teardown restores exactly.
     */
    async setMembership(staffId, workspaceId, isActive) {
      const { rows: existing } = await db.query(
        `select id, is_active, ended_at from public.staff_workspaces
          where staff_id = $1 and workspace_id = $2`, [staffId, workspaceId]);
      if (existing.length > 0) {
        const row = existing[0];
        // Do not record a row this run inserted as "changed" — it will be
        // deleted outright at teardown, and restoring it would resurrect it.
        if (!insertedMemberships.has(row.id) && !changedMemberships.some((c) => c.id === row.id)) {
          changedMemberships.push({
            id: row.id, staffId, workspaceId, isActive: row.is_active, endedAt: row.ended_at });
        }
        await db.query(
          `update public.staff_workspaces set is_active = $2, ended_at = null where id = $1`,
          [row.id, isActive]);
        return row.id;
      }
      const { rows } = await db.query(
        `insert into public.staff_workspaces (staff_id, workspace_id, is_active)
         values ($1,$2,$3) returning id`, [staffId, workspaceId, isActive]);
      insertedMemberships.add(rows[0].id);
      return rows[0].id;
    },

    /**
     * Snapshot a membership BEFORE the test changes it through the real RPC.
     *
     * Some suites must go through `set_staff_workspace_active` rather than
     * writing the row directly, because the RPC is the thing under test. This
     * records which rows existed beforehand; teardown then restores those and
     * removes any row that appeared afterwards.
     *
     * Ownership is still exact and still provable: a row absent at snapshot
     * time and present at teardown was created by this run, and it is deleted
     * by its own id, never by (staff_id, workspace_id).
     */
    async rememberMembership(staffId, workspaceId) {
      const { rows } = await db.query(
        `select id, is_active, ended_at from public.staff_workspaces
          where staff_id = $1 and workspace_id = $2`, [staffId, workspaceId]);
      membershipSnapshots.push({
        staffId, workspaceId,
        before: rows.map((r) => ({ id: r.id, isActive: r.is_active, endedAt: r.ended_at })),
      });
      return rows.length > 0;
    },

    /** The same snapshot-and-restore for a weekday's working hours, when the
     *  test changes them through `set_staff_working_hours`. */
    async rememberWorkingHours(staffId, dayOfWeek) {
      const { rows } = await db.query(
        `select id, staff_id, day_of_week, start_time, end_time
           from public.staff_working_hours where staff_id = $1 and day_of_week = $2`,
        [staffId, dayOfWeek]);
      workingHourSnapshots.push({ staffId, dayOfWeek, before: rows });
      return rows.length > 0;
    },

    /**
     * Undo one membership NOW rather than at teardown.
     *
     * A temporary membership left in place gives a staff member a second
     * eligible workspace for every later block, which turns the normal
     * one-tap assignment into the "Which team?" exception and makes later
     * checks fail for a reason that has nothing to do with them.
     */
    async restoreMembership(staffId, workspaceId) {
      const index = changedMemberships.findIndex((c) => c.staffId === staffId && c.workspaceId === workspaceId);
      if (index !== -1) {
        const m = changedMemberships[index];
        await db.query(
          `update public.staff_workspaces set is_active = $2, ended_at = $3 where id = $1`,
          [m.id, m.isActive, m.endedAt]);
        changedMemberships.splice(index, 1);
        return;
      }
      for (const id of [...insertedMemberships]) {
        const { rows } = await db.query(
          `select id from public.staff_workspaces
            where id = $1 and staff_id = $2 and workspace_id = $3`, [id, staffId, workspaceId]);
        if (rows.length) {
          await db.query(`delete from public.staff_workspaces where id = $1`, [id]);
          insertedMemberships.delete(id);
        }
      }
    },

    /** A far-future date on which `staffId` has no appointment at all, never
     *  reused within a run. Keeps suites independent of existing data. */
    async freeDate(staffId, { dayOfWeek = null, offsetDays = 500 } = {}) {
      for (let k = offsetDays; k < offsetDays + 900; k++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + k);
        if (dayOfWeek !== null && d.getUTCDay() !== dayOfWeek) continue;
        const iso = d.toISOString().slice(0, 10);
        if (usedDates.has(iso)) continue;
        const { rows } = await db.query(
          `select count(*)::int n from public.appointments where staff_id = $1 and appt_date = $2`,
          [staffId, iso]);
        if (rows[0].n === 0) { usedDates.add(iso); return iso; }
      }
      throw new Error('no free date available for fixture');
    },

    /** A date on which EVERY listed staff member is free — for suites that book
     *  several people on one date. */
    async freeDateForAll(staffIds, { offsetDays = 1 } = {}) {
      for (let k = offsetDays; k < offsetDays + 900; k++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + k);
        const iso = d.toISOString().slice(0, 10);
        if (usedDates.has(iso)) continue;
        const { rows } = await db.query(
          `select count(*)::int n from public.appointments
            where appt_date = $1 and status = 'booked' and staff_id = any($2::uuid[])`,
          [iso, staffIds]);
        if (rows[0].n === 0) { usedDates.add(iso); return iso; }
      }
      throw new Error('no date found on which every requested staff member is free');
    },

    /** The nearest PAST date on which `staffId` has nothing booked. */
    async freePastDate(staffId, { offsetDays = 1 } = {}) {
      for (let k = offsetDays; k < offsetDays + 900; k++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - k);
        const iso = d.toISOString().slice(0, 10);
        if (usedDates.has(iso)) continue;
        const { rows } = await db.query(
          `select count(*)::int n from public.appointments
            where staff_id = $1 and appt_date = $2 and status = 'booked'`, [staffId, iso]);
        if (rows[0].n === 0) { usedDates.add(iso); return iso; }
      }
      throw new Error('no free past date available for fixture');
    },

    /** Server-computed columns, for assertions the API does not expose. */
    async appointment(id) {
      const { rows } = await db.query(`select * from public.appointments where id = $1`, [id]);
      return rows[0];
    },
    async query(sql, params) { return (await db.query(sql, params)).rows; },

    /**
     * Remove exactly what this run created, and restore exactly what it
     * displaced. Every statement below is keyed on a captured primary key, or
     * derived from one — there is no predicate over user-supplied content.
     */
    async cleanup() {
      const ids = [...appointments];
      if (ids.length) {
        // Children first: overrides have no ON DELETE CASCADE on
        // conflicting_appointment_id. All three are derived from ids this run
        // owns, so none can reach an appointment it did not create.
        await db.query(`delete from public.appointment_rule_overrides
                        where subject_appointment_id = any($1::uuid[])
                           or conflicting_appointment_id = any($1::uuid[])`, [ids]);
        await db.query(`delete from public.audit_logs where entity_id = any($1::uuid[])`, [ids]);
        await db.query(`delete from public.appointment_items where appointment_id = any($1::uuid[])`, [ids]);
        await db.query(`delete from public.appointments where id = any($1::uuid[])`, [ids]);
      }
      if (timeOff.size) {
        await db.query(`delete from public.staff_time_off where id = any($1::uuid[])`, [[...timeOff]]);
      }
      if (insertedSlots.size) {
        await db.query(`delete from public.suggested_time_slots where id = any($1::uuid[])`,
          [[...insertedSlots]]);
      }
      if (insertedWorkingHours.size) {
        await db.query(`delete from public.staff_working_hours where id = any($1::uuid[])`,
          [[...insertedWorkingHours]]);
      }
      // Put back what was displaced, newest first so a later change is undone
      // before the earlier one it replaced.
      for (const row of [...removedWorkingHours].reverse()) {
        await db.query(
          `insert into public.staff_working_hours (id, staff_id, day_of_week, start_time, end_time)
           values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
          [row.id, row.staff_id, row.day_of_week, row.start_time, row.end_time]);
      }
      if (insertedMemberships.size) {
        await db.query(`delete from public.staff_workspaces where id = any($1::uuid[])`,
          [[...insertedMemberships]]);
      }
      for (const m of [...changedMemberships].reverse()) {
        await db.query(
          `update public.staff_workspaces set is_active = $2, ended_at = $3 where id = $1`,
          [m.id, m.isActive, m.endedAt]);
      }

      // Snapshot restores. A row that was absent when the snapshot was taken
      // and is present now was created by this run, so it is removed BY ITS OWN
      // ID. Rows that existed before are put back exactly as they were.
      for (const snap of [...membershipSnapshots].reverse()) {
        const knownIds = snap.before.map((b) => b.id);
        const { rows: now } = await db.query(
          `select id from public.staff_workspaces where staff_id = $1 and workspace_id = $2`,
          [snap.staffId, snap.workspaceId]);
        const appeared = now.map((r) => r.id).filter((id) => !knownIds.includes(id));
        if (appeared.length) {
          await db.query(`delete from public.staff_workspaces where id = any($1::uuid[])`, [appeared]);
        }
        for (const b of snap.before) {
          await db.query(
            `update public.staff_workspaces set is_active = $2, ended_at = $3 where id = $1`,
            [b.id, b.isActive, b.endedAt]);
        }
      }
      for (const snap of [...workingHourSnapshots].reverse()) {
        const knownIds = snap.before.map((b) => b.id);
        const { rows: now } = await db.query(
          `select id from public.staff_working_hours where staff_id = $1 and day_of_week = $2`,
          [snap.staffId, snap.dayOfWeek]);
        const appeared = now.map((r) => r.id).filter((id) => !knownIds.includes(id));
        if (appeared.length) {
          await db.query(`delete from public.staff_working_hours where id = any($1::uuid[])`, [appeared]);
        }
        for (const b of snap.before) {
          await db.query(
            `insert into public.staff_working_hours (id, staff_id, day_of_week, start_time, end_time)
             values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
            [b.id, b.staff_id, b.day_of_week, b.start_time, b.end_time]);
        }
      }
      return {
        appointments: ids.length, timeOff: timeOff.size,
        workingHours: insertedWorkingHours.size + removedWorkingHours.length,
        memberships: insertedMemberships.size + changedMemberships.length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// booking helpers — synthetic customer data only, never real customer details
// ---------------------------------------------------------------------------
export const SYNTHETIC_CUSTOMER = {
  p_customer_name: 'TEST CUSTOMER A',
  p_customer_phone: '+60000000001',
  p_address_line: 'TEST ADDRESS A',
  p_area_city: 'TEST CITY',
};
export const SYNTHETIC_PRIVATE_CUSTOMER = {
  p_customer_name: 'TEST PRIVATE CUSTOMER Z',
  p_customer_phone: '+60000009999',
  p_address_line: 'TEST PRIVATE ADDRESS Z',
  p_area_city: 'TEST PRIVATE CITY',
};

export const items = amount => [{ description: 'TEST SERVICE', quantity: 1, unit_price: amount }];

export function bookingArgs({ ws, staff, date, time, amount, override = null, durationOverride = null,
                              customer = SYNTHETIC_CUSTOMER, remarks = 'REGRESSION FIXTURE' }) {
  return {
    p_workspace_id: ws, p_staff_id: staff, ...customer,
    p_appt_date: date, p_start_time: time, p_items: items(amount),
    p_final_duration_override_min: durationOverride, p_remarks: remarks,
    p_large_job_override_reason: override,
  };
}

/** Create through the real RPC and register the result for teardown. */
export async function book(fx, token, args) {
  const r = await rpc('create_appointment', token, args);
  if (r.ok) fx.track(r.body);
  return r;
}

// ---------------------------------------------------------------------------
// suite runner
// ---------------------------------------------------------------------------
export async function runSuite(suiteName, body) {
  assertDevProject();
  const db = await adminClient();
  const ids = await resolveIdentities(db);
  const fx = createFixture(db);
  const rec = createRecorder(suiteName);
  let summary;
  let appointmentsBefore = 0;
  try {
    // Isolation is asserted, not assumed. Fixture rows left behind by an
    // earlier suite would otherwise show up as overlaps and availability gaps
    // inside this one, and the failure would point anywhere but the cause.
    // The total row count is recorded, NOT asserted to be zero. The owner uses
    // DEV, so unrelated appointments are expected to be present and must not
    // make a suite fail. What matters is the delta this run leaves behind,
    // checked as ISO-02.
    const { rows: before } = await db.query(
      `select count(*)::int n from public.appointments`);
    appointmentsBefore = before[0].n;
    rec.check({
      id: 'ISO-01 suite starts with a known row count', actor: 'harness', setup: '-',
      action: 'count all appointments before running',
      expected: 'any number — manual bookings may legitimately exist',
      actual: `${appointmentsBefore} row(s) present`, ok: true,
    });

    const T = await signInAll(ids);
    await body({ db, ids, fx, rec, T });
  } catch (error) {
    // Record the crash as a failed check. Without this a suite that died before
    // its first assertion printed "0 PASS / 0 FAIL", which reads like a pass at
    // a glance — exactly how an auth rate-limit outage nearly went unnoticed.
    rec.check({
      id: 'SUITE CRASHED before completing', actor: 'harness', setup: '-',
      action: 'run the suite body',
      expected: 'the suite runs to completion',
      actual: String(error?.message ?? error).split('\n')[0],
      ok: false,
    });
  } finally {
    const removed = await fx.cleanup();
    console.log(`fixture cleanup: ${removed.appointments} appointments, ${removed.timeOff} time-off, ` +
      `${removed.workingHours} working-hours overrides, ${removed.memberships} membership changes`);

    // Teardown is verified rather than trusted — including after a crash,
    // which is exactly when a suite is most likely to leave rows behind.
    // Two properties, both about THIS run's footprint:
    //   1. every id it created is gone
    //   2. the table is back to the size it started at — so nothing it did not
    //      own was removed either
    const owned = fx.ownedAppointmentIds();
    const survivors = owned.length
      ? (await db.query(
          `select count(*)::int n from public.appointments where id = any($1::uuid[])`, [owned])).rows
      : [{ n: 0 }];
    const { rows: after } = await db.query(
      `select count(*)::int n from public.appointments`);
    rec.check({
      id: 'ISO-02 suite removed exactly what it created', actor: 'harness', setup: '-',
      action: 'check its own ids are gone and the table is back to its starting size',
      expected: `0 of its own rows left, and ${appointmentsBefore} rows present as before`,
      actual: `${survivors[0].n} own row(s) left, table now ${after[0].n} (was ${appointmentsBefore})`,
      ok: survivors[0].n === 0 && after[0].n === appointmentsBefore,
    });

    summary = rec.summary();
    await db.end();
  }
  return summary;
}
