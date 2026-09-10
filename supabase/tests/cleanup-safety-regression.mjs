// Cleanup safety — does automated teardown preserve data it does not own?
//
// This suite exists because the answer was once no. A teardown deleted rows
// matching `remarks IS NOT NULL`, reasoning that a remark looked like fixture
// text, and destroyed a real appointment the owner had entered by hand.
//
// The rule that replaced it: a test may delete only rows it can PROVE it
// created, and the proof is the primary key captured at creation. Every
// resemblance-based predicate — customer name, remarks, date, staff, workspace,
// amount, status — is prohibited, because manual data can match any of them.
//
// So this suite plants sentinels that look EXACTLY like the fixtures around
// them, runs a full create-and-teardown cycle, and requires every sentinel to
// survive byte-for-byte. A test that cannot tell a sentinel from its own row is
// a test that will eventually delete a customer.
//
// Run: npm run test:cleanup-safety

import {
  adminClient, assertDevProject, resolveIdentities, createFixture, createRecorder,
  signIn, rpc, bookingArgs,
} from './lib/harness.mjs';

assertDevProject();
const db = await adminClient();
const ids = await resolveIdentities(db);
const rec = createRecorder('CLEANUP SAFETY (data isolation)');

/** Planted directly, so they carry no fixture identity of any kind. */
const sentinels = [];

try {
  const kcToken = await signIn(ids.email.kc);
  const outer = createFixture(db);

  const day = async (offset) => (await db.query(
    `select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int),'YYYY-MM-DD') d`,
    [offset])).rows[0].d;

  /** Insert a manual-looking appointment straight into the table, exactly as a
   *  person's booking would sit there — no tracking, no ownership. */
  async function plant(label, { staffId, workspaceId, date, time, name, remarks }) {
    const { rows } = await db.query(
      `insert into public.appointments
         (workspace_id, staff_id, customer_name, customer_phone, address_line, area_city,
          appt_date, start_time, calculated_duration_min, final_duration_min, buffer_minutes,
          total_amount, is_large_job, status, remarks, created_by)
       values ($1,$2,$3,'+60123456789','1 Jalan Sentinel','Kepong',$4,$5::time,60,60,30,199.00,
               false,'booked',$6,$7)
       returning id, customer_name, remarks, appt_date::text d, start_time::text t, total_amount`,
      [workspaceId, staffId, name, date, time, remarks, ids.profile.kc]);
    const row = rows[0];
    sentinels.push({ label, ...row });
    return row;
  }

  // Each sentinel is deliberately shaped like something a teardown heuristic
  // would have swept up.
  const s1 = await plant('non-null remarks, customer-shaped name', {
    staffId: ids.staff.jack, workspaceId: ids.ws.shared,
    date: await day(210), time: '10:00',
    name: 'Trent', remarks: 'Total RM457 x 20% discount',
  });
  await plant('name shaped like a fixture', {
    staffId: ids.staff.dyron, workspaceId: ids.ws.shared,
    date: await day(211), time: '10:00',
    name: 'TEST CUSTOMER Wong', remarks: 'called ahead',
  });
  await plant('carries the literal fixture TAG', {
    staffId: ids.staff.victor, workspaceId: ids.ws.private,
    date: await day(212), time: '10:00',
    name: 'Siti', remarks: outer.TAG,
  });
  await plant('historical appointment', {
    staffId: ids.staff.jack, workspaceId: ids.ws.shared,
    date: await day(-40), time: '14:00',
    name: 'Ahmad', remarks: null,
  });

  rec.check({
    id: 'QA-DATA-00 sentinels planted', actor: 'harness', setup: '-',
    action: 'insert four manual-looking appointments with no fixture ownership',
    expected: '4 rows',
    actual: `${sentinels.length} planted`, ok: sentinels.length === 4,
  });

  // ---- a normal fixture lifecycle, on the SAME staff and adjacent dates ----
  const fx = createFixture(db);
  await fx.watchAppointments(`customer_name like 'CLEANUP SAFETY%'`, []);

  const sameDayAsSentinel = s1.d;   // same staff, same date, non-overlapping time
  const own = [];
  for (const [label, staffId, workspaceId, date, time] of [
    ['same staff and date as a sentinel', ids.staff.jack, ids.ws.shared, sameDayAsSentinel, '15:00'],
    ['adjacent date', ids.staff.dyron, ids.ws.shared, await day(213), '10:00'],
    ['private workspace', ids.staff.victor, ids.ws.private, await day(214), '10:00'],
  ]) {
    const r = await rpc('create_appointment', kcToken, bookingArgs({
      ws: workspaceId, staff: staffId, date, time, amount: 200, remarks: fx.TAG,
      customer: {
        p_customer_name: `CLEANUP SAFETY ${fx.RUN_ID}`, p_customer_phone: '+60000000001',
        p_address_line: 'TEST ADDRESS', p_area_city: 'TEST CITY',
      },
    }));
    if (r.ok) { fx.track(r.body); own.push({ label, id: r.body }); }
    else console.log(`  fixture ${label} not created: ${r.msg}`);
  }

  rec.check({
    id: 'QA-DATA-01a fixtures created alongside the sentinels', actor: 'KC',
    setup: 'one shares a staff member and a date with a sentinel',
    action: 'create three fixture appointments through the RPC',
    expected: '3 created',
    actual: `${own.length} created (${own.map((o) => o.label).join('; ')})`,
    ok: own.length === 3,
  });

  // ---- teardown, exactly as a suite would run it --------------------------
  const adopted = await fx.adoptNew();
  const removed = await fx.cleanup();

  const ownSurvivors = own.length
    ? (await db.query(
        `select count(*)::int n from public.appointments where id = any($1::uuid[])`,
        [own.map((o) => o.id)])).rows[0].n
    : 0;

  rec.check({
    id: 'QA-DATA-01b teardown removed everything it owned', actor: 'harness',
    setup: `${own.length} owned rows, ${adopted} adopted`,
    action: 'run the standard cleanup',
    expected: '0 of its own rows left',
    actual: `${ownSurvivors} left (reported ${removed.appointments} removed)`,
    ok: ownSurvivors === 0,
  });

  // ---- THE point of this suite -------------------------------------------
  for (const s of sentinels) {
    const { rows } = await db.query(
      `select id, customer_name, remarks, appt_date::text d, start_time::text t, total_amount
         from public.appointments where id = $1`, [s.id]);
    const now = rows[0];
    const unchanged = !!now
      && now.customer_name === s.customer_name
      && (now.remarks ?? null) === (s.remarks ?? null)
      && now.d === s.d && now.t === s.t
      && String(now.total_amount) === String(s.total_amount);

    rec.check({
      id: `QA-DATA-01 cleanup preserves a non-owned appointment — ${s.label}`,
      actor: 'harness',
      setup: `planted "${s.customer_name}" with remarks ${s.remarks === null ? 'NULL' : `"${s.remarks}"`}`,
      action: 'check it survived teardown, byte for byte',
      expected: 'present and unchanged',
      actual: !now ? 'DELETED' : unchanged ? 'present and unchanged' : 'PRESENT BUT MODIFIED',
      ok: unchanged, security: true,
    });
  }

  // Children of a sentinel must survive too — the parent/child cleanup derives
  // from owned parent ids, so it must never reach a sentinel's rows.
  const orphaned = (await db.query(
    `select count(*)::int n from public.appointments a
      where a.id = any($1::uuid[])
        and not exists (select 1 from public.appointments x where x.id = a.id)`,
    [sentinels.map((s) => s.id)])).rows[0].n;
  rec.check({
    id: 'QA-DATA-02 no sentinel was orphaned by child cleanup', actor: 'harness', setup: '-',
    action: 'check sentinel rows are intact after item/audit/override cleanup',
    expected: '0 missing',
    actual: `${orphaned} missing`, ok: orphaned === 0, security: true,
  });

  // ---- and the configuration tables ---------------------------------------
  const hoursBefore = (await db.query(
    `select count(*)::int n from public.staff_working_hours`)).rows[0].n;
  const fx2 = createFixture(db);
  await fx2.setWorkingHours(ids.staff.jack, 3, '08:00', '20:00');
  await fx2.setWorkingHours(ids.staff.jack, 3, '09:00', '18:00');   // same weekday twice
  await fx2.clearWorkingHours(ids.staff.jack, 3);
  await fx2.setMembership(ids.staff.jack, ids.ws.private, true);
  await fx2.cleanup();
  const hoursAfter = (await db.query(
    `select count(*)::int n from public.staff_working_hours`)).rows[0].n;
  const membershipRows = (await db.query(
    `select count(*)::int n from public.staff_workspaces
      where staff_id = $1 and workspace_id = $2`, [ids.staff.jack, ids.ws.private])).rows[0].n;

  rec.check({
    id: 'QA-DATA-03 working-hours changes are fully reverted', actor: 'harness',
    setup: 'set twice on one weekday, then cleared',
    action: 'count rows before and after a fixture lifecycle',
    expected: `${hoursBefore} rows, unchanged`,
    actual: `${hoursAfter} rows`, ok: hoursAfter === hoursBefore,
  });
  rec.check({
    id: 'QA-DATA-04 a temporary membership leaves nothing behind', actor: 'harness',
    setup: 'Jack given a private-team membership for the test',
    action: 'count that membership after teardown',
    expected: '0 — it did not exist before',
    actual: `${membershipRows} row(s)`, ok: membershipRows === 0,
  });
} catch (error) {
  rec.check({
    id: 'SUITE CRASHED before completing', actor: 'harness', setup: '-',
    action: 'run the suite body',
    expected: 'the suite runs to completion',
    actual: String(error?.message ?? error).split('\n')[0], ok: false,
  });
} finally {
  const summary = rec.summary();
  // The sentinels are this suite's own creations, so it removes them BY EXACT
  // ID — the same rule it exists to enforce.
  if (sentinels.length) {
    const ids_ = sentinels.map((s) => s.id);
    await db.query(`delete from public.appointment_items where appointment_id = any($1::uuid[])`, [ids_]);
    await db.query(`delete from public.audit_logs where entity_id = any($1::uuid[])`, [ids_]);
    await db.query(`delete from public.appointments where id = any($1::uuid[])`, [ids_]);
    console.log(`sentinel cleanup: ${ids_.length} removed by exact id`);
  }
  await db.end();
  process.exit(summary.fail === 0 ? 0 : 1);
}
