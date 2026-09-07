// DEV test-fixture maintenance. NOT a migration.
//
// Removes accumulated synthetic scheduling data from the DEV project and
// restores the baseline the regression suites expect. This is deliberately a
// script and not a migration: it manipulates test fixtures, never schema, and
// must never run against production.
//
// KEEPS   identities (5 profiles, 3 staff), both workspaces, the baseline
//         memberships, business_settings, suggested_time_slots, and the
//         company-default working hours (staff_id is null).
// CLEARS  appointments, appointment_items, appointment_rule_overrides,
//         appointment audit_logs, staff_time_off, staff-specific working-hours
//         rows, and Jack's temporary KC Private Team membership.
//
// Run: npm run db:reset-dev-fixtures

import { adminClient, assertDevProject, resolveIdentities } from './lib/harness.mjs';

assertDevProject();
const db = await adminClient();
const q = async (sql, params) => (await db.query(sql, params)).rows;

try {
  const ids = await resolveIdentities(db);

  const counts = async () => (await q(`
    select
      (select count(*) from public.profiles)::int                                        as profiles,
      (select count(*) from public.staff)::int                                           as staff,
      (select count(*) from public.workspaces)::int                                      as workspaces,
      (select count(*) from public.staff_workspaces where is_active)::int                as memberships,
      (select count(*) from public.appointments)::int                                    as appointments,
      (select count(*) from public.appointment_items)::int                               as items,
      (select count(*) from public.appointment_rule_overrides)::int                      as overrides,
      (select count(*) from public.audit_logs)::int                                      as audit,
      (select count(*) from public.staff_time_off)::int                                  as time_off,
      (select count(*) from public.staff_working_hours where staff_id is not null)::int  as staff_hours,
      (select count(*) from public.staff_working_hours where staff_id is null)::int      as default_hours,
      (select count(*) from public.business_settings)::int                               as settings,
      (select count(*) from public.suggested_time_slots)::int                            as slots
  `))[0];

  const before = await counts();
  console.log('BEFORE:');
  console.table(before);

  await db.query('begin');

  // FK-safe order. conflicting_appointment_id has no ON DELETE CASCADE, so the
  // override rows must go before the appointments they point at.
  const del = {};
  del.overrides = (await q(`delete from public.appointment_rule_overrides returning id`)).length;
  del.items = (await q(`delete from public.appointment_items returning id`)).length;
  del.audit = (await q(`delete from public.audit_logs where entity_type = 'appointment' returning id`)).length;
  del.appointments = (await q(`delete from public.appointments returning id`)).length;
  del.timeOff = (await q(`delete from public.staff_time_off returning id`)).length;
  del.staffHours = (await q(`delete from public.staff_working_hours where staff_id is not null returning id`)).length;

  // Restore the baseline: Jack is Shared Team only. His KC Private Team
  // membership existed solely for cross-workspace QA; the privacy suite now
  // creates and removes its own.
  del.jackPrivate = (await q(
    `delete from public.staff_workspaces where staff_id = $1 and workspace_id = $2 returning id`,
    [ids.staff.jack, ids.ws.private])).length;

  await db.query('commit');
  console.log('\nDELETED:');
  console.table(del);

  // ---- verify the baseline ----
  const after = await counts();
  console.log('\nAFTER:');
  console.table(after);

  const memberships = await q(`
    select s.display_name as staff, w.name as workspace, sw.is_active
    from public.staff_workspaces sw
    join public.staff s on s.id = sw.staff_id
    join public.workspaces w on w.id = sw.workspace_id
    order by w.name, s.display_name`);
  console.log('\nMEMBERSHIPS:');
  console.table(memberships);

  const expected = [
    ['profiles = 5', after.profiles === 5],
    ['staff = 3', after.staff === 3],
    ['workspaces = 2', after.workspaces === 2],
    ['active memberships = 3', after.memberships === 3],
    ['appointments = 0', after.appointments === 0],
    ['appointment_items = 0', after.items === 0],
    ['rule overrides = 0', after.overrides === 0],
    ['appointment audit_logs = 0', after.audit === 0],
    ['time off = 0', after.time_off === 0],
    ['staff-specific working hours = 0', after.staff_hours === 0],
    ['business_settings intact', after.settings === 1],
    ['suggested_time_slots intact', after.slots > 0],
    ['company default hours intact', after.default_hours >= 0],
    ['Jack -> Shared Team only', memberships.filter(m => m.staff === 'TEST_JACK' && m.is_active)
      .every(m => m.workspace === 'Shared Team')],
    ['Dyron -> Shared Team', memberships.some(m => m.staff === 'TEST_DYRON' && m.workspace === 'Shared Team' && m.is_active)],
    ['Victor -> KC Private Team', memberships.some(m => m.staff === 'TEST_VICTOR' && m.workspace === 'KC Private Team' && m.is_active)],
    ['Victor NOT in Shared Team', !memberships.some(m => m.staff === 'TEST_VICTOR' && m.workspace === 'Shared Team' && m.is_active)],
  ];

  console.log('\nBASELINE VERIFICATION:');
  let bad = 0;
  for (const [label, ok] of expected) {
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`);
  }
  console.log(bad === 0 ? '\nClean baseline confirmed.' : `\n${bad} baseline check(s) FAILED.`);
  process.exitCode = bad === 0 ? 0 : 1;
} catch (e) {
  try { await db.query('rollback'); } catch {}
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
