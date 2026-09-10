// Recording appointments that already happened (migration 0010).
//
// The property under test is narrow and must stay narrow: p_confirm_past lifts
// the "this is in the past" refusal for CREATE, and lifts nothing else. Every
// other rule — authorization, membership, overlap, working hours, time off,
// large jobs, and reschedule's own past guard — must behave exactly as before.
//
// Dates are derived from the database clock rather than hard-coded, so nothing
// here expires.
//
// Run: npm run test:past-recording

import { runSuite, rpc, bookingArgs, items, SYNTHETIC_CUSTOMER } from "./lib/harness.mjs";

const summary = await runSuite("PAST APPOINTMENT RECORDING (0010)", async ({ ids, fx, rec, T }) => {
  const { shared, private: privateWs } = ids.ws;
  const { jack, dyron, victor } = ids.staff;

  const scalar = async (expr, params = []) => (await fx.query(`select ${expr} v`, params))[0].v;
  const nowMyt = await scalar(`to_char((now() at time zone 'Asia/Kuala_Lumpur'),'YYYY-MM-DD HH24:MI')`);
  const today = nowMyt.slice(0, 10);

  /** create_appointment, optionally confirming a historical record. */
  const create = (date, time, { token = T.kc, staff = jack, ws = shared, amount = 200,
                                confirmPast = undefined, override = null, customer = SYNTHETIC_CUSTOMER } = {}) => {
    const args = bookingArgs({ ws, staff, date, time, amount, override, remarks: fx.TAG, customer });
    if (confirmPast !== undefined) args.p_confirm_past = confirmPast;
    return rpc("create_appointment", token, args);
  };
  const track = (r) => { if (r.ok) fx.track(r.body); return r; };

  /** Rows THIS suite created on a date. Counting every row would be a claim
   *  about the whole database — real appointments on that date would read as a
   *  security failure when nothing had leaked. */
  const fixtureRowsOn = async (staffId, date) =>
    (await fx.query(
      `select count(*)::int n from public.appointments
        where staff_id=$1 and appt_date=$2 and remarks=$3`, [staffId, date, fx.TAG]))[0].n;

  /** The nearest PAST date on which `staffId` has nothing booked. The mirror of
   *  fx.freeDate, which only scans forward. */
  const pastFreeDate = async (staffId, startOffset = 1) => {
    for (let k = startOffset; k < startOffset + 400; k++) {
      const candidate = await scalar(
        `to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date - $1::int),'YYYY-MM-DD')`, [k]);
      const [{ n }] = await fx.query(
        `select count(*)::int n from public.appointments
          where staff_id=$1 and appt_date=$2 and status='booked'`, [staffId, candidate]);
      if (n === 0) return candidate;
    }
    throw new Error("no free past date available");
  };

  rec.check({
    id: "PR-00 business clock", actor: "db", setup: "-",
    action: "read now() at Asia/Kuala_Lumpur",
    expected: "a timestamp the guard compares against",
    actual: `${nowMyt} MYT`, ok: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(nowMyt),
  });

  // ==========================================================================
  // A. The core rule
  // ==========================================================================
  const future = await fx.freeDate(jack, { offsetDays: 500 });
  const r1 = track(await create(future, "10:00"));
  rec.check({
    id: "PR-01 future create needs no confirmation", actor: "KC", setup: "-",
    action: `create on ${future} 10:00 with no p_confirm_past`,
    expected: "ALLOWED — unchanged behaviour",
    actual: r1.ok ? "created" : r1.msg, ok: r1.ok,
  });

  // A past date Jack is actually free on, so these checks cannot fail on an
  // overlap with a real appointment.
  const yesterday = await pastFreeDate(jack, 1);
  const r2 = track(await create(yesterday, "10:00"));
  rec.check({
    id: "PR-02 past create without confirmation DENIED (CRITICAL)", actor: "KC", setup: "-",
    action: `create on ${yesterday} 10:00 with no p_confirm_past`,
    expected: "REJECT — the flag fails closed when absent",
    actual: r2.ok ? "CREATED" : r2.msg,
    ok: !r2.ok && /must be in the future/i.test(r2.msg), security: true,
  });
  rec.check({
    id: "PR-03 the refused past create left no row (CRITICAL)", actor: "KC", setup: "-",
    action: "count appointments on that date",
    expected: "0",
    actual: `${await fixtureRowsOn(jack, yesterday)} fixture row(s)`,
    ok: (await fixtureRowsOn(jack, yesterday)) === 0, security: true,
  });

  const r4 = track(await create(yesterday, "10:00", { confirmPast: true }));
  rec.check({
    id: "PR-04 past create WITH confirmation is recorded", actor: "KC",
    setup: "the owner explicitly confirmed a historical record",
    action: `create on ${yesterday} 10:00 with p_confirm_past = true`,
    expected: "ALLOWED",
    actual: r4.ok ? "recorded" : r4.msg, ok: r4.ok,
  });

  const r5 = track(await create(yesterday, "13:00", { confirmPast: false }));
  rec.check({
    id: "PR-05 an explicit false is still a refusal", actor: "KC", setup: "-",
    action: "create in the past with p_confirm_past = false",
    expected: "REJECT",
    actual: r5.ok ? "CREATED" : r5.msg,
    ok: !r5.ok && /must be in the future/i.test(r5.msg), security: true,
  });

  const r6 = track(await create(yesterday, "15:00", { confirmPast: null }));
  rec.check({
    id: "PR-06 a null confirmation fails closed (CRITICAL)", actor: "KC",
    setup: "null must not read as true",
    action: "create in the past with p_confirm_past = null",
    expected: "REJECT",
    actual: r6.ok ? "CREATED" : r6.msg,
    ok: !r6.ok && /must be in the future/i.test(r6.msg), security: true,
  });

  // ==========================================================================
  // B. Same-day boundary — the correction that matters
  // ==========================================================================
  // "Past" is the COMBINED datetime, not the date. Earlier today is past;
  // later today is not.
  {
    const earlier = await create(today, "00:00");
    rec.check({
      id: "PR-07 earlier today needs confirmation", actor: "KC", setup: `it is ${nowMyt} MYT`,
      action: `create on ${today} 00:00 with no confirmation`,
      expected: "REJECT — midnight today is always behind the clock",
      actual: earlier.ok ? "CREATED" : earlier.msg,
      ok: !earlier.ok && /must be in the future/i.test(earlier.msg), security: true,
    });
    if (earlier.ok) fx.track(earlier.body);

    // 00:00 is outside the 09:00-19:00 business window, so it is refused for
    // working hours rather than for being past — correct, and what PR-11
    // asserts. To test the PAST rule alone, use a time earlier today that is
    // inside the window.
    // Someone with nothing booked today, so a real appointment cannot make this
    // fail on an overlap rather than on the rule it tests.
    // Deterministic, at any hour of any day, with any amount of manual data.
    //
    // The earlier versions of this check depended on the state of the database
    // and the clock — "a staff member with nothing booked today", then "a gap
    // before 10:30" — and skipped whenever reality did not oblige. Run at
    // 00:45, no past time today is inside the 09:00-19:00 window at all, so the
    // check simply disappeared and the branch lost its coverage.
    //
    // So the fixture MAKES the conditions instead of waiting for them: give one
    // staff member an all-day window on today's weekday, and record at 00:00,
    // which is at or behind the clock at every instant of every day. The window
    // is restored by exact row id at teardown.
    const todayDow = await scalar(
      `extract(dow from (now() at time zone 'Asia/Kuala_Lumpur')::date)::int`);
    const [gapStaff] = await fx.query(
      `select s.id
         from public.staff s
         left join public.appointments a
           on a.staff_id = s.id and a.status = 'booked'
          and a.appt_date = (now() at time zone 'Asia/Kuala_Lumpur')::date
          and a.start_time < '02:00'::time
        where s.is_active
        group by s.id
       having count(a.id) = 0
        limit 1`);

    if (gapStaff) {
      await fx.setWorkingHours(gapStaff.id, todayDow, "00:00", "23:59");
      const isVictor = gapStaff.id === victor;
      const earlierConfirmed = track(await create(today, "00:00", {
        confirmPast: true, staff: gapStaff.id, ws: isVictor ? privateWs : shared }));
      rec.check({
        id: "PR-08 earlier today IS recordable when confirmed", actor: "KC",
        setup: `it is ${nowMyt} MYT; the staff member has an all-day window today`,
        action: `create on ${today} 00:00 with p_confirm_past = true`,
        expected: "ALLOWED — 00:00 today is behind the clock at every hour",
        actual: earlierConfirmed.ok ? "recorded" : earlierConfirmed.msg, ok: earlierConfirmed.ok,
      });
    } else {
      rec.skip({
        id: "PR-08 earlier today IS recordable when confirmed", actor: "KC",
        reason: "every staff member already has a booking before 02:00 today",
      });
    }

    // Later today, clamped to 23:59 so this runs at any hour except the final
    // minute of the day.
    const minutesNow = Number(nowMyt.slice(11, 13)) * 60 + Number(nowMyt.slice(14, 16));
    const laterMinutes = Math.min(minutesNow + 30, 24 * 60 - 1);
    if (laterMinutes > minutesNow) {
      const later = `${String(Math.floor(laterMinutes / 60)).padStart(2, "0")}:${String(laterMinutes % 60).padStart(2, "0")}`;
      const r = await create(today, later, { staff: victor, ws: privateWs });
      if (r.ok) fx.track(r.body);
      rec.check({
        id: "PR-09 later today is NOT treated as past", actor: "KC", setup: `it is ${nowMyt} MYT`,
        action: `create on ${today} ${later} with no confirmation`,
        expected: "never refused for being in the past",
        actual: r.ok ? "created" : r.msg,
        ok: r.ok || !/must be in the future/i.test(r.msg),
      });
    } else {
      rec.skip({
        id: "PR-09 later today is NOT treated as past", actor: "KC",
        reason: `it is ${nowMyt} MYT — the final minute of the day`,
      });
    }
  }

  // ==========================================================================
  // C. Confirmation lifts the past rule and NOTHING else
  // ==========================================================================
  {
    // Physical overlap: PR-04 already recorded Jack at yesterday 10:00.
    const overlap = await create(yesterday, "10:00", { confirmPast: true, amount: 200 });
    if (overlap.ok) fx.track(overlap.body);
    rec.check({
      id: "PR-10 a historical record still cannot overlap (CRITICAL)", actor: "KC",
      setup: "Jack already has a recorded job at that time",
      action: "record a second past job in the same slot",
      expected: "REJECT — overlap is never overridable",
      actual: overlap.ok ? "CREATED" : overlap.msg,
      ok: !overlap.ok && /overlap/i.test(overlap.msg), security: true,
    });
  }

  {
    // Working hours: give Dyron a narrow window on the weekday of a past date.
    const pastDate = await pastFreeDate(dyron, 8);
    const dow = await scalar(`extract(dow from $1::date)::int`, [pastDate]);
    // Tracked and restored by exact row id, not deleted by weekday.
    await fx.setWorkingHours(dyron, dow, "09:00", "12:00");

    const outside = await create(pastDate, "16:00", { confirmPast: true, staff: dyron });
    if (outside.ok) fx.track(outside.body);
    rec.check({
      id: "PR-11 working hours still apply to a historical record (CRITICAL)", actor: "KC",
      setup: `Dyron works 09:00-12:00 on that weekday`,
      action: `record a past job at 16:00 on ${pastDate}`,
      expected: "REJECT — confirmation lifts only the past rule",
      actual: outside.ok ? "CREATED" : outside.msg,
      ok: !outside.ok && /outside working hours/i.test(outside.msg), security: true,
    });

    const inside = track(await create(pastDate, "10:00", { confirmPast: true, staff: dyron }));
    rec.check({
      id: "PR-12 inside those hours the historical record is accepted", actor: "KC", setup: "-",
      action: `record a past job at 10:00 on ${pastDate}`,
      expected: "ALLOWED",
      actual: inside.ok ? "recorded" : inside.msg, ok: inside.ok,
    });
  }

  {
    // Time off.
    const offDate = await pastFreeDate(jack, 15);
    const off = await rpc("set_staff_time_off", T.kc, {
      p_staff_id: jack, p_off_date: offDate, p_start_time: null, p_end_time: null,
      p_reason: "REGRESSION: historical time off",
    });
    if (off.ok) fx.trackTimeOff(off.body);
    // Assert the SETUP worked. The first version of this check passed the wrong
    // parameter name, so no time off was ever created and the booking succeeded
    // for an entirely mundane reason — which read as a product defect.
    rec.check({
      id: "PR-13a the time-off fixture was actually created", actor: "KC", setup: "-",
      action: `set full-day time off for Jack on ${offDate}`,
      expected: "created — otherwise the check below proves nothing",
      actual: off.ok ? "created" : off.msg, ok: off.ok,
    });
    const blocked = await create(offDate, "10:00", { confirmPast: true });
    if (blocked.ok) fx.track(blocked.body);
    rec.check({
      id: "PR-13 time off still blocks a historical record (CRITICAL)", actor: "KC",
      setup: `Jack has full-day time off on ${offDate}`,
      action: "record a past job that day",
      expected: "REJECT",
      actual: blocked.ok ? "CREATED" : blocked.msg,
      ok: !blocked.ok && !/must be in the future/i.test(blocked.msg), security: true,
    });
  }

  {
    // Large-job rules still classify and still need an override reason.
    const bigDate = await fx.freeDate(dyron, { offsetDays: 620 });
    const past = await scalar(`to_char(($1::date - 400),'YYYY-MM-DD')`, [bigDate]);
    void past;
    const largeDate = await pastFreeDate(victor, 22);
    const first = track(await create(largeDate, "10:00", { confirmPast: true, staff: victor, ws: privateWs, amount: 800 }));
    rec.check({
      id: "PR-14 a historical large job is still classified", actor: "KC",
      setup: "RM800 is over the threshold",
      action: `record it on ${largeDate}`,
      expected: "ALLOWED and flagged as a large job",
      actual: first.ok
        ? `is_large_job=${(await fx.appointment(first.body)).is_large_job}`
        : first.msg,
      ok: first.ok && (await fx.appointment(first.body)).is_large_job === true,
    });

    const second = await create(largeDate, "15:00", { confirmPast: true, staff: victor, ws: privateWs, amount: 200 });
    if (second.ok) fx.track(second.body);
    rec.check({
      id: "PR-15 the large-job forward lock still applies historically (CRITICAL)", actor: "KC",
      setup: "the recorded RM800 job holds the rest of that day",
      action: "record a later job the same day with no override reason",
      expected: "REJECT — large-job rules are not lifted by past confirmation",
      actual: second.ok ? "CREATED" : second.msg,
      ok: !second.ok && !/must be in the future/i.test(second.msg), security: true,
    });
  }

  // ==========================================================================
  // D. Authorization is untouched
  // ==========================================================================
  {
    const pastDate = await pastFreeDate(victor, 30);
    const forged = await rpc("create_appointment", T.nick, {
      ...bookingArgs({ ws: privateWs, staff: victor, date: pastDate, time: "10:00", amount: 200, remarks: fx.TAG }),
      p_confirm_past: true,
    });
    if (forged.ok) fx.track(forged.body);
    const random = await rpc("create_appointment", T.nick, {
      ...bookingArgs({ ws: privateWs, staff: "3f2b7c58-0000-4000-8000-1234567890ab",
        date: pastDate, time: "10:00", amount: 200, remarks: fx.TAG }),
      p_confirm_past: true,
    });

    rec.check({
      id: "PR-16 Nick cannot record history for Victor (CRITICAL)", actor: "NICK",
      setup: "p_confirm_past = true, Victor's real id and the private workspace",
      action: "attempt a historical record",
      expected: "REJECT, and no row",
      actual: `${forged.ok ? "CREATED" : forged.msg} · ${await fixtureRowsOn(victor, pastDate)} fixture row(s)`,
      ok: !forged.ok && (await fixtureRowsOn(victor, pastDate)) === 0, security: true,
    });
    rec.check({
      id: "PR-17 forged Victor and a random uuid stay indistinguishable (CRITICAL)", actor: "NICK",
      setup: "same call, one with Victor's id and one with a uuid that does not exist",
      action: "compare status and message",
      expected: "identical — confirmation must not become an oracle",
      actual: `victor=${forged.status}:"${forged.msg}" random=${random.status}:"${random.msg}"`,
      ok: forged.status === random.status && forged.msg === random.msg, security: true,
    });
  }

  {
    // Staff record history for themselves only, and never for someone else.
    const pastDate = await pastFreeDate(jack, 31);
    const own = await rpc("create_appointment", T.jack, {
      p_workspace_id: shared, p_staff_id: null, ...SYNTHETIC_CUSTOMER,
      p_appt_date: pastDate, p_start_time: "10:00", p_items: items(200),
      p_final_duration_override_min: null, p_remarks: fx.TAG,
      p_large_job_override_reason: null, p_confirm_past: true,
    });
    if (own.ok) fx.track(own.body);
    rec.check({
      id: "PR-18 staff may record their own history", actor: "JACK", setup: "-",
      action: `self-record on ${pastDate}`,
      expected: "ALLOWED, bound to Jack",
      actual: own.ok ? `staff=${(await fx.appointment(own.body)).staff_id === jack ? "JACK" : "WRONG"}` : own.msg,
      ok: own.ok && (await fx.appointment(own.body)).staff_id === jack,
    });

    const forOther = await rpc("create_appointment", T.jack, {
      ...bookingArgs({ ws: shared, staff: dyron, date: await pastFreeDate(dyron, 32), time: "10:00", amount: 200, remarks: fx.TAG }),
      p_confirm_past: true,
    });
    if (forOther.ok) fx.track(forOther.body);
    const bound = forOther.ok ? (await fx.appointment(forOther.body)).staff_id === jack : true;
    rec.check({
      id: "PR-19 staff cannot record history for anyone else (CRITICAL)", actor: "JACK",
      setup: "passes Dyron's staff id with confirmation",
      action: "attempt it",
      expected: "refused, or silently bound to Jack — never Dyron",
      actual: forOther.ok ? `created, bound to ${bound ? "JACK" : "DYRON"}` : forOther.msg,
      ok: bound, security: true,
    });
  }

  // ==========================================================================
  // E. Reschedule stays locked
  // ==========================================================================
  {
    const seedDate = await fx.freeDate(jack, { offsetDays: 700 });
    const seed = track(await create(seedDate, "10:00"));
    if (seed.ok) {
      for (const [id, label, args] of [
        ["PR-20", "to yesterday", { p_new_date: yesterday, p_new_start_time: "10:00" }],
        ["PR-21", "to midnight today", { p_new_date: today, p_new_start_time: "00:00" }],
      ]) {
        const r = await rpc("reschedule_appointment", T.kc, {
          p_appointment_id: seed.body, ...args, p_large_job_override_reason: null });
        rec.check({
          id: `${id} reschedule ${label} still DENIED (CRITICAL)`, actor: "KC",
          setup: "0010 changed create only",
          action: `reschedule ${label}`,
          expected: "REJECT — back-dating is not historical recording",
          actual: r.ok ? "MOVED" : r.msg,
          ok: !r.ok && /must be in the future/i.test(r.msg), security: true,
        });
      }

      // And it must not become possible by smuggling the flag in.
      const smuggle = await rpc("reschedule_appointment", T.kc, {
        p_appointment_id: seed.body, p_new_date: yesterday, p_new_start_time: "11:00",
        p_large_job_override_reason: null, p_confirm_past: true });
      rec.check({
        id: "PR-22 a confirmation flag cannot be smuggled into reschedule (CRITICAL)",
        actor: "KC", setup: "-",
        action: "call reschedule_appointment with p_confirm_past = true",
        expected: "refused — the parameter does not exist there",
        actual: smuggle.ok ? "MOVED" : `HTTP ${smuggle.status}: ${smuggle.msg.slice(0, 60)}`,
        ok: !smuggle.ok, security: true,
      });
    }
  }

  // ==========================================================================
  // F. Signature hygiene
  // ==========================================================================
  {
    const sigs = await fx.query(
      `select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
        where ns.nspname='public' and p.proname='create_appointment'`);
    rec.check({
      id: "PR-23 exactly one create_appointment signature (CRITICAL)", actor: "db",
      setup: "an overload would make PostgREST resolution ambiguous",
      action: "count the functions",
      expected: "1",
      actual: `${sigs[0].n}`, ok: sigs[0].n === 1, security: true,
    });

    const grants = await fx.query(
      `select has_function_privilege('anon',p.oid,'execute') a,
              has_function_privilege('authenticated',p.oid,'execute') au
         from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
        where ns.nspname='public' and p.proname='create_appointment'`);
    rec.check({
      id: "PR-24 grants survived the drop and recreate (CRITICAL)", actor: "db", setup: "-",
      action: "check execute privileges",
      expected: "anon = false, authenticated = true",
      actual: `anon=${grants[0].a} authenticated=${grants[0].au}`,
      ok: grants[0].a === false && grants[0].au === true, security: true,
    });

    const validator = await fx.query(
      `select has_function_privilege('authenticated',p.oid,'execute') au
         from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
        where ns.nspname='public' and p.proname='assert_appointment_slot_available'`);
    rec.check({
      id: "PR-25 the internal validator is still not callable (CRITICAL)", actor: "db",
      setup: "0010 must not have widened anything",
      action: "check execute privilege for authenticated",
      expected: "false",
      actual: `${validator[0].au}`, ok: validator[0].au === false, security: true,
    });
  }
});

process.exit(summary.fail === 0 ? 0 : 1);
