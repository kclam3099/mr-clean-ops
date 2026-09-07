// Migration 0007 regression suite.
//
// Two independent fixes, both proven against real defects:
//
//   1. Past-datetime guard. create_appointment and reschedule_appointment
//      accepted bookings in the past — a booking three days ago, and 09:00
//      today when it was already evening in MYT, were both accepted. No role
//      and no large-job override may bypass the guard.
//
//   2. get_booking_config(). business_settings is unreadable by staff
//      (kc=1, nick=1, jack=0, victor=0 rows), so the booking UI could not
//      render a duration estimate for them. Rather than widening table access,
//      a narrow RPC exposes only the three fields the form needs.
//
// The amount-probing side channel that 0007 also closes is covered in
// availability-finder-regression.mjs, next to the rest of the finder's tests.
//
// Run: npm run test:past-guard

import { runSuite, rpc, rest, bookingArgs, items } from "./lib/harness.mjs";

const summary = await runSuite("PAST-GUARD + BOOKING CONFIG REGRESSION", async ({ ids, fx, rec, T }) => {
  const { shared } = ids.ws;
  const { jack } = ids.staff;

  const scalar = async (expr, params = []) => (await fx.query(`select ${expr} v`, params))[0].v;
  const nowMyt = await scalar(`to_char((now() at time zone 'Asia/Kuala_Lumpur'),'YYYY-MM-DD HH24:MI')`);
  const today = nowMyt.slice(0, 10);
  const hourNow = Number(nowMyt.slice(11, 13));
  const day = async (n) =>
    scalar(`to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int),'YYYY-MM-DD')`, [n]);

  const create = (date, time, token = T.kc, extra = {}) =>
    rpc("create_appointment", token, bookingArgs({
      ws: shared, staff: jack, date, time, amount: 200, remarks: fx.TAG, ...extra }));
  const track = (r) => { if (r.ok) fx.track(r.body); return r; };

  rec.check({
    id: "PG-00 business time", actor: "db", setup: "-",
    action: "read now() at Asia/Kuala_Lumpur",
    expected: "a timestamp the guard will compare against",
    actual: `${nowMyt} MYT`, ok: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(nowMyt),
  });

  // ==========================================================================
  // A. create_appointment
  // ==========================================================================
  const yesterday = await day(-1);
  const r1 = track(await create(yesterday, "10:00"));
  rec.check({
    id: "PG-01 yesterday DENIED", actor: "KC (super_master)", setup: "-",
    action: `create on ${yesterday} 10:00`, expected: "REJECT",
    actual: r1.ok ? "CREATED" : r1.msg,
    ok: !r1.ok && /must be in the future/i.test(r1.msg), security: true,
  });

  if (hourNow >= 10) {
    const r2 = track(await create(today, "09:00"));
    rec.check({
      id: "PG-02 earlier today DENIED", actor: "KC", setup: `it is ${nowMyt} MYT`,
      action: `create on ${today} 09:00`, expected: "REJECT",
      actual: r2.ok ? "CREATED" : r2.msg,
      ok: !r2.ok && /must be in the future/i.test(r2.msg), security: true,
    });
  } else {
    rec.check({
      id: "PG-02 earlier today DENIED", actor: "KC", setup: "-",
      action: "skipped: before 10:00 MYT, no past working hour exists today",
      expected: "n/a", actual: "skipped", ok: true,
    });
  }

  // "Later today" must be computed from the actual clock, not hardcoded — this
  // suite runs at any hour. 30 minutes ahead is always in the future; whether it
  // is BOOKABLE then depends on working hours, and both branches prove the
  // guard let it through:
  //   inside 09:00-19:00  -> ALLOWED outright
  //   outside             -> rejected for WORKING HOURS, never for the past
  const minutesNow = Number(nowMyt.slice(11, 13)) * 60 + Number(nowMyt.slice(14, 16));
  const laterMinutes = minutesNow + 30;
  if (laterMinutes < 24 * 60) {
    const later = `${String(Math.floor(laterMinutes / 60)).padStart(2, "0")}:${String(laterMinutes % 60).padStart(2, "0")}`;
    const r3 = track(await create(today, later));
    // Asserts ONLY the past-guard property: a future time today is not rejected
    // for being in the past. Whether it is then bookable is working hours'
    // business, not this test's — conflating the two made this test fail for a
    // reason that had nothing to do with the guard.
    rec.check({
      id: "PG-03 a future time today is not rejected as past", actor: "KC",
      setup: `it is ${nowMyt} MYT`,
      action: `create on ${today} ${later} (30 minutes from now)`,
      expected: "either allowed, or refused for some OTHER reason — never 'must be in the future'",
      actual: r3.ok ? "created" : r3.msg,
      ok: r3.ok || !/must be in the future/i.test(r3.msg),
    });
  } else {
    rec.check({
      id: "PG-03 later today passes the guard", actor: "KC", setup: `it is ${nowMyt} MYT`,
      action: "skipped: within 30 minutes of midnight, no later time exists today",
      expected: "n/a", actual: "skipped", ok: true,
    });
  }

  const tomorrow = await day(1);
  const r4 = track(await create(tomorrow, "10:00"));
  rec.check({
    id: "PG-04 tomorrow ALLOWED", actor: "KC", setup: "-",
    action: `create on ${tomorrow} 10:00`, expected: "ALLOWED",
    actual: r4.ok ? "created" : r4.msg, ok: r4.ok,
  });

  // No role and no override may bypass it.
  const r5 = track(await create(yesterday, "11:00", T.kc, {
    override: "REGRESSION: attempting to force a past booking" }));
  rec.check({
    id: "PG-05 override cannot bypass the guard (CRITICAL)", actor: "KC (super_master)",
    setup: "supplies a large-job override reason",
    action: `create on ${yesterday} 11:00 WITH an override reason`,
    expected: "REJECT — the guard runs before every other rule",
    actual: r5.ok ? "CREATED" : r5.msg,
    ok: !r5.ok && /must be in the future/i.test(r5.msg), security: true,
  });

  const r6 = await rpc("create_appointment", T.jack, {
    p_workspace_id: shared, p_staff_id: null,
    p_customer_name: "TEST CUSTOMER A", p_customer_phone: "+60000000001",
    p_address_line: "A", p_area_city: "C", p_appt_date: yesterday, p_start_time: "10:00",
    p_items: items(200), p_final_duration_override_min: null,
    p_remarks: fx.TAG, p_large_job_override_reason: null });
  if (r6.ok) fx.track(r6.body);
  rec.check({
    id: "PG-06 staff cannot book in the past either", actor: "JACK (staff)", setup: "-",
    action: `self-book on ${yesterday}`, expected: "REJECT",
    actual: r6.ok ? "CREATED" : r6.msg,
    ok: !r6.ok && /must be in the future/i.test(r6.msg), security: true,
  });

  // ==========================================================================
  // B. reschedule_appointment
  // ==========================================================================
  const future = await day(20);
  const seed = track(await create(future, "10:00"));
  const apptId = seed.ok ? seed.body : null;
  rec.check({
    id: "PG-07 seed future appointment", actor: "KC", setup: "-",
    action: `create on ${future} 10:00`, expected: "ALLOWED",
    actual: seed.ok ? "created" : seed.msg, ok: seed.ok,
  });

  if (apptId) {
    const resched = (date, time, reason = null) => rpc("reschedule_appointment", T.kc, {
      p_appointment_id: apptId, p_new_date: date, p_new_start_time: time,
      p_large_job_override_reason: reason });

    const s1 = await resched(yesterday, "10:00");
    rec.check({
      id: "PG-08 reschedule to yesterday DENIED", actor: "KC", setup: "future appointment exists",
      action: `reschedule to ${yesterday} 10:00`, expected: "REJECT",
      actual: s1.ok ? "MOVED" : s1.msg,
      ok: !s1.ok && /must be in the future/i.test(s1.msg), security: true,
    });

    if (hourNow >= 10) {
      const s2 = await resched(today, "09:00");
      rec.check({
        id: "PG-09 reschedule to earlier today DENIED", actor: "KC", setup: `it is ${nowMyt} MYT`,
        action: `reschedule to ${today} 09:00`, expected: "REJECT",
        actual: s2.ok ? "MOVED" : s2.msg,
        ok: !s2.ok && /must be in the future/i.test(s2.msg), security: true,
      });
    } else {
      rec.check({
        id: "PG-09 reschedule to earlier today DENIED", actor: "KC", setup: "-",
        action: "skipped: before 10:00 MYT", expected: "n/a", actual: "skipped", ok: true,
      });
    }

    const s3 = await resched(yesterday, "11:00", "REGRESSION: override attempt");
    rec.check({
      id: "PG-10 reschedule override cannot bypass the guard", actor: "KC",
      setup: "supplies an override reason",
      action: `reschedule to ${yesterday} WITH an override reason`, expected: "REJECT",
      actual: s3.ok ? "MOVED" : s3.msg,
      ok: !s3.ok && /must be in the future/i.test(s3.msg), security: true,
    });

    const s4 = await resched(future, "13:00");
    rec.check({
      id: "PG-11 valid future reschedule ALLOWED", actor: "KC", setup: "-",
      action: `reschedule to ${future} 13:00`, expected: "ALLOWED",
      actual: s4.ok ? "moved" : s4.msg, ok: s4.ok,
    });
  }

  // ==========================================================================
  // C. get_booking_config
  // ==========================================================================
  const EXPECTED_FIELDS = ["rm_per_hour_rate", "default_buffer_minutes", "default_availability_job_duration_minutes"];

  for (const [who, token] of [["KC", T.kc], ["NICK", T.nick], ["JACK", T.jack],
                              ["DYRON", T.dyron], ["VICTOR", T.victor]]) {
    const r = await rpc("get_booking_config", token, {});
    const row = Array.isArray(r.body) ? r.body[0] : r.body;
    rec.check({
      id: `CFG-01 ${who} can read booking config`, actor: who,
      setup: "business_settings itself is not readable by staff",
      action: "call get_booking_config()",
      expected: "exactly the three booking fields",
      actual: r.ok ? JSON.stringify(row) : r.msg,
      ok: r.ok && row && EXPECTED_FIELDS.every((f) => f in row)
          && Object.keys(row).length === EXPECTED_FIELDS.length,
    });
  }

  const cfg = await rpc("get_booking_config", T.jack, {});
  const cfgRow = Array.isArray(cfg.body) ? cfg.body[0] : cfg.body;
  const forbidden = ["full_day_lock_threshold", "default_day_start", "default_day_end",
                     "staff_can_mark_completed", "wa_reminder_template_en",
                     "wa_reminder_template_zh", "wa_reminder_template_ms", "updated_at"];
  const exposed = forbidden.filter((f) => cfgRow && f in cfgRow);
  rec.check({
    id: "CFG-02 no unrelated settings exposed (CRITICAL)", actor: "JACK", setup: "-",
    action: "check the payload for fields outside the booking scope",
    expected: "none of the threshold, day window, completion flag or WA templates",
    actual: exposed.length ? `EXPOSED: ${exposed.join(", ")}` : "none",
    ok: exposed.length === 0, security: true,
  });

  const tableRead = await rest("business_settings?select=*", T.jack);
  rec.check({
    id: "CFG-03 table access was NOT widened (CRITICAL)", actor: "JACK",
    setup: "0007 must not add a business_settings SELECT policy",
    action: "GET /business_settings directly",
    expected: "0 rows — the RPC is the only path",
    actual: `${tableRead.rows.length} rows`, ok: tableRead.rows.length === 0, security: true,
  });

  const anonCfg = await rpc("get_booking_config", null, {});
  rec.check({
    id: "CFG-04 anon denied", actor: "anon", setup: "no JWT",
    action: "call get_booking_config()", expected: "permission denied",
    actual: `HTTP ${anonCfg.status} ${anonCfg.msg}`,
    ok: (anonCfg.status === 401 || anonCfg.status === 403) && /permission denied/i.test(anonCfg.msg),
    security: true,
  });

  const grants = await fx.query(
    `select has_function_privilege('anon', p.oid, 'EXECUTE') a,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') au
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'get_booking_config' and p.prokind = 'f'`);
  rec.check({
    id: "CFG-05 grants", actor: "catalog", setup: "-",
    action: "has_function_privilege for get_booking_config",
    expected: "anon=false, authenticated=true",
    actual: `anon=${grants[0].a}, authenticated=${grants[0].au}`,
    ok: grants[0].a === false && grants[0].au === true, security: true,
  });
});

process.exit(summary.fail === 0 ? 0 : 1);
