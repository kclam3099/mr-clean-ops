// Read-only diagnostics for DEV.
//
// DEV holds the owner's real operational data. Looking at it is legitimate;
// doing so through the destructive test harness is not. This is the separate
// non-destructive workflow: it connects through a session postgres itself
// refuses writes on (see scripts/lib/readonly-db.mjs), so it cannot reset,
// delete, alter a membership, alter working hours, alter time off, or create a
// fixture — not by policy, by the database.
//
//   npm run dev:inspect                     a summary of what DEV contains
//   npm run dev:inspect -- --appointments   upcoming appointments (ids + shape)
//   npm run dev:inspect -- --config         memberships, working hours, time off
//   npm run dev:inspect -- --sql "select …" one ad-hoc read
//   npm run dev:inspect -- --snapshot FILE  record every appointment's fingerprint
//   npm run dev:inspect -- --verify FILE    prove none of them changed
//
// --snapshot / --verify are the DEV protection acceptance test: take a snapshot,
// run the whole automated suite against TEST, verify. Any difference at all —
// a missing id, a changed field — is a failure.
//
// Customer details are never printed. Rows are identified by id and by a hash
// of their contents, which is what the acceptance test actually needs.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadEnvLocal, resolveDevTarget, projectRef, DEV_PROJECT_REF } from '../supabase/tests/lib/target.mjs';
import { readOnlyClient } from './lib/readonly-db.mjs';

loadEnvLocal();

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const target = resolveDevTarget();
const ref = projectRef(target.url);
if (ref !== DEV_PROJECT_REF) {
  console.error(`\nThis tool inspects DEV (${DEV_PROJECT_REF}); the environment resolves to ${ref ?? 'nothing'}.`);
  process.exit(2);
}

const db = await readOnlyClient(target, 'DEV');
const q = async (sql, p) => (await db.query(sql, p)).rows;

/** A stable fingerprint of a row: same bytes in, same hash out. */
const fingerprint = (row) =>
  createHash('sha256').update(JSON.stringify(
    Object.keys(row).sort().map((k) => [k, row[k] instanceof Date ? row[k].toISOString() : row[k]]),
  )).digest('hex').slice(0, 16);

/** Every appointment, as id → fingerprint, plus its items. */
async function appointmentFingerprints() {
  const rows = await q(`select * from public.appointments order by id`);
  const items = await q(`select * from public.appointment_items order by appointment_id, id`);
  const byAppt = new Map();
  for (const it of items) {
    const list = byAppt.get(it.appointment_id) ?? [];
    list.push(fingerprint(it));
    byAppt.set(it.appointment_id, list);
  }
  const out = {};
  for (const r of rows) {
    out[r.id] = { row: fingerprint(r), items: (byAppt.get(r.id) ?? []).join(',') };
  }
  return out;
}

try {
  // ---- snapshot / verify -------------------------------------------------
  const snapshotPath = value('--snapshot');
  const verifyPath = value('--verify');

  if (snapshotPath) {
    const data = await appointmentFingerprints();
    writeFileSync(snapshotPath, JSON.stringify({
      project: ref, takenAt: new Date().toISOString(), appointments: data,
    }, null, 2));
    console.log(`Snapshot of ${Object.keys(data).length} appointment(s) in DEV (${ref}) written to ${snapshotPath}`);
    process.exit(0);
  }

  if (verifyPath) {
    const prior = JSON.parse(readFileSync(verifyPath, 'utf8'));
    if (prior.project !== ref) {
      console.error(`\nSnapshot was taken against ${prior.project}, this is ${ref}. Refusing to compare.`);
      process.exit(2);
    }
    const now = await appointmentFingerprints();
    const before = Object.keys(prior.appointments), after = Object.keys(now);

    const missing = before.filter((id) => !(id in now));
    const changed = before.filter((id) => id in now && (
      now[id].row !== prior.appointments[id].row ||
      now[id].items !== prior.appointments[id].items));
    const added = after.filter((id) => !(id in prior.appointments));

    console.log(`DEV (${ref}) — snapshot taken ${prior.takenAt}`);
    console.log(`  before : ${before.length} appointment(s)`);
    console.log(`  now    : ${after.length} appointment(s)`);
    console.log(`  missing: ${missing.length}${missing.length ? ` -> ${missing.join(', ')}` : ''}`);
    console.log(`  changed: ${changed.length}${changed.length ? ` -> ${changed.join(', ')}` : ''}`);
    console.log(`  added  : ${added.length}${added.length ? ` -> ${added.join(', ')}` : ''}`);

    const ok = !missing.length && !changed.length && !added.length;
    console.log(ok
      ? '\nDEV UNTOUCHED — every appointment is present and byte-for-byte identical.'
      : '\nDEV CHANGED — something wrote to DEV between the snapshot and now.');
    process.exit(ok ? 0 : 1);
  }

  // ---- ad-hoc read -------------------------------------------------------
  const sql = value('--sql');
  if (sql) {
    console.table(await q(sql));
    process.exit(0);
  }

  // ---- views -------------------------------------------------------------
  const wantAppointments = flag('--appointments');
  const wantConfig = flag('--config');
  const summaryOnly = !wantAppointments && !wantConfig;

  if (summaryOnly || wantAppointments || wantConfig) {
    console.log(`DEV project ${ref} — read-only\n`);
    console.table((await q(`
      select
        (select count(*) from public.appointments)::int                                   as appointments,
        (select count(*) from public.appointment_items)::int                              as items,
        (select count(*) from public.staff_time_off)::int                                 as time_off,
        (select count(*) from public.staff_working_hours where staff_id is not null)::int as staff_hours,
        (select count(*) from public.staff_workspaces where is_active)::int               as memberships,
        (select count(*) from public.profiles)::int                                       as profiles,
        (select count(*) from public.staff)::int                                          as staff
    `))[0]);
  }

  if (wantAppointments) {
    console.log('\nAppointments (no customer details printed):');
    console.table(await q(`
      select a.id, a.appt_date, a.start_time, a.status::text as status,
             s.display_name as staff, w.name as workspace,
             (a.remarks is not null) as has_remarks,
             (select count(*) from public.appointment_items i where i.appointment_id = a.id)::int as items
        from public.appointments a
        left join public.staff s on s.id = a.staff_id
        left join public.workspaces w on w.id = a.workspace_id
       order by a.appt_date, a.start_time`));
  }

  if (wantConfig) {
    console.log('\nMemberships:');
    console.table(await q(`
      select s.display_name as staff, w.name as workspace, sw.is_active
        from public.staff_workspaces sw
        join public.staff s on s.id = sw.staff_id
        join public.workspaces w on w.id = sw.workspace_id
       order by w.name, s.display_name`));
    console.log('\nStaff-specific working hours:');
    console.table(await q(`
      select s.display_name as staff, h.day_of_week, h.start_time, h.end_time
        from public.staff_working_hours h
        join public.staff s on s.id = h.staff_id
       order by s.display_name, h.day_of_week`));
    console.log('\nTime off:');
    console.table(await q(`
      select s.display_name as staff, t.off_date, t.start_time, t.end_time
        from public.staff_time_off t
        join public.staff s on s.id = t.staff_id
       order by t.off_date, t.start_time`));
  }
} catch (e) {
  console.error('inspect failed:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
