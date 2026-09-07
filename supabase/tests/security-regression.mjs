// Security regression suite.
//
// Locks in the authorization and identity-isolation defects found and fixed
// during Security QA and Stage 3B (migrations 0002, 0003, 0004, 0005).
//
//   - Nick (Shared-only Master) cannot discover Victor or KC Private Team
//   - staff identity is server-derived and cannot be spoofed
//   - an authenticated caller with NO profile has zero mutation capability
//   - internal engine functions are not callable by anon / authenticated
//   - staff cannot override duration or large-job locks
//   - override / audit tables are Master-only internal surfaces
//
// Run: npm run test:security

import { runSuite, rpc, rest, book, bookingArgs, items } from './lib/harness.mjs';

const summary = await runSuite('SECURITY REGRESSION', async ({ db, ids, fx, rec, T }) => {

  // ==========================================================================
  // 1. Nick cannot discover Victor (identity + workspace concealment)
  // ==========================================================================
  const concealment = [
    ['Victor profile', `profiles?select=id&id=eq.${ids.profile.victor}`],
    ['Victor staff row', `staff?select=id&id=eq.${ids.staff.victor}`],
    ['Victor appointments', `appointments?select=id&staff_id=eq.${ids.staff.victor}`],
    ['Victor time off', `staff_time_off?select=id&staff_id=eq.${ids.staff.victor}`],
    ['Victor workspace memberships', `staff_workspaces?select=id&staff_id=eq.${ids.staff.victor}`],
    ['KC Private Team workspace', `workspaces?select=id&id=eq.${ids.ws.private}`],
  ];
  for (const [label, path] of concealment) {
    const r = await rest(path, T.nick);
    rec.check({
      id: `SEC-01 ${label}`, actor: 'NICK', setup: 'Nick is Shared Team only',
      action: `query ${label}`, expected: '0 rows', actual: `${r.rows.length} rows`,
      ok: r.ok && r.rows.length === 0, security: true,
    });
  }

  // Unfiltered sweeps must not surface private rows either.
  const allProfiles = await rest('profiles?select=id,full_name', T.nick);
  rec.check({
    id: 'SEC-02 unfiltered profiles sweep', actor: 'NICK', setup: '5 profiles exist',
    action: 'SELECT * FROM profiles', expected: 'TEST_VICTOR absent',
    actual: `${allProfiles.rows.length} rows: ${allProfiles.rows.map(p => p.full_name).join(', ')}`,
    ok: !allProfiles.rows.some(p => p.id === ids.profile.victor), security: true,
  });
  const allStaff = await rest('staff?select=id,display_name', T.nick);
  rec.check({
    id: 'SEC-03 unfiltered staff sweep', actor: 'NICK', setup: '3 staff exist',
    action: 'SELECT * FROM staff', expected: 'TEST_VICTOR absent',
    actual: `${allStaff.rows.length} rows: ${allStaff.rows.map(s => s.display_name).join(', ')}`,
    ok: !allStaff.rows.some(s => s.id === ids.staff.victor), security: true,
  });

  // ==========================================================================
  // 2. Staff identity isolation — staff_id is server-derived, never a parameter
  // ==========================================================================
  const dIso = await fx.freeDate(ids.staff.jack);
  for (const [label, otherStaff] of [['Dyron', ids.staff.dyron], ['Victor', ids.staff.victor]]) {
    const r = await book(fx, T.jack, bookingArgs({
      ws: ids.ws.shared, staff: otherStaff, date: dIso,
      time: label === 'Dyron' ? '10:00' : '13:00', amount: 200,
    }));
    const row = r.ok ? await fx.appointment(r.body) : null;
    const boundToJack = row?.staff_id === ids.staff.jack;
    rec.check({
      id: `SEC-04 staff cannot book as ${label}`, actor: 'JACK (staff)',
      setup: `passes ${label}'s staff_id in the RPC`,
      action: 'create_appointment with a foreign staff_id',
      expected: `never creates an appointment for ${label}`,
      actual: r.ok ? (boundToJack ? 'created, bound to Jack (parameter ignored)' : `CREATED FOR ${label}`) : r.msg,
      ok: !r.ok || boundToJack, security: true,
    });
  }

  // created_by is taken from the JWT, not from the payload
  const selfBook = await book(fx, T.dyron, bookingArgs({
    ws: ids.ws.shared, staff: null, date: await fx.freeDate(ids.staff.dyron), time: '10:00', amount: 200,
  }));
  const selfRow = selfBook.ok ? await fx.appointment(selfBook.body) : null;
  rec.check({
    id: 'SEC-05 created_by is server-derived', actor: 'DYRON (staff)', setup: 'self-books',
    action: 'create_appointment with no staff_id',
    expected: 'staff_id and created_by both resolve to Dyron from the JWT',
    actual: selfBook.ok ? `staff_id=${selfRow.staff_id === ids.staff.dyron ? 'Dyron' : selfRow.staff_id}, created_by=${selfRow.created_by === ids.profile.dyron ? 'Dyron' : selfRow.created_by}` : selfBook.msg,
    ok: selfBook.ok && selfRow.staff_id === ids.staff.dyron && selfRow.created_by === ids.profile.dyron,
    security: true,
  });

  // ==========================================================================
  // 3. Staff privilege ceiling
  // ==========================================================================
  const dCeil = await fx.freeDate(ids.staff.jack);
  const durOverride = await book(fx, T.jack, bookingArgs({
    ws: ids.ws.shared, staff: null, date: dCeil, time: '10:00', amount: 200, durationOverride: 999,
  }));
  rec.check({
    id: 'SEC-06 staff cannot override duration', actor: 'JACK (staff)', setup: '-',
    action: 'create_appointment with p_final_duration_override_min = 999',
    expected: 'REJECT', actual: durOverride.ok ? 'CREATED' : durOverride.msg,
    ok: !durOverride.ok && /may not override duration/i.test(durOverride.msg), security: true,
  });

  const largeJob = await book(fx, T.kc, bookingArgs({
    ws: ids.ws.shared, staff: ids.staff.jack, date: dCeil, time: '10:00', amount: 800,
  }));
  const staffOverride = await book(fx, T.jack, bookingArgs({
    ws: ids.ws.shared, staff: null, date: dCeil, time: '16:00', amount: 200,
    override: 'staff attempts a Master override',
  }));
  rec.check({
    id: 'SEC-07 staff cannot grant a large-job override', actor: 'JACK (staff)',
    setup: `Jack has a RM800 lock at 10:00 (${largeJob.ok ? 'created' : 'SETUP FAILED: ' + largeJob.msg})`,
    action: 'create_appointment supplying a large-job override reason',
    expected: 'REJECT — override is a Master capability',
    actual: staffOverride.ok ? 'CREATED' : staffOverride.msg,
    ok: !staffOverride.ok && /may not perform a large-job override/i.test(staffOverride.msg), security: true,
  });

  // ==========================================================================
  // 4. Override / audit tables are Master-only internal surfaces (0005)
  // ==========================================================================
  for (const [who, tok] of [['JACK', T.jack], ['DYRON', T.dyron], ['VICTOR', T.victor]]) {
    const ov = await rest('appointment_rule_overrides?select=id', tok);
    const au = await rest('audit_logs?select=id', tok);
    rec.check({
      id: `SEC-08 ${who} has no override/audit access`, actor: who, setup: 'V1 internal Master surfaces',
      action: 'query appointment_rule_overrides and audit_logs',
      expected: '0 rows from both',
      actual: `overrides=${ov.rows.length} audit_logs=${au.rows.length}`,
      ok: ov.rows.length === 0 && au.rows.length === 0, security: true,
    });
  }

  // ==========================================================================
  // 5. Internal engine functions are not part of the public API surface (0002/0004)
  // ==========================================================================
  // The argument shapes must be real: PostgREST resolves the overload before it
  // reaches the privilege check, so calling with {} returns a 404 that proves
  // nothing about EXECUTE.
  const internalFns = [
    ['assert_appointment_slot_available', {
      p_staff_id: ids.staff.jack, p_appt_date: '2099-01-01', p_start_time: '10:00',
      p_final_duration_min: 60, p_buffer_minutes: 30, p_total_amount: 200,
      p_exclude_appointment_id: null, p_override_large_job: false }],
    ['can_view_conflict', { p_conflict_workspace_id: ids.ws.private, p_conflict_staff_id: null }],
  ];
  for (const [fn, args] of internalFns) {
    for (const [label, tok] of [['anon', null], ['authenticated', T.nick]]) {
      const r = await rpc(fn, tok, args);
      const denied = (r.status === 401 || r.status === 403) && /permission denied/i.test(r.msg);
      rec.check({
        id: `SEC-09 ${fn} / ${label}`, actor: label, setup: 'internal function',
        action: `POST /rpc/${fn}`, expected: 'permission denied',
        actual: `HTTP ${r.status} ${r.msg}`, ok: denied, security: true,
      });
    }
    const { rows } = await db.query(
      `select has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1 and p.prokind = 'f' limit 1`, [fn]);
    rec.check({
      id: `SEC-10 ${fn} catalog privileges`, actor: 'catalog', setup: '-',
      action: `has_function_privilege for ${fn}`, expected: 'anon=false, authenticated=false',
      actual: rows.length ? `anon=${rows[0].anon}, authenticated=${rows[0].auth}` : 'function not found',
      ok: rows.length > 0 && rows[0].anon === false && rows[0].auth === false, security: true,
    });
  }

  // anon must not read any business table
  for (const tbl of ['appointments', 'profiles', 'staff', 'workspaces', 'audit_logs', 'appointment_rule_overrides']) {
    const r = await rest(`${tbl}?select=id`, null);
    rec.check({
      id: `SEC-11 anon cannot read ${tbl}`, actor: 'anon', setup: 'no JWT',
      action: `GET /${tbl}`, expected: 'no rows returned',
      actual: `HTTP ${r.status}, ${r.rows.length} rows`, ok: r.rows.length === 0, security: true,
    });
  }

  // ==========================================================================
  // 6. An authenticated caller with NO profile has zero capability
  // ==========================================================================
  // No synthetic auth user exists without a profile, and creating one would mean
  // writing to auth.users directly. Instead this drives the database with the
  // `authenticated` role and a JWT claim for a uuid that owns no profile — the
  // exact state a newly signed-up, not-yet-provisioned account is in. The
  // fail-closed guards added in 0003 are what this asserts.
  const orphan = '00000000-0000-4000-8000-000000000000';
  const asOrphan = async (sql, params = []) => {
    await db.query('begin');
    try {
      await db.query(
        `select set_config('request.jwt.claims',
           json_build_object('sub', $1::text, 'role', 'authenticated')::text, true)`, [orphan]);
      await db.query('set local role authenticated');
      const r = await db.query(sql, params);
      return { ok: true, rows: r.rows };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      await db.query('rollback');
    }
  };

  const orphanRole = await asOrphan(`select public.my_role()::text as r, public.my_staff_id() as s`);
  rec.check({
    id: 'SEC-12 no-profile identity resolves to nothing', actor: 'authenticated/no-profile',
    setup: `jwt sub = ${orphan}`, action: 'my_role() / my_staff_id()',
    expected: 'both NULL', actual: orphanRole.ok ? `role=${orphanRole.rows[0].r}, staff=${orphanRole.rows[0].s}` : orphanRole.error,
    ok: orphanRole.ok && orphanRole.rows[0].r === null && orphanRole.rows[0].s === null, security: true,
  });

  const orphanMutations = [
    ['create_appointment', `select public.create_appointment($1,$2,'X','+60000000001','X','X',
        current_date + 900, '10:00'::time, $3::jsonb, null, 'orphan probe', null)`,
      [ids.ws.shared, ids.staff.jack, JSON.stringify(items(200))]],
    ['set_staff_active', `select public.set_staff_active($1, false)`, [ids.staff.jack]],
    // null must be cast, or overload resolution fails first and the guard is never reached
    ['set_staff_working_hours', `select public.set_staff_working_hours(null::uuid, 1::smallint, '08:00'::time, '20:00'::time)`, []],
    ['set_staff_time_off', `select public.set_staff_time_off($1, current_date + 900, null, null, 'orphan probe')`, [ids.staff.jack]],
    ['set_staff_workspace_active', `select public.set_staff_workspace_active($1, $2, true)`, [ids.staff.victor, ids.ws.shared]],
  ];
  for (const [label, sql, params] of orphanMutations) {
    const r = await asOrphan(sql, params);
    rec.check({
      id: `SEC-13 no-profile cannot ${label}`, actor: 'authenticated/no-profile', setup: '-',
      action: `call ${label}()`,
      expected: 'raises an AUTHORIZATION error — fails closed, not on a type or arity slip',
      actual: r.ok ? 'SUCCEEDED' : r.error.split('\n')[0],
      // Asserting the reason matters here more than anywhere else in this file:
      // a bare `!ok` is satisfied by an argument-type or overload-resolution
      // error raised long before the guard is reached, so the check would go
      // green while proving nothing. That very trap is why the
      // set_staff_working_hours probe above has to cast its nulls.
      ok: !r.ok && /not authorized|only (a |super )?master/i.test(r.error), security: true,
    });
  }

  // The probes above are only meaningful if they actually reach the guard, so
  // prove the failure mode they are written to avoid is real: the same call
  // WITHOUT its casts dies in overload resolution, before any authorization
  // code runs. A `!r.ok` assertion would have called that a security pass.
  const uncast = await asOrphan(`select public.set_staff_working_hours(null, 1, '08:00', '20:00')`);
  rec.check({
    id: 'SEC-13b an uncast probe never reaches the guard', actor: 'authenticated/no-profile',
    setup: 'the same call as above, with its casts removed',
    action: 'call set_staff_working_hours() with untyped nulls',
    expected: 'fails on overload resolution, NOT on authorization — which is why SEC-13 '
            + 'asserts the message and not merely that the call failed',
    actual: uncast.ok ? 'SUCCEEDED' : uncast.error.split('\n')[0],
    ok: !uncast.ok && !/not authorized|only (a |super )?master/i.test(uncast.error),
  });

  const orphanReads = ['appointments', 'profiles', 'staff', 'workspaces', 'audit_logs'];
  for (const tbl of orphanReads) {
    const r = await asOrphan(`select count(*)::int as n from public.${tbl}`);
    rec.check({
      id: `SEC-14 no-profile reads ${tbl}`, actor: 'authenticated/no-profile', setup: '-',
      action: `select from ${tbl}`, expected: '0 rows visible',
      actual: r.ok ? `${r.rows[0].n} rows` : r.error.split('\n')[0],
      ok: r.ok && r.rows[0].n === 0, security: true,
    });
  }
});

process.exit(summary.fail === 0 ? 0 : 1);
