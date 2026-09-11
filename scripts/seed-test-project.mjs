// Seed the TEST project: five synthetic identities and the fixture model the
// suites expect.
//
// Auth users are created through the SUPPORTED Auth Admin API —
// `supabase.auth.admin.createUser` — and never by writing to auth.users,
// auth.identities, or any other Auth-managed table. Those tables carry hashing
// and identity-linkage invariants that belong to GoTrue; a hand-written row
// that satisfies the column constraints can still be an account that cannot log
// in, or worse, one that can log in when it should not.
//
// There is deliberately NO SQL fallback. If Auth Admin refuses, this stops and
// says so. "It failed, so I did it the unsupported way" is how a test harness
// ends up being the thing that broke production.
//
// The application-level rows (profiles, staff, workspaces, memberships) are
// ordinary product tables and are written over the direct connection, keyed to
// the auth user ids that Auth Admin returned.
//
// Idempotent: run it again and it fills in what is missing, touching nothing
// that is already correct.
//
// Run: npm run db:seed-test

import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import {
  loadEnvLocal, resolveTestTarget, assertWipeTarget, requireTestSecretKey,
  missingTestEnv, DEV_PROJECT_REF,
} from '../supabase/tests/lib/target.mjs';
import {
  IDENTITIES, WORKSPACES, BUSINESS_SETTINGS, SUGGESTED_TIME_SLOTS,
} from '../supabase/tests/lib/identities.mjs';

loadEnvLocal();

const missing = missingTestEnv();
if (missing.length) {
  console.error(`\nCannot seed TEST: missing ${missing.join(', ')} in .env.local.`);
  process.exit(2);
}

// Seeding establishes a baseline, so it needs the narrower authority: test-safe
// AND wipeable. DEV is on neither list.
const ref = assertWipeTarget();
if (ref === DEV_PROJECT_REF) {
  console.error('\nRefusing: this resolved to DEV.');
  process.exit(2);
}

const target = resolveTestTarget();
const password = target.identityPassword;

// ---------------------------------------------------------------------------
// Auth Admin — the only supported way to create these accounts
// ---------------------------------------------------------------------------

const admin = createClient(target.url, requireTestSecretKey(), {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Existing auth users by lowercased email. Paginated; the list is tiny. */
async function existingUsers() {
  const byEmail = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error(`\nAuth Admin listUsers failed: ${error.message}`);
      process.exit(1);
    }
    for (const u of data.users) byEmail.set((u.email || '').toLowerCase(), u);
    if (data.users.length < 200) return byEmail;
  }
}

console.log(`TEST project ${ref}\n`);
console.log('Auth identities (Auth Admin API):');

const present = await existingUsers();
const authIds = {};

for (const id of IDENTITIES) {
  const found = present.get(id.email.toLowerCase());
  if (found) {
    authIds[id.key] = found.id;
    console.log(`  exists  ${id.fullName}`);
    continue;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: id.email,
    password,
    email_confirm: true,             // synthetic account; no mailbox exists to confirm from
    user_metadata: { full_name: id.fullName },
  });
  if (error || !data?.user?.id) {
    console.error(`\nAuth Admin createUser failed for ${id.fullName}: ${error?.message ?? 'no user returned'}\n` +
      `\nStopping. This script does not fall back to writing auth-schema tables directly.`);
    process.exit(1);
  }
  authIds[id.key] = data.user.id;
  console.log(`  created ${id.fullName}`);
}

// ---------------------------------------------------------------------------
// application-level fixtures
// ---------------------------------------------------------------------------

const db = new pg.Client({
  host: target.dbHost, port: 5432, user: target.dbUser,
  password: target.dbPassword, database: 'postgres',
  ssl: { rejectUnauthorized: false },
});
await db.connect();
const q = async (sql, p) => (await db.query(sql, p)).rows;

try {
  await db.query('begin');

  // --- workspaces, by slug ---
  const wsId = {};
  for (const w of WORKSPACES) {
    const hit = await q(`select id from public.workspaces where slug = $1`, [w.slug]);
    wsId[w.key] = hit.length
      ? hit[0].id
      : (await q(`insert into public.workspaces (name, slug) values ($1, $2) returning id`,
          [w.name, w.slug]))[0].id;
  }

  // --- profiles, keyed to the auth user id ---
  for (const id of IDENTITIES) {
    await db.query(
      `insert into public.profiles (id, full_name, role, is_active)
       values ($1, $2, $3::user_role, true)
       on conflict (id) do update set full_name = excluded.full_name, role = excluded.role`,
      [authIds[id.key], id.fullName, id.role]);
  }

  // --- who masters which workspace ---
  for (const id of IDENTITIES) {
    for (const key of id.masters) {
      const hit = await q(
        `select 1 from public.workspace_masters where workspace_id = $1 and profile_id = $2`,
        [wsId[key], authIds[id.key]]);
      if (!hit.length) {
        await db.query(
          `insert into public.workspace_masters (workspace_id, profile_id) values ($1, $2)`,
          [wsId[key], authIds[id.key]]);
      }
    }
  }

  // --- bookable staff ---
  const staffId = {};
  for (const id of IDENTITIES.filter((i) => i.staff)) {
    const hit = await q(`select id from public.staff where profile_id = $1`, [authIds[id.key]]);
    staffId[id.key] = hit.length
      ? hit[0].id
      : (await q(
          `insert into public.staff (profile_id, display_name, is_active) values ($1, $2, true) returning id`,
          [authIds[id.key], id.fullName]))[0].id;
  }

  // --- memberships ---
  //
  // staff_workspaces is a HISTORY table: no unique (staff, workspace) key, so a
  // blind insert accumulates duplicates run after run. Insert only when there is
  // no ACTIVE row already.
  for (const id of IDENTITIES.filter((i) => i.staff)) {
    for (const key of id.memberOf) {
      const hit = await q(
        `select 1 from public.staff_workspaces
          where staff_id = $1 and workspace_id = $2 and is_active`,
        [staffId[id.key], wsId[key]]);
      if (!hit.length) {
        await db.query(
          `insert into public.staff_workspaces (staff_id, workspace_id, is_active)
           values ($1, $2, true)`,
          [staffId[id.key], wsId[key]]);
      }
    }
  }

  // --- singleton business settings ---
  const cols = Object.keys(BUSINESS_SETTINGS);
  await db.query(
    `insert into public.business_settings (id, ${cols.join(', ')})
     values (true, ${cols.map((_, i) => `$${i + 1}`).join(', ')})
     on conflict (id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    cols.map((c) => BUSINESS_SETTINGS[c]));

  // --- company-wide suggested times ---
  for (const slot of SUGGESTED_TIME_SLOTS) {
    const hit = await q(
      `select 1 from public.suggested_time_slots where workspace_id is null and slot_time = $1`,
      [slot.slot_time]);
    if (!hit.length) {
      await db.query(
        `insert into public.suggested_time_slots (workspace_id, slot_time, sort_order, is_active)
         values (null, $1, $2, true)`,
        [slot.slot_time, slot.sort_order]);
    }
  }

  await db.query('commit');

  // ---- report the baseline ----
  console.log('\nFixture model:');
  console.table(await q(`
    select p.full_name, p.role::text as role,
           (s.id is not null) as bookable,
           coalesce(string_agg(distinct wm.name, ', '), '-') as masters,
           coalesce(string_agg(distinct mw.name, ', '), '-') as member_of
      from public.profiles p
      left join public.staff s on s.profile_id = p.id
      left join public.workspace_masters m on m.profile_id = p.id
      left join public.workspaces wm on wm.id = m.workspace_id
      left join public.staff_workspaces sw on sw.staff_id = s.id and sw.is_active
      left join public.workspaces mw on mw.id = sw.workspace_id
     group by p.full_name, p.role, s.id
     order by p.full_name`));

  const counts = (await q(`
    select (select count(*) from public.profiles)::int                            as profiles,
           (select count(*) from public.staff)::int                               as staff,
           (select count(*) from public.workspaces)::int                          as workspaces,
           (select count(*) from public.workspace_masters)::int                   as masters,
           (select count(*) from public.staff_workspaces where is_active)::int    as memberships,
           (select count(*) from public.business_settings)::int                   as settings,
           (select count(*) from public.suggested_time_slots)::int                as slots,
           (select count(*) from public.appointments)::int                        as appointments`))[0];
  console.table(counts);

  // The privacy property, asserted rather than assumed.
  const leak = await q(`
    select 1
      from public.staff_workspaces sw
      join public.staff s on s.id = sw.staff_id
      join public.profiles p on p.id = s.profile_id
      join public.workspaces w on w.id = sw.workspace_id
     where p.full_name = 'TEST_VICTOR' and w.slug = 'shared-team' and sw.is_active`);
  console.log(leak.length
    ? '\nWARNING: Victor is a member of Shared Team. Nick would be able to see him.'
    : '\nVictor is in KC Private Team only — Nick cannot see him.');
  if (leak.length) process.exitCode = 1;
} catch (e) {
  await db.query('rollback').catch(() => {});
  console.error('\nseed failed:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
