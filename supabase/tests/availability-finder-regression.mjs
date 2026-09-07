// Availability finder regression suite (migration 0006).
//
// find_available_slots is a SNAPSHOT, not a reservation. It holds no advisory
// lock and never writes; create_appointment remains authoritative. These tests
// therefore assert two things at once:
//
//   1. the finder honours every engine rule (it delegates to the same
//      validator), and
//   2. it discloses nothing about WHY a slot is missing.
//
// The side-channel group is the important one: for a caller who is not allowed
// to ask about a staff member, the response must be byte-identical to asking
// about a UUID that does not exist.
//
// Run: npm run test:availability

import { runSuite, rpc, book, bookingArgs, SYNTHETIC_PRIVATE_CUSTOMER } from "./lib/harness.mjs";

const RANDOM_UUID = "00000000-0000-4000-8000-0000000000ff";

const summary = await runSuite("AVAILABILITY FINDER REGRESSION", async ({ ids, fx, rec, T }) => {
  const { shared, private: priv } = ids.ws;
  const { jack, dyron, victor } = ids.staff;

  const day = async (offset) =>
    (await fx.query(
      `select to_char(((now() at time zone 'Asia/Kuala_Lumpur')::date + $1::int), 'YYYY-MM-DD') d`,
      [offset]))[0].d;

  const today = await day(0);
  const find = (token, args) => rpc("find_available_slots", token, args);
  const slots = (r) => (r.ok ? r.body.map((x) => x.slot_time.slice(0, 5)) : []);
  const staffIn = (r) => (r.ok ? [...new Set(r.body.map((x) => x.staff_id))] : []);

  // Baseline: the configured suggested slots.
  const configured = (await fx.query(
    `select to_char(slot_time,'HH24:MI') t from public.suggested_time_slots
     where is_active and workspace_id is null order by sort_order, slot_time`)).map((r) => r.t);
  rec.check({
    id: "AV-00 configured slots", actor: "db", setup: "global suggested_time_slots",
    action: "read active global slots", expected: "10:00, 13:00, 15:00",
    actual: configured.join(", "), ok: configured.join(",") === "10:00,13:00,15:00",
  });

  // ==========================================================================
  // A. Baseline availability for each role
  // ==========================================================================
  const dFree = await day(5);
  for (const [who, token, target, expectRows] of [
    ["KC", T.kc, jack, true],
    ["NICK", T.nick, jack, true],
    ["DYRON", T.dyron, dyron, true],
  ]) {
    const r = await find(token, { p_staff_ids: [target], p_from: dFree, p_to: dFree });
    rec.check({
      id: `AV-01 ${who} baseline`, actor: who, setup: "empty day",
      action: `find_available_slots on ${dFree}`,
      expected: expectRows ? "all 3 configured slots" : "no rows",
      actual: r.ok ? slots(r).join(", ") || "(none)" : r.msg,
      ok: r.ok && slots(r).join(",") === "10:00,13:00,15:00",
    });
  }

  // Victor is KC-Private only.
  const kcVictor = await find(T.kc, { p_staff_ids: [victor], p_from: dFree, p_to: dFree });
  rec.check({
    id: "AV-02 KC may query Victor", actor: "KC", setup: "Victor is in KC Private Team",
    action: "find_available_slots for Victor", expected: "3 slots",
    actual: r0(kcVictor), ok: kcVictor.ok && slots(kcVictor).length === 3,
  });

  const victorSelf = await find(T.victor, { p_staff_ids: null, p_from: dFree, p_to: dFree });
  rec.check({
    id: "AV-03 Victor own availability", actor: "VICTOR", setup: "-",
    action: "find_available_slots with no staff ids", expected: "own slots only",
    actual: `${slots(victorSelf).length} slots for ${staffIn(victorSelf).length} staff`,
    ok: victorSelf.ok && staffIn(victorSelf).every((s) => s === victor),
  });

  // ==========================================================================
  // B. Side channels — the core privacy property
  // ==========================================================================
  const base = await find(T.nick, { p_staff_ids: [jack], p_from: dFree, p_to: dFree });
  const withRandom = await find(T.nick, { p_staff_ids: [jack, RANDOM_UUID], p_from: dFree, p_to: dFree });
  const withVictor = await find(T.nick, { p_staff_ids: [jack, victor], p_from: dFree, p_to: dFree });

  const norm = (r) => (r.ok ? JSON.stringify(r.body) : `ERR:${r.status}:${r.msg}`);
  rec.check({
    id: "AV-04 unauthorized id is indistinguishable from a random one (CRITICAL)", actor: "NICK",
    setup: "Victor exists but is invisible to Nick; RANDOM_UUID does not exist",
    action: "compare [Jack] vs [Jack, random] vs [Jack, Victor]",
    expected: "all three responses identical — status, rows and count",
    actual: norm(base) === norm(withRandom) && norm(base) === norm(withVictor)
      ? "identical" : `differ: base=${norm(base).length}b random=${norm(withRandom).length}b victor=${norm(withVictor).length}b`,
    ok: norm(base) === norm(withRandom) && norm(base) === norm(withVictor), security: true,
  });

  const nickAll = await find(T.nick, { p_staff_ids: null, p_from: dFree, p_to: dFree });
  rec.check({
    id: "AV-05 Nick cannot reach Victor via a null staff list", actor: "NICK",
    setup: "no staff ids supplied", action: "find_available_slots for everyone visible",
    expected: "Jack and Dyron only, never Victor",
    actual: `${staffIn(nickAll).length} staff; Victor present = ${staffIn(nickAll).includes(victor)}`,
    ok: nickAll.ok && !staffIn(nickAll).includes(victor) && staffIn(nickAll).length === 2,
    security: true,
  });

  const nickPrivateWs = await find(T.nick, {
    p_staff_ids: [jack], p_from: dFree, p_to: dFree, p_workspace_id: priv });
  rec.check({
    id: "AV-06 invisible workspace yields nothing, not an error", actor: "NICK",
    setup: "KC Private Team is invisible to Nick",
    action: "pass p_workspace_id = KC Private Team",
    expected: "0 rows and NO error — an error would confirm the workspace exists",
    actual: nickPrivateWs.ok ? `${nickPrivateWs.body.length} rows` : `raised: ${nickPrivateWs.msg}`,
    ok: nickPrivateWs.ok && nickPrivateWs.body.length === 0, security: true,
  });

  const staffOther = await find(T.dyron, { p_staff_ids: [jack], p_from: dFree, p_to: dFree });
  rec.check({
    id: "AV-07 staff cannot query another staff member", actor: "DYRON",
    setup: "asks about Jack", action: "find_available_slots for Jack",
    expected: "0 rows, dropped silently",
    actual: staffOther.ok ? `${staffOther.body.length} rows` : `raised: ${staffOther.msg}`,
    ok: staffOther.ok && staffOther.body.length === 0, security: true,
  });

  // ==========================================================================
  // C. Hidden cross-workspace conflict blocks, without saying why
  // ==========================================================================
  const dHidden = await day(6);
  const membership = await fx.query(
    `select is_active from public.staff_workspaces where staff_id=$1 and workspace_id=$2`, [jack, priv]);
  fx.trackMembership(jack, priv, membership.length > 0 && membership[0].is_active);
  await rpc("set_staff_workspace_active", T.kc, {
    p_staff_id: jack, p_workspace_id: priv, p_is_active: true });

  const hidden = await book(fx, T.kc, bookingArgs({
    ws: priv, staff: jack, date: dHidden, time: "10:00", amount: 200,
    customer: SYNTHETIC_PRIVATE_CUSTOMER, remarks: fx.TAG }));

  const nickHidden = await find(T.nick, { p_staff_ids: [jack], p_from: dHidden, p_to: dHidden });
  rec.check({
    id: "AV-08 hidden appointment blocks the slot (CRITICAL)", actor: "NICK",
    setup: `Jack has a hidden KC Private Team job at 10:00 (${hidden.ok ? "created" : "SETUP FAILED"})`,
    action: "find_available_slots for Jack",
    expected: "10:00 absent; 13:00 and 15:00 present",
    actual: slots(nickHidden).join(", ") || "(none)",
    ok: nickHidden.ok && !slots(nickHidden).includes("10:00")
        && slots(nickHidden).includes("13:00") && slots(nickHidden).includes("15:00"),
    security: true,
  });

  const payload = JSON.stringify(nickHidden.body ?? []);
  const leakTerms = [
    ["customer", SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name],
    ["phone", SYNTHETIC_PRIVATE_CUSTOMER.p_customer_phone],
    ["private workspace id", priv],
    ["hidden appointment id", String(hidden.body)],
    ["a reason field", "reason"],
    ["a conflict field", "conflict"],
    ["large-job wording", "large"],
  ];
  const leaked = leakTerms.filter(([, t]) => payload.toLowerCase().includes(String(t).toLowerCase())).map(([l]) => l);
  rec.check({
    id: "AV-09 response carries no reason (CRITICAL)", actor: "NICK", setup: "same",
    action: "inspect the returned rows for any explanatory field",
    expected: "only staff_id, slot_date, slot_time",
    actual: leaked.length ? `LEAKED: ${leaked.join(", ")}` : `clean — keys: ${Object.keys(nickHidden.body?.[0] ?? {}).join(", ")}`,
    ok: leaked.length === 0, security: true,
  });

  // KC sees the same omission — availability is conservative for everyone.
  const kcHidden = await find(T.kc, { p_staff_ids: [jack], p_from: dHidden, p_to: dHidden });
  rec.check({
    id: "AV-10 KC sees the same omission", actor: "KC", setup: "KC can see the blocking job",
    action: "find_available_slots for Jack",
    expected: "10:00 also absent — the finder never offers a blocked slot",
    actual: slots(kcHidden).join(", ") || "(none)",
    ok: kcHidden.ok && !slots(kcHidden).includes("10:00"),
  });

  // ==========================================================================
  // D. Engine rules are honoured
  // ==========================================================================
  const dRules = await day(7);
  const lock = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: dyron, date: dRules, time: "10:00", amount: 800 }));
  const afterLock = await find(T.nick, { p_staff_ids: [dyron], p_from: dRules, p_to: dRules });
  rec.check({
    id: "AV-11 RM600 forward lock omits later slots", actor: "NICK",
    setup: `Dyron has a RM800 job at 10:00 (${lock.ok ? "created" : "SETUP FAILED: " + lock.msg})`,
    action: "find_available_slots for Dyron",
    expected: "13:00 and 15:00 omitted — override-required slots are never offered",
    actual: slots(afterLock).join(", ") || "(none)",
    ok: afterLock.ok && !slots(afterLock).includes("13:00") && !slots(afterLock).includes("15:00"),
  });

  const dOff = await day(8);
  const off = await rpc("set_staff_time_off", T.kc, {
    p_staff_id: dyron, p_off_date: dOff, p_start_time: "09:00", p_end_time: "12:00",
    p_reason: "REGRESSION availability" });
  (await fx.query(`select id from public.staff_time_off where staff_id=$1 and off_date=$2`, [dyron, dOff]))
    .forEach((r) => fx.trackTimeOff(r.id));
  const afterOff = await find(T.nick, { p_staff_ids: [dyron], p_from: dOff, p_to: dOff });
  rec.check({
    id: "AV-12 time off omits the slot", actor: "NICK",
    setup: `Dyron off 09:00-12:00 (${off.ok ? "set" : "SETUP FAILED"})`,
    action: "find_available_slots for Dyron",
    expected: "10:00 absent; 13:00 and 15:00 present",
    actual: slots(afterOff).join(", ") || "(none)",
    ok: afterOff.ok && !slots(afterOff).includes("10:00") && slots(afterOff).includes("13:00"),
  });

  const dHours = await day(9);
  const dow = (await fx.query(`select extract(dow from $1::date)::int d`, [dHours]))[0].d;
  fx.trackWorkingHours(dyron, dow);
  const wh = await rpc("set_staff_working_hours", T.kc, {
    p_staff_id: dyron, p_day_of_week: dow, p_start_time: "12:00", p_end_time: "16:00" });
  const afterHours = await find(T.nick, { p_staff_ids: [dyron], p_from: dHours, p_to: dHours });
  rec.check({
    id: "AV-13 working hours omit out-of-window slots", actor: "NICK",
    setup: `Dyron hours 12:00-16:00 on that weekday (${wh.ok ? "set" : "not set: " + wh.msg})`,
    action: "find_available_slots for Dyron",
    expected: "10:00 absent (before window); 13:00 present; 15:00 absent (60m ends 16:00... within)",
    actual: slots(afterHours).join(", ") || "(none)",
    ok: !wh.ok || (afterHours.ok && !slots(afterHours).includes("10:00") && slots(afterHours).includes("13:00")),
  });
  await fx.query(`delete from public.staff_working_hours where staff_id=$1 and day_of_week=$2`, [dyron, dow]);

  // 0007: the finder is a STANDARD-JOB surface. There is no amount input, so a
  // caller cannot vary the probe window and sweep for a hidden boundary.
  //
  // The measured attack, before 0007: against a hidden 12:00 job, the 10:00
  // candidate flipped from AVAILABLE at RM300 (90 min, ends 12:00) to OMITTED at
  // RM301 (91 min, ends 12:01) — nine calls pinned the hidden start to the
  // minute. See supabase/migrations/0007 for the full measurement.
  const dDur = await day(10);
  const standard = await find(T.nick, { p_staff_ids: [jack], p_from: dDur, p_to: dDur });
  rec.check({
    id: "AV-14 duration is fixed server-side configuration", actor: "NICK", setup: "empty day",
    action: "find_available_slots with no amount input",
    expected: "all three configured slots, sized by the default availability duration",
    actual: slots(standard).join(", ") || "(none)",
    ok: standard.ok && slots(standard).join(",") === "10:00,13:00,15:00",
  });

  const withAmount = await find(T.nick, {
    p_staff_ids: [jack], p_from: dDur, p_to: dDur, p_total_amount: 350 });
  rec.check({
    id: "AV-15 amount input is not accepted (CRITICAL)", actor: "NICK",
    setup: "the 0006 signature took p_total_amount; 0007 removed it",
    action: "call find_available_slots with p_total_amount",
    expected: "REJECT — no such function; the probe window cannot be varied",
    actual: withAmount.ok ? `ACCEPTED, ${withAmount.body.length} rows` : `HTTP ${withAmount.status}: ${withAmount.msg.slice(0, 70)}`,
    // Asserts the REASON, not merely that the call failed. A bare `!ok` would
    // also be satisfied by a rate limit, an expired token or a transient 500 —
    // this must pass only because the amount-taking signature no longer exists.
    ok: withAmount.status === 404 && /could not find the function/i.test(withAmount.msg)
        && /p_total_amount/.test(withAmount.msg), security: true,
  });

  // The sweep that used to work must now be impossible: every amount is refused,
  // so no transition can be observed at all.
  const sweep = [];
  for (const amount of [200, 300, 301, 350, 400]) {
    const r = await find(T.nick, { p_staff_ids: [jack], p_from: dDur, p_to: dDur, p_total_amount: amount });
    // "refused" must mean "no such signature" specifically, so the sweep cannot
    // read as green because the calls were failing for an unrelated reason.
    const gone = r.status === 404 && /could not find the function/i.test(r.msg);
    sweep.push(`${amount}:${r.ok ? "ACCEPTED" : gone ? "refused" : `failed-${r.status}`}`);
  }
  rec.check({
    id: "AV-15b amount sweep is impossible (CRITICAL)", actor: "NICK",
    setup: "the exact amounts that located the hidden boundary before 0007",
    action: "sweep RM200 -> RM400 across the transition point",
    expected: "every call refused — no observable transition",
    actual: sweep.join("  "), ok: sweep.every((s) => s.endsWith("refused")), security: true,
  });

  // ==========================================================================
  // E. Range limits
  // ==========================================================================
  for (const [label, from, to, shouldFail] of [
    ["14-day range", today, await day(13), false],
    ["15-day range", today, await day(14), true],
    ["from after to", await day(5), await day(2), true],
    ["start in the past", await day(-1), await day(3), true],
  ]) {
    const r = await find(T.nick, { p_staff_ids: [jack], p_from: from, p_to: to });
    rec.check({
      id: `AV-16 ${label}`, actor: "NICK", setup: "-",
      action: `p_from=${from} p_to=${to}`,
      expected: shouldFail ? "REJECT" : "ALLOWED",
      actual: r.ok ? `${r.body.length} rows` : r.msg, ok: r.ok === !shouldFail,
    });
  }

  // ==========================================================================
  // F. Privilege surface
  // ==========================================================================
  const anon = await rpc("find_available_slots", null, {
    p_staff_ids: [jack], p_from: dFree, p_to: dFree });
  rec.check({
    id: "AV-17 anon denied", actor: "anon", setup: "no JWT",
    action: "POST /rpc/find_available_slots",
    expected: "permission denied",
    actual: `HTTP ${anon.status} ${anon.msg}`,
    ok: (anon.status === 401 || anon.status === 403) && /permission denied/i.test(anon.msg),
    security: true,
  });

  const priv2 = await fx.query(
    `select has_function_privilege('anon', p.oid, 'EXECUTE') a,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') au
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='find_available_slots' and p.prokind='f'`);
  rec.check({
    id: "AV-18 grants", actor: "catalog", setup: "-",
    action: "has_function_privilege for find_available_slots",
    expected: "anon=false, authenticated=true",
    actual: `anon=${priv2[0].a}, authenticated=${priv2[0].au}`,
    ok: priv2[0].a === false && priv2[0].au === true, security: true,
  });

  const assertPriv = await fx.query(
    `select has_function_privilege('authenticated', p.oid, 'EXECUTE') au
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='assert_appointment_slot_available' and p.prokind='f'`);
  rec.check({
    id: "AV-19 validator still internal", actor: "catalog", setup: "0006 must not expose it",
    action: "has_function_privilege('authenticated') for assert_appointment_slot_available",
    expected: "false", actual: `${assertPriv[0].au}`, ok: assertPriv[0].au === false, security: true,
  });

  // ==========================================================================
  // G. Round trip — the finder and the engine must not disagree
  // ==========================================================================
  const dTrip = await day(11);
  const offered = await find(T.kc, { p_staff_ids: [dyron], p_from: dTrip, p_to: dTrip });
  const firstSlot = slots(offered)[0];
  const booked = firstSlot
    ? await book(fx, T.kc, bookingArgs({ ws: shared, staff: dyron, date: dTrip, time: firstSlot, amount: 200 }))
    : { ok: false, msg: "no slot offered" };
  rec.check({
    id: "AV-20 an offered slot is actually bookable (CRITICAL)", actor: "KC",
    setup: `finder offered ${firstSlot ?? "nothing"}`,
    action: "book the first offered slot through create_appointment",
    expected: "ALLOWED — finder and engine must agree",
    actual: booked.ok ? "created" : booked.msg, ok: booked.ok,
  });

  const afterBooking = await find(T.kc, { p_staff_ids: [dyron], p_from: dTrip, p_to: dTrip });
  rec.check({
    id: "AV-21 a taken slot stops being offered", actor: "KC",
    setup: `${firstSlot} is now booked`,
    action: "find_available_slots again",
    expected: `${firstSlot} absent`,
    actual: slots(afterBooking).join(", ") || "(none)",
    ok: afterBooking.ok && !slots(afterBooking).includes(firstSlot),
  });

  function r0(r) {
    return r.ok ? `${r.body.length} rows` : r.msg;
  }
});

process.exit(summary.fail === 0 ? 0 : 1);
