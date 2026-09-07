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

// A guard against ever pointing these destructive fixtures at production.
export function assertDevProject() {
  const u = CONFIG.url();
  if (process.env.ALLOW_NON_DEV_TESTS === 'true') return;
  if (!/ozojfflkchltwqnbflso/.test(u)) {
    console.error(`\nRefusing to run: ${u} is not the known DEV project.\n` +
      `These suites create and DELETE rows. Set ALLOW_NON_DEV_TESTS=true only if you are certain.`);
    process.exit(2);
  }
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
// fixture tracker — everything a suite creates is registered here and removed
// in teardown, so no suite leaves scheduling data behind
// ---------------------------------------------------------------------------
export function createFixture(db) {
  const appointments = new Set();
  const timeOff = new Set();
  const workingHours = [];      // { staffId, dayOfWeek }
  const memberships = [];       // { staffId, workspaceId, restoreActive }
  const usedDates = new Set();
  const TAG = 'REGRESSION FIXTURE';

  return {
    TAG,
    track(id) { if (id) appointments.add(id); return id; },
    trackTimeOff(id) { if (id) timeOff.add(id); return id; },
    trackWorkingHours(staffId, dayOfWeek) { workingHours.push({ staffId, dayOfWeek }); },
    trackMembership(staffId, workspaceId, restoreActive) { memberships.push({ staffId, workspaceId, restoreActive }); },

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

    /**
     * Throw if `staffId` already has something booked on `date`.
     *
     * Suites that pick a date by fixed offset (`today + 70`) rather than via
     * freeDate() are only safe while nothing else occupies that slot. Today
     * the DEV baseline holds no appointments at all, so they are — but that is
     * a property of the current data, not of the test. This turns a future
     * collision into a clear failure at the point of setup instead of a
     * puzzling PHYSICAL_OVERLAP several assertions later.
     */
    async requireFree(staffId, date, label = '') {
      const { rows } = await db.query(
        `select count(*)::int n from public.appointments
          where staff_id = $1 and appt_date = $2 and status = 'booked'`, [staffId, date]);
      if (rows[0].n > 0) {
        throw new Error(
          `fixture date collision${label ? ` (${label})` : ''}: staff already has ` +
          `${rows[0].n} appointment(s) on ${date}. Reset the DEV baseline, or use fx.freeDate().`);
      }
      return date;
    },

    /** Server-computed columns, for assertions the API does not expose. */
    async appointment(id) {
      const { rows } = await db.query(`select * from public.appointments where id = $1`, [id]);
      return rows[0];
    },
    async query(sql, params) { return (await db.query(sql, params)).rows; },

    async cleanup() {
      const ids = [...appointments];
      if (ids.length) {
        // overrides first (conflicting_appointment_id has no ON DELETE CASCADE),
        // then the audit rows that reference these appointments, then the rows.
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
      for (const w of workingHours) {
        await db.query(`delete from public.staff_working_hours where staff_id = $1 and day_of_week = $2`,
          [w.staffId, w.dayOfWeek]);
      }
      for (const m of memberships) {
        if (m.restoreActive) {
          await db.query(`update public.staff_workspaces set is_active = true
                          where staff_id = $1 and workspace_id = $2`, [m.staffId, m.workspaceId]);
        } else {
          await db.query(`delete from public.staff_workspaces
                          where staff_id = $1 and workspace_id = $2`, [m.staffId, m.workspaceId]);
        }
      }
      // belt and braces: nothing tagged by this harness may survive a run
      await db.query(`delete from public.appointment_items where appointment_id in
                      (select id from public.appointments where remarks = $1)`, [TAG]);
      await db.query(`delete from public.appointment_rule_overrides where subject_appointment_id in
                      (select id from public.appointments where remarks = $1)`, [TAG]);
      await db.query(`delete from public.appointments where remarks = $1`, [TAG]);
      return {
        appointments: ids.length, timeOff: timeOff.size,
        workingHours: workingHours.length, memberships: memberships.length,
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
  try {
    // Isolation is asserted, not assumed. Fixture rows left behind by an
    // earlier suite would otherwise show up as overlaps and availability gaps
    // inside this one, and the failure would point anywhere but the cause.
    const { rows: before } = await db.query(
      `select count(*)::int n from public.appointments where remarks = $1`, [fx.TAG]);
    rec.check({
      id: 'ISO-01 suite starts isolated', actor: 'harness', setup: '-',
      action: 'count leftover fixture rows before running',
      expected: '0 — the previous suite cleaned up after itself',
      actual: `${before[0].n} row(s)`, ok: before[0].n === 0,
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
    const { rows: after } = await db.query(
      `select count(*)::int n from public.appointments where remarks = $1`, [fx.TAG]);
    rec.check({
      id: 'ISO-02 suite left nothing behind', actor: 'harness', setup: '-',
      action: 'count fixture rows after teardown',
      expected: '0 — the next suite must start from the same baseline this one did',
      actual: `${after[0].n} row(s)`, ok: after[0].n === 0,
    });

    summary = rec.summary();
    await db.end();
  }
  return summary;
}
