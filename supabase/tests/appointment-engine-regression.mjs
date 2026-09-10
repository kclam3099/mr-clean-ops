// Appointment engine regression suite.
//
// Locks in the scheduling rules proven in Stage 3B against migrations
// 0001-0005. Everything here is single-workspace; cross-workspace privacy
// lives in cross-workspace-privacy-regression.mjs.
//
//   - RM/hour duration + 30-minute buffer
//   - RM600 large-job forward lock, and the reverse case
//   - per-exception override (an override must never disable the rule)
//   - physical overlap is never overridable, by anyone
//   - staff self-booking and workspace derivation
//   - item/amount recalculation drives duration and large-job classification
//   - terminal statuses (completed / cancelled) are final
//   - time off
//   - working hours, company default and staff-specific
//   - genuine concurrent double-booking
//
// Run: npm run test:engine

import { runSuite, rpc, book, bookingArgs, items } from './lib/harness.mjs';

const summary = await runSuite('APPOINTMENT ENGINE REGRESSION', async ({ ids, fx, rec, T }) => {
  const shared = ids.ws.shared;
  const jack = ids.staff.jack;

  // ==========================================================================
  // A. Duration and the 30-minute buffer
  // ==========================================================================
  const settings = (await fx.query(
    `select rm_per_hour_rate, default_buffer_minutes, full_day_lock_threshold,
            default_day_start, default_day_end from public.business_settings`))[0];
  rec.check({
    id: 'ENG-A0 business settings intact', actor: 'db', setup: 'bootstrap config',
    action: 'read business_settings',
    expected: 'rate, buffer and threshold configured',
    actual: `rate=${settings.rm_per_hour_rate}/h buffer=${settings.default_buffer_minutes}m threshold=RM${settings.full_day_lock_threshold} day=${settings.default_day_start}-${settings.default_day_end}`,
    ok: Number(settings.default_buffer_minutes) === 30 && Number(settings.full_day_lock_threshold) === 600,
  });

  const dA = await fx.freeDate(jack);
  const a1 = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dA, time: '10:00', amount: 200 }));
  const a1row = a1.ok ? await fx.appointment(a1.body) : null;
  rec.check({
    id: 'ENG-A1 RM200 -> 60min + 30min buffer', actor: 'KC', setup: 'empty day',
    action: 'create 10:00 RM200',
    expected: 'duration 60, buffer 30, occupies 10:00-11:30',
    actual: a1.ok ? `dur=${a1row.calculated_duration_min} buf=${a1row.buffer_minutes} range=${a1row.occupied_range}` : a1.msg,
    ok: a1.ok && a1row.calculated_duration_min === 60 && a1row.buffer_minutes === 30,
  });

  for (const [time, allowed] of [['11:00', false], ['11:29', false], ['11:30', true]]) {
    const r = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dA, time, amount: 200 }));
    rec.check({
      id: `ENG-A2 buffer boundary ${time}`, actor: 'KC', setup: 'RM200 job occupies 10:00-11:30',
      action: `create ${time} RM200`, expected: allowed ? 'ALLOWED (buffer has elapsed)' : 'REJECT (inside buffer)',
      actual: r.ok ? 'created' : r.msg, ok: r.ok === allowed,
    });
  }

  const dA4 = await fx.freeDate(jack);
  await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dA4, time: '10:00', amount: 400 }));
  for (const [time, allowed] of [['12:00', false], ['12:30', true]]) {
    const r = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dA4, time, amount: 200 }));
    rec.check({
      id: `ENG-A3 RM400 boundary ${time}`, actor: 'KC', setup: 'RM400 job occupies 10:00-12:30 (120m + 30m)',
      action: `create ${time} RM200`, expected: allowed ? 'ALLOWED' : 'REJECT',
      actual: r.ok ? 'created' : r.msg, ok: r.ok === allowed,
    });
  }

  // ==========================================================================
  // B. RM600 forward lock
  // ==========================================================================
  const dB = await fx.freeDate(jack);
  await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dB, time: '15:00', amount: 700 }));
  const earlier = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dB, time: '10:00', amount: 200 }));
  rec.check({
    id: 'ENG-B1 forward lock does not block EARLIER slots', actor: 'KC',
    setup: 'RM700 large job at 15:00', action: 'create 10:00 RM200 (finishes before 15:00)',
    expected: 'ALLOWED — the lock runs forward, not backward',
    actual: earlier.ok ? 'created' : earlier.msg, ok: earlier.ok,
  });

  const dB2 = await fx.freeDate(jack);
  await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dB2, time: '10:00', amount: 800 }));
  const later = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dB2, time: '15:00', amount: 200 }));
  rec.check({
    id: 'ENG-B2 forward lock blocks LATER slots', actor: 'KC', setup: 'RM800 large job at 10:00',
    action: 'create 15:00 RM200 without an override', expected: 'REJECT',
    actual: later.ok ? 'CREATED' : later.msg,
    ok: !later.ok && /LARGE_JOB_OVERRIDE_REQUIRED/.test(later.msg),
  });

  const withOverride = await book(fx, T.nick, bookingArgs({
    ws: shared, staff: jack, date: dB2, time: '15:00', amount: 200,
    override: 'REGRESSION: nearby easy job',
  }));
  rec.check({
    id: 'ENG-B3 Master may override the forward lock', actor: 'NICK (partner_master)',
    setup: 'same RM800 lock', action: 'create 15:00 RM200 with an override reason',
    expected: 'ALLOWED', actual: withOverride.ok ? 'created' : withOverride.msg, ok: withOverride.ok,
  });

  // ==========================================================================
  // C. Per-exception override — an override is never a permanent unlock
  // ==========================================================================
  const dC = await fx.freeDate(jack);
  await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dC, time: '10:00', amount: 800 }));
  const ex1 = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: jack, date: dC, time: '15:00', amount: 200, override: 'REGRESSION exception #1' }));
  rec.check({
    id: 'ENG-C1 first exception granted', actor: 'KC', setup: 'RM800 lock at 10:00',
    action: 'create 15:00 with override #1', expected: 'ALLOWED',
    actual: ex1.ok ? 'created' : ex1.msg, ok: ex1.ok,
  });

  const ex2 = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dC, time: '17:00', amount: 200 }));
  rec.check({
    id: 'ENG-C2 exception does NOT disable the lock', actor: 'KC',
    setup: 'RM800 lock at 10:00, one exception already granted at 15:00',
    action: 'create 17:00 RM200 WITHOUT a new override',
    expected: 'REJECT — each exception is per-booking',
    actual: ex2.ok ? 'CREATED (lock permanently disabled)' : ex2.msg,
    ok: !ex2.ok && /LARGE_JOB_OVERRIDE_REQUIRED/.test(ex2.msg), security: true,
  });

  const ex3 = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: jack, date: dC, time: '17:00', amount: 200, override: 'REGRESSION exception #2' }));
  const overrideRows = await fx.query(
    `select o.reason, a.start_time from public.appointment_rule_overrides o
     join public.appointments a on a.id = o.subject_appointment_id
     where a.appt_date = $1 order by a.start_time`, [dC]);
  rec.check({
    id: 'ENG-C3 each exception is recorded separately', actor: 'KC', setup: 'two exceptions granted',
    action: 'inspect appointment_rule_overrides',
    expected: '2 distinct rows, one per booking',
    actual: `${overrideRows.length} rows: ${overrideRows.map(r => `${r.start_time}:"${r.reason}"`).join(' | ')}`,
    ok: ex3.ok && overrideRows.length === 2,
  });

  // ==========================================================================
  // D. Reverse large-job case
  // ==========================================================================
  const dD = await fx.freeDate(jack);
  await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dD, time: '15:00', amount: 200 }));
  const rev = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dD, time: '10:00', amount: 800 }));
  rec.check({
    id: 'ENG-D1 reverse case blocked without override', actor: 'KC',
    setup: 'RM200 job already at 15:00',
    action: 'create 10:00 RM800 whose forward lock would cover the existing 15:00 job',
    expected: 'REJECT', actual: rev.ok ? 'CREATED' : rev.msg,
    ok: !rev.ok && /LARGE_JOB_OVERRIDE_REQUIRED/.test(rev.msg),
  });
  const revOk = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: jack, date: dD, time: '10:00', amount: 800, override: 'REGRESSION reverse override' }));
  rec.check({
    id: 'ENG-D2 reverse case allowed with override', actor: 'KC', setup: 'same',
    action: 'create 10:00 RM800 with an override reason', expected: 'ALLOWED',
    actual: revOk.ok ? 'created' : revOk.msg, ok: revOk.ok,
  });

  // ==========================================================================
  // E. Physical overlap is NEVER overridable
  // ==========================================================================
  const dE = await fx.freeDate(jack);
  await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dE, time: '10:00', amount: 400 }));
  const forced = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: jack, date: dE, time: '11:00', amount: 200,
    override: 'REGRESSION: Super Master forcing a physical overlap' }));
  rec.check({
    id: 'ENG-E1 physical overlap never overridable', actor: 'KC (super_master)',
    setup: 'RM400 job occupies 10:00-12:30',
    action: 'create 11:00 WITH an override reason',
    expected: 'REJECT — no role and no override can double-book a person',
    actual: forced.ok ? 'CREATED' : forced.msg,
    ok: !forced.ok && /PHYSICAL_OVERLAP/.test(forced.msg), security: true,
  });

  // ==========================================================================
  // F. Staff self-booking and workspace derivation
  // ==========================================================================
  const memberships = await fx.query(
    `select workspace_id from public.staff_workspaces where staff_id = $1 and is_active`, [jack]);
  const dF = await fx.freeDate(jack);
  const selfDerive = await book(fx, T.jack, bookingArgs({
    ws: null, staff: null, date: dF, time: '10:00', amount: 200 }));
  rec.check({
    id: 'ENG-F1 workspace derivation', actor: 'JACK (staff)',
    setup: `Jack has ${memberships.length} active membership(s)`,
    action: 'self-book with no workspace_id',
    expected: memberships.length === 1 ? 'ALLOWED — workspace auto-derived' : 'REJECT — ambiguous, workspace_id required',
    actual: selfDerive.ok ? 'created' : selfDerive.msg,
    ok: memberships.length === 1
      ? selfDerive.ok
      : (!selfDerive.ok && /Multiple active workspace memberships/.test(selfDerive.msg)),
  });

  const dF2 = await fx.freeDate(jack);
  const selfExplicit = await book(fx, T.jack, bookingArgs({
    ws: shared, staff: null, date: dF2, time: '10:00', amount: 200 }));
  const selfRow = selfExplicit.ok ? await fx.appointment(selfExplicit.body) : null;
  rec.check({
    id: 'ENG-F2 self-booking binds to the caller', actor: 'JACK (staff)',
    setup: 'explicit workspace, no staff_id', action: 'self-book 10:00 RM200',
    expected: 'staff_id, created_by and workspace all server-resolved to Jack / Shared Team',
    actual: selfExplicit.ok
      ? `staff=${selfRow.staff_id === jack ? 'Jack' : selfRow.staff_id} created_by=${selfRow.created_by === ids.profile.jack ? 'Jack' : selfRow.created_by} ws=${selfRow.workspace_id === shared ? 'Shared' : selfRow.workspace_id}`
      : selfExplicit.msg,
    ok: selfExplicit.ok && selfRow.staff_id === jack
        && selfRow.created_by === ids.profile.jack && selfRow.workspace_id === shared,
  });

  // ==========================================================================
  // G. Item / amount recalculation
  // ==========================================================================
  const dG = await fx.freeDate(jack);
  const g = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dG, time: '10:00', amount: 200 }));
  await rpc('update_appointment_items', T.kc, {
    p_appointment_id: g.body, p_items: items(500),
    p_final_duration_override_min: null, p_large_job_override_reason: null });
  let gRow = await fx.appointment(g.body);
  rec.check({
    id: 'ENG-G1 items drive duration', actor: 'KC', setup: 'RM200 job at 10:00',
    action: 'update items to RM500',
    expected: 'total 500, duration 150, buffer still 30, not yet a large job',
    actual: `total=${gRow.total_amount} dur=${gRow.calculated_duration_min} buf=${gRow.buffer_minutes} large=${gRow.is_large_job}`,
    ok: Number(gRow.total_amount) === 500 && gRow.calculated_duration_min === 150
        && gRow.buffer_minutes === 30 && gRow.is_large_job === false,
  });

  await rpc('update_appointment_items', T.kc, {
    p_appointment_id: g.body, p_items: items(700),
    p_final_duration_override_min: null, p_large_job_override_reason: null });
  gRow = await fx.appointment(g.body);
  rec.check({
    id: 'ENG-G2 crossing the threshold reclassifies', actor: 'KC', setup: 'same job at RM500',
    action: 'update items to RM700',
    expected: 'total 700, duration 210, is_large_job becomes true',
    actual: `total=${gRow.total_amount} dur=${gRow.calculated_duration_min} large=${gRow.is_large_job}`,
    ok: Number(gRow.total_amount) === 700 && gRow.calculated_duration_min === 210 && gRow.is_large_job === true,
  });

  const afterReclass = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dG, time: '16:00', amount: 200 }));
  rec.check({
    id: 'ENG-G3 new classification takes effect immediately', actor: 'KC',
    setup: 'the 10:00 job became large only via an item edit',
    action: 'create 16:00 RM200 without an override',
    expected: 'REJECT — the forward lock now applies',
    actual: afterReclass.ok ? 'CREATED' : afterReclass.msg,
    ok: !afterReclass.ok && /LARGE_JOB_OVERRIDE_REQUIRED/.test(afterReclass.msg),
  });

  // ==========================================================================
  // H. Terminal statuses
  // ==========================================================================
  const dH = await fx.freeDate(jack);
  const h = await book(fx, T.jack, bookingArgs({ ws: shared, staff: null, date: dH, time: '10:00', amount: 200 }));
  const edit = await rpc('update_appointment', T.jack, {
    p_appointment_id: h.body, p_customer_name: 'TEST CUSTOMER B', p_customer_phone: null,
    p_address_line: null, p_area_city: null, p_remarks: 'REGRESSION FIXTURE',
    p_final_duration_override_min: null, p_large_job_override_reason: null });
  const resched = await rpc('reschedule_appointment', T.jack, {
    p_appointment_id: h.body, p_new_date: dH, p_new_start_time: '14:00', p_large_job_override_reason: null });
  rec.check({
    id: 'ENG-H1 booked appointments are editable', actor: 'JACK', setup: 'own booked appointment',
    action: 'edit then reschedule', expected: 'both ALLOWED',
    actual: `edit=${edit.ok ? 'ok' : edit.msg}, reschedule=${resched.ok ? 'ok' : resched.msg}`,
    ok: edit.ok && resched.ok,
  });

  const completed = await rpc('mark_appointment_completed', T.jack, { p_appointment_id: h.body });
  rec.check({
    id: 'ENG-H2 mark completed', actor: 'JACK', setup: 'own booked appointment',
    action: 'mark completed', expected: 'ALLOWED',
    actual: completed.ok ? 'completed' : completed.msg, ok: completed.ok,
  });
  for (const [label, fn, args] of [
    ['reschedule', 'reschedule_appointment', { p_appointment_id: h.body, p_new_date: dH, p_new_start_time: '16:00', p_large_job_override_reason: null }],
    ['cancel', 'cancel_appointment', { p_appointment_id: h.body, p_reason: 'REGRESSION' }],
    ['edit', 'update_appointment', { p_appointment_id: h.body, p_customer_name: 'X', p_customer_phone: null, p_address_line: null, p_area_city: null, p_remarks: null, p_final_duration_override_min: null, p_large_job_override_reason: null }],
  ]) {
    const r = await rpc(fn, T.jack, args);
    rec.check({
      id: `ENG-H3 completed is terminal (${label})`, actor: 'JACK', setup: 'appointment is COMPLETED',
      action: label, expected: 'REJECT', actual: r.ok ? 'SUCCEEDED' : r.msg, ok: !r.ok,
    });
  }

  const dH2 = await fx.freeDate(jack);
  const h2 = await book(fx, T.jack, bookingArgs({ ws: shared, staff: null, date: dH2, time: '10:00', amount: 200 }));
  const cancelled = await rpc('cancel_appointment', T.jack, { p_appointment_id: h2.body, p_reason: 'REGRESSION cancel' });
  rec.check({
    id: 'ENG-H4 cancel', actor: 'JACK', setup: 'own booked appointment', action: 'cancel',
    expected: 'ALLOWED', actual: cancelled.ok ? 'cancelled' : cancelled.msg, ok: cancelled.ok,
  });
  for (const [label, fn, args] of [
    ['reschedule', 'reschedule_appointment', { p_appointment_id: h2.body, p_new_date: dH2, p_new_start_time: '16:00', p_large_job_override_reason: null }],
    ['complete', 'mark_appointment_completed', { p_appointment_id: h2.body }],
  ]) {
    const r = await rpc(fn, T.jack, args);
    rec.check({
      id: `ENG-H5 cancelled is terminal (${label})`, actor: 'JACK', setup: 'appointment is CANCELLED',
      action: label, expected: 'REJECT', actual: r.ok ? 'SUCCEEDED' : r.msg, ok: !r.ok,
    });
  }

  // a cancelled appointment frees its slot
  const reuse = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dH2, time: '10:00', amount: 200 }));
  rec.check({
    id: 'ENG-H6 cancelling frees the slot', actor: 'KC', setup: 'the 10:00 booking was cancelled',
    action: 'create 10:00 RM200 in the freed slot', expected: 'ALLOWED',
    actual: reuse.ok ? 'created' : reuse.msg, ok: reuse.ok,
  });

  // ==========================================================================
  // I. Time off
  // ==========================================================================
  const dI = await fx.freeDate(jack);
  const off = await rpc('set_staff_time_off', T.nick, {
    p_staff_id: jack, p_off_date: dI, p_start_time: '10:00', p_end_time: '13:00',
    p_reason: 'REGRESSION time off' });
  const offRows = await fx.query(
    `select id from public.staff_time_off where staff_id = $1 and off_date = $2`, [jack, dI]);
  offRows.forEach(r => fx.trackTimeOff(r.id));
  rec.check({
    id: 'ENG-I1 set partial time off', actor: 'NICK', setup: 'empty day',
    action: 'set Jack unavailable 10:00-13:00', expected: 'ALLOWED',
    actual: off.ok ? 'created' : off.msg, ok: off.ok,
  });
  const inOff = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dI, time: '11:00', amount: 200 }));
  rec.check({
    id: 'ENG-I2 booking inside time off', actor: 'KC', setup: 'Jack off 10:00-13:00',
    action: 'create 11:00', expected: 'REJECT', actual: inOff.ok ? 'CREATED' : inOff.msg,
    ok: !inOff.ok && /time off/i.test(inOff.msg),
  });
  const outOff = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dI, time: '14:00', amount: 200 }));
  rec.check({
    id: 'ENG-I3 booking outside time off', actor: 'KC', setup: 'Jack off 10:00-13:00',
    action: 'create 14:00', expected: 'ALLOWED', actual: outOff.ok ? 'created' : outOff.msg, ok: outOff.ok,
  });

  const dI2 = await fx.freeDate(jack);
  const [raceBook, raceOff] = await Promise.all([
    book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dI2, time: '10:00', amount: 200 })),
    rpc('set_staff_time_off', T.kc, { p_staff_id: jack, p_off_date: dI2, p_start_time: '10:00',
      p_end_time: '12:00', p_reason: 'REGRESSION concurrent' }),
  ]);
  (await fx.query(`select id from public.staff_time_off where staff_id=$1 and off_date=$2`, [jack, dI2]))
    .forEach(r => fx.trackTimeOff(r.id));
  const apptN = (await fx.query(
    `select count(*)::int n from public.appointments
     where staff_id=$1 and appt_date=$2 and status <> 'cancelled'`, [jack, dI2]))[0].n;
  const offN = (await fx.query(
    `select count(*)::int n from public.staff_time_off where staff_id=$1 and off_date=$2`, [jack, dI2]))[0].n;
  rec.check({
    id: 'ENG-I4 booking vs overlapping time-off race', actor: 'KC x2 concurrent', setup: 'empty day',
    action: 'fire a 10:00 booking and an overlapping 10:00-12:00 time-off simultaneously',
    expected: 'the two never both commit',
    actual: `booking_ok=${raceBook.ok} timeoff_ok=${raceOff.ok}; committed appointments=${apptN}, time-off=${offN}`,
    ok: !(apptN > 0 && offN > 0), security: true,
  });

  // ==========================================================================
  // J. Working hours
  // ==========================================================================
  const dJ = await fx.freeDate(jack);
  for (const [time, allowed, why] of [
    ['08:30', false, 'before opening'],
    ['19:00', false, 'starts at closing'],
    ['18:30', false, '60m duration would run past closing'],
    ['10:00', true, 'valid'],
  ]) {
    const r = await book(fx, T.kc, bookingArgs({ ws: shared, staff: jack, date: dJ, time, amount: 200 }));
    rec.check({
      id: `ENG-J1 company default ${time}`, actor: 'KC',
      setup: `company default ${settings.default_day_start}-${settings.default_day_end}`,
      action: `create ${time} RM200 (${why})`, expected: allowed ? 'ALLOWED' : 'REJECT',
      actual: r.ok ? 'created' : r.msg, ok: r.ok === allowed,
    });
  }

  // Staff-specific hours. The staff/weekday is chosen at runtime because
  // set_staff_working_hours legitimately refuses to strand an existing FUTURE
  // booking — a hard-coded weekday makes this untestable once data exists.
  const candidates = await fx.query(
    `select s.id, s.display_name, d.dow,
       (select count(*) from public.appointments a
         where a.staff_id = s.id and a.status = 'booked'
           and extract(dow from a.appt_date)::smallint = d.dow
           and (a.appt_date + a.start_time) > (now() at time zone 'Asia/Kuala_Lumpur'))::int as future_n
     from public.staff s cross join generate_series(0,6) d(dow)
     where s.is_active and exists (
       select 1 from public.staff_workspaces sw
       where sw.staff_id = s.id and sw.workspace_id = $1 and sw.is_active)
     order by future_n, s.display_name, d.dow`, [shared]);
  const pick = candidates.find(c => c.future_n === 0);
  const S = pick.id, DOW = pick.dow;
  await fx.rememberWorkingHours(S, DOW);

  // A PAST booking on the same weekday must never block a recurring-hours
  // change (the 0004 fix). Inserted directly: the engine has no past-date path.
  const pastDate = await (async () => {
    for (let k = 60; k < 400; k++) {
      const x = new Date(); x.setUTCDate(x.getUTCDate() - k);
      if (x.getUTCDay() === DOW) return x.toISOString().slice(0, 10);
    }
  })();
  const pastId = (await fx.query(
    `insert into public.appointments (workspace_id, staff_id, customer_name, customer_phone,
       address_line, area_city, appt_date, start_time, calculated_duration_min, final_duration_min,
       buffer_minutes, total_amount, is_large_job, status, remarks, created_by)
     values ($1,$2,'TEST CUSTOMER PAST','+60000000003','TEST ADDRESS PAST','TEST CITY',$3,'10:00',
       60,60,30,200,false,'booked',$4,$5) returning id`,
    [shared, S, pastDate, fx.TAG, ids.profile.kc]))[0].id;
  fx.track(pastId);

  const setHours = await rpc('set_staff_working_hours', T.kc, {
    p_staff_id: S, p_day_of_week: DOW, p_start_time: '12:00', p_end_time: '16:00' });
  rec.check({
    id: 'ENG-J2 past bookings never block an hours change', actor: 'KC',
    setup: `${pick.display_name} has a PAST ${pastDate} 10:00 booking, outside the new window`,
    action: `set staff hours 12:00-16:00 for weekday ${DOW}`,
    expected: 'ALLOWED', actual: setHours.ok ? 'set' : setHours.msg, ok: setHours.ok,
  });

  if (setHours.ok) {
    const dJ2 = await fx.freeDate(S, { dayOfWeek: DOW, offsetDays: 30 });
    for (const [time, allowed, why] of [
      ['10:00', false, 'inside company default, before the staff window'],
      ['13:00', true, 'inside the staff window'],
      ['15:30', false, '60m duration would end 16:30, past the window'],
    ]) {
      const r = await book(fx, T.kc, bookingArgs({ ws: shared, staff: S, date: dJ2, time, amount: 200 }));
      rec.check({
        id: `ENG-J3 staff window ${time}`, actor: 'KC', setup: 'staff-specific hours 12:00-16:00',
        action: `create ${time} RM200 (${why})`,
        expected: allowed ? 'ALLOWED' : 'REJECT — staff hours override the company default',
        actual: r.ok ? 'created' : r.msg,
        ok: allowed ? r.ok : (!r.ok && /Outside working hours \(12:00/.test(r.msg)),
      });
    }
    const narrow = await rpc('set_staff_working_hours', T.kc, {
      p_staff_id: S, p_day_of_week: DOW, p_start_time: '14:00', p_end_time: '18:00' });
    rec.check({
      id: 'ENG-J4 future bookings still block an hours change', actor: 'KC',
      setup: 'a FUTURE 13:00 booking now exists on that weekday',
      action: 'narrow the window to 14:00-18:00, stranding it',
      expected: 'REJECT', actual: narrow.ok ? 'set' : narrow.msg, ok: !narrow.ok,
    });
  }

  // Release the staff-specific window now rather than at teardown. It is scoped
  // to one weekday, and a later section booking the same staff member on that
  // weekday would otherwise be rejected for being outside it — which would
  // silently invalidate that section instead of failing loudly.
  // Restores whatever was there before, rather than deleting by
  // (staff_id, day_of_week) and leaving a hole where a real window used to be.
  await fx.clearWorkingHours(S, DOW);

  // ==========================================================================
  // K. Genuine concurrent double-booking
  // ==========================================================================
  const dK = await fx.freeDate(ids.staff.dyron);
  const [x, y] = await Promise.all([
    book(fx, T.kc, bookingArgs({ ws: shared, staff: ids.staff.dyron, date: dK, time: '10:00', amount: 200 })),
    book(fx, T.kc, bookingArgs({ ws: shared, staff: ids.staff.dyron, date: dK, time: '10:00', amount: 200 })),
  ]);
  const committed = (await fx.query(
    `select count(*)::int n from public.appointments
     where staff_id=$1 and appt_date=$2 and status <> 'cancelled'`, [ids.staff.dyron, dK]))[0].n;
  rec.check({
    id: 'ENG-K1 concurrent double-booking', actor: 'KC x2 truly concurrent HTTP', setup: 'empty slot',
    action: 'fire two identical create_appointment calls simultaneously',
    expected: 'exactly ONE commits',
    actual: `first_ok=${x.ok} second_ok=${y.ok}; committed=${committed}${y.ok ? '' : ' | rejected: ' + y.msg}`,
    ok: committed === 1 && (x.ok !== y.ok), security: true,
  });
});

process.exit(summary.fail === 0 ? 0 : 1);
