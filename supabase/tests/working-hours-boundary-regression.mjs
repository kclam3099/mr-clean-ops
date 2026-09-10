// Migration 0008 regression suite — the working-hours midnight boundary.
//
// PostgreSQL `time + interval` wraps modulo 24 hours:
//
//     '23:05'::time + make_interval(mins => 60)  ->  '00:05'
//     '00:05'::time > '19:00'::time              ->  false
//
// The working-hours upper bound compared time-of-day values, so an appointment
// whose duration crossed midnight escaped it entirely. Reproduced on DEV
// through the normal create_appointment RPC before the fix: a 23:05 booking was
// accepted against a 09:00-19:00 window, and its occupied_range correctly
// spanned into the next morning — blocking a day it should never have reached.
//
// 0008 compares timestamps instead, in both places that carried the pattern:
// assert_appointment_slot_available (shared by create, reschedule, item updates
// and the availability finder) and set_staff_working_hours.
//
// A late 18:00-23:59 window makes the boundary easy to state exactly. With a
// 60-minute job and a 30-minute buffer, 22:29 ends at 23:59 and 22:30 ends at
// 00:00 the next day — one minute apart, on opposite sides of the rule.
//
// Run: npm run test:working-hours

import { runSuite, rpc, book, bookingArgs, items } from "./lib/harness.mjs";

const LATE_WINDOW = { start: "18:00", end: "23:59" };

const summary = await runSuite("WORKING-HOURS BOUNDARY REGRESSION", async ({ ids, fx, rec, T }) => {
  const shared = ids.ws.shared;
  const { dyron, jack } = ids.staff;

  // Every case sets its own window on its own date's weekday, so the dates do
  // not need to share a weekday — they only need to be free. Searching forward
  // for a date on which BOTH staff members this suite books are free means a
  // manual appointment can never turn a boundary test into a PHYSICAL_OVERLAP,
  // and nothing has to throw and abandon the remaining checks.
  const day = (n) => fx.freeDateForAll([dyron, jack], { offsetDays: n });
  const dowOf = async (date) => (await fx.query(`select extract(dow from $1::date)::int d`, [date]))[0].d;

  // Both helpers go through the fixture tracker, which remembers the exact row
  // it displaces and puts it back at teardown. Deleting by
  // (staff_id, day_of_week) destroyed a manually configured window instead of
  // borrowing it.
  /** Remove any staff-specific window on that weekday, so company defaults apply. */
  async function clearWindow(staff, date) {
    const dow = await dowOf(date);
    await fx.clearWorkingHours(staff, dow);
  }

  /** Give `staff` the late window on the weekday of `date`, restored at teardown. */
  async function applyLateWindow(staff, date) {
    const dow = await dowOf(date);
    await fx.setWorkingHours(staff, dow, LATE_WINDOW.start, LATE_WINDOW.end);
    return dow;
  }

  // ==========================================================================
  // A. The original reproduction, through the normal RPC
  // ==========================================================================
  {
    const d = await day(70);   // default 09:00-19:00, no staff-specific window
    const r = await book(fx, T.kc, bookingArgs({
      ws: shared, staff: dyron, date: d, time: "23:05", amount: 200 }));
    rec.check({
      id: "WH-00 the original 23:05 reproduction (CRITICAL)", actor: "KC",
      setup: "default working hours 09:00-19:00, no staff-specific window",
      action: `create_appointment on ${d} at 23:05 (60 min + 30 min buffer)`,
      expected: "DENIED — before 0008 this was accepted because 23:05+60 wrapped to 00:05",
      actual: r.ok ? "CREATED" : r.msg,
      ok: !r.ok && /Outside working hours/i.test(r.msg), security: true,
    });
    const committed = await fx.query(
      `select count(*)::int n from public.appointments where staff_id=$1 and appt_date=$2`, [dyron, d]);
    rec.check({
      id: "WH-01 nothing committed", actor: "KC", setup: "same",
      action: "count rows on that date", expected: "0",
      actual: `${committed[0].n} rows`, ok: committed[0].n === 0, security: true,
    });
  }

  // ==========================================================================
  // B. The exact boundary, one minute either side
  // ==========================================================================
  {
    const d = await day(71);
    await applyLateWindow(dyron, d);
    const boundaryCases = [
      ["18:00", "19:30", true],
      ["22:29", "23:59 exactly", true],
      ["22:30", "00:00 next day", false],
      ["23:05", "00:35 next day", false],
      ["23:50", "01:20 next day", false],
    ];
    for (const [index, [time, ends, allowed]] of boundaryCases.entries()) {
      // Each case gets its own date AND its own weekday. Sharing a date would
      // make a later case fail on overlap; sharing a weekday would leave the
      // late window applied for dates used by later sections, which is a
      // fixture leak rather than a real result.
      const caseDate = await day(71 + index * 7);
      await applyLateWindow(dyron, caseDate);
      const r = await book(fx, T.kc, bookingArgs({
        ws: shared, staff: dyron, date: caseDate, time, amount: 200 }));
      rec.check({
        id: `WH-02 ${time} ends ${ends}`, actor: "KC",
        setup: `staff window ${LATE_WINDOW.start}-${LATE_WINDOW.end}`,
        action: `create at ${time}`,
        expected: allowed ? "ALLOWED" : "DENIED",
        actual: r.ok ? "created" : r.msg,
        ok: allowed ? r.ok : (!r.ok && /Outside working hours/i.test(r.msg)),
      });
    }
  }

  // ==========================================================================
  // C. Default hours still behave, including the inclusive end boundary
  // ==========================================================================
  {
    let offset = 100;
    for (const [label, time, amount, allowed] of [
      ["10:00 RM200 ends 11:30", "10:00", 200, true],
      ["17:30 RM200 ends 19:00 exactly", "17:30", 200, true],
      ["17:31 RM200 ends 19:01", "17:31", 200, false],
      ["08:30 before opening", "08:30", 200, false],
      ["15:00 RM700 (210 min) ends 19:00 exactly", "15:00", 700, true],
    ]) {
      const d = await day(offset++);
      await clearWindow(dyron, d);   // these cases are about the COMPANY default
      const r = await book(fx, T.kc, bookingArgs({ ws: shared, staff: dyron, date: d, time, amount }));
      rec.check({
        id: `WH-03 default hours: ${label}`, actor: "KC", setup: "09:00-19:00",
        action: `create at ${time} RM${amount}`,
        expected: allowed ? "ALLOWED — the end boundary stays inclusive" : "DENIED",
        actual: r.ok ? "created" : r.msg, ok: r.ok === allowed,
      });
    }
  }

  // ==========================================================================
  // D. Item expansion cannot push an appointment past the window
  // ==========================================================================
  {
    const d = await day(120);
    await applyLateWindow(dyron, d);
    const seed = await book(fx, T.kc, bookingArgs({
      ws: shared, staff: dyron, date: d, time: "22:00", amount: 200 }));   // ends 23:30
    rec.check({
      id: "WH-04 seed a valid late appointment", actor: "KC",
      setup: `window ${LATE_WINDOW.start}-${LATE_WINDOW.end}`,
      action: "create 22:00 RM200 (ends 23:30)", expected: "ALLOWED",
      actual: seed.ok ? "created" : seed.msg, ok: seed.ok,
    });
    if (seed.ok) {
      const expand = await rpc("update_appointment_items", T.kc, {
        p_appointment_id: seed.body, p_items: items(600),   // 180 min -> ends 01:30
        p_final_duration_override_min: null, p_large_job_override_reason: null });
      rec.check({
        id: "WH-05 item expansion past the window is refused (CRITICAL)", actor: "KC",
        setup: "the same appointment", action: "update items to RM600 (180 min, would end 01:30)",
        expected: "DENIED — the shared validator protects item changes too",
        actual: expand.ok ? "ACCEPTED" : expand.msg,
        ok: !expand.ok && /Outside working hours/i.test(expand.msg), security: true,
      });
      const still = await fx.appointment(seed.body);
      rec.check({
        id: "WH-06 the original row is unchanged", actor: "db", setup: "after the refused expansion",
        action: "re-read the appointment",
        expected: "still RM200 / 60 min",
        actual: `total=${still.total_amount} dur=${still.calculated_duration_min}`,
        ok: Number(still.total_amount) === 200 && still.calculated_duration_min === 60,
      });
    }
  }

  // ==========================================================================
  // E. Reschedule across the boundary
  // ==========================================================================
  {
    const d = await day(130);
    await applyLateWindow(dyron, d);
    const seed = await book(fx, T.kc, bookingArgs({
      ws: shared, staff: dyron, date: d, time: "19:00", amount: 200 }));
    if (seed.ok) {
      const bad = await rpc("reschedule_appointment", T.kc, {
        p_appointment_id: seed.body, p_new_date: d, p_new_start_time: "23:05",
        p_large_job_override_reason: null });
      rec.check({
        id: "WH-07 reschedule across midnight is refused", actor: "KC",
        setup: `window ${LATE_WINDOW.start}-${LATE_WINDOW.end}`,
        action: "reschedule to 23:05 (would end 00:35)",
        expected: "DENIED", actual: bad.ok ? "MOVED" : bad.msg,
        ok: !bad.ok && /Outside working hours/i.test(bad.msg), security: true,
      });
      const good = await rpc("reschedule_appointment", T.kc, {
        p_appointment_id: seed.body, p_new_date: d, p_new_start_time: "22:29",
        p_large_job_override_reason: null });
      rec.check({
        id: "WH-08 reschedule inside the window is allowed", actor: "KC", setup: "same",
        action: "reschedule to 22:29 (ends 23:59 exactly)",
        expected: "ALLOWED", actual: good.ok ? "moved" : good.msg, ok: good.ok,
      });
    }
  }

  // ==========================================================================
  // F. set_staff_working_hours revalidation
  // ==========================================================================
  {
    const d = await day(140);
    const dow = await dowOf(d);
    await fx.clearWorkingHours(jack, dow);

    // A pre-existing future row that runs past midnight. Inserted as an admin
    // fixture precisely because the engine now refuses to create one — this
    // represents data written before 0008.
    const bad = await fx.query(
      `insert into public.appointments (workspace_id,staff_id,customer_name,customer_phone,
         address_line,area_city,appt_date,start_time,calculated_duration_min,final_duration_min,
         buffer_minutes,total_amount,is_large_job,status,remarks,created_by)
       values ($1,$2,'TEST CUSTOMER A','+60000000001','TEST ADDRESS','TEST CITY',$3,'23:05',
               60,60,30,200,false,'booked',$4,$5) returning id`,
      [shared, jack, d, fx.TAG, ids.profile.kc]);
    fx.track(bad[0].id);

    const r = await rpc("set_staff_working_hours", T.kc, {
      p_staff_id: jack, p_day_of_week: dow,
      p_start_time: LATE_WINDOW.start, p_end_time: LATE_WINDOW.end });
    rec.check({
      id: "WH-09 wrapped row cannot pass hours revalidation (CRITICAL)", actor: "KC",
      setup: `a pre-existing 23:05 booking (ends 00:35) on weekday ${dow}`,
      action: `set hours ${LATE_WINDOW.start}-${LATE_WINDOW.end}`,
      expected: "DENIED — the row runs past the same-day window",
      actual: r.ok ? "ACCEPTED — the wrap is still hiding it" : r.msg,
      ok: !r.ok && /falls outside the new hours/i.test(r.msg), security: true,
    });
  }

  // ==========================================================================
  // G. The availability finder inherits the fix
  // ==========================================================================
  {
    const d = await day(150);
    await applyLateWindow(dyron, d);

    // Temporary workspace-specific slots around the boundary. Workspace rows
    // take precedence over the global ones, so this exercises the boundary
    // without touching the public RPC signature or the global configuration.
    const inserted = await fx.query(
      `insert into public.suggested_time_slots (workspace_id, slot_time, sort_order, is_active)
       values ($1,'22:29',90,true), ($1,'22:30',91,true), ($1,'23:05',92,true) returning id`, [shared]);
    try {
      const r = await rpc("find_available_slots", T.kc, {
        p_staff_ids: [dyron], p_from: d, p_to: d, p_workspace_id: shared });
      const offered = r.ok ? r.body.map((x) => x.slot_time.slice(0, 5)) : [];
      rec.check({
        id: "WH-10 finder offers the slot ending exactly at close", actor: "KC",
        setup: `window ${LATE_WINDOW.start}-${LATE_WINDOW.end}, temporary slots 22:29 / 22:30 / 23:05`,
        action: "find_available_slots",
        expected: "22:29 offered (ends 23:59)",
        actual: offered.join(", ") || "(none)", ok: offered.includes("22:29"),
      });
      rec.check({
        id: "WH-11 finder omits slots crossing midnight (CRITICAL)", actor: "KC", setup: "same",
        action: "check 22:30 and 23:05",
        expected: "both omitted",
        actual: `22:30=${offered.includes("22:30")} 23:05=${offered.includes("23:05")}`,
        ok: !offered.includes("22:30") && !offered.includes("23:05"), security: true,
      });
    } finally {
      await fx.query(`delete from public.suggested_time_slots where id = any($1::uuid[])`,
        [inserted.map((r) => r.id)]);
    }

    const remaining = await fx.query(
      `select count(*)::int n from public.suggested_time_slots where sort_order >= 90`);
    rec.check({
      id: "WH-12 temporary slot configuration removed", actor: "db", setup: "-",
      action: "count temporary suggested_time_slots rows",
      expected: "0", actual: `${remaining[0].n}`, ok: remaining[0].n === 0,
    });
  }
});

process.exit(summary.fail === 0 ? 0 : 1);
