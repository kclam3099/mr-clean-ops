// Cross-workspace privacy regression suite.
//
// The governing rule, proven in Stage 3B:
//
//   physical staff availability is GLOBAL,
//   information visibility is WORKSPACE-SCOPED.
//
// A staff member shared between workspaces blocks a slot everywhere, but a
// Master who cannot see the blocking appointment must learn only that the staff
// member is unavailable — never the time, the amount band, the reason, the
// customer, or that a second workspace exists at all.
//
// This suite CREATES its own cross-workspace fixture (it grants Jack a
// temporary KC Private Team membership) and REMOVES it in teardown, so the
// normal DEV baseline stays Jack = Shared Team only.
//
// Run: npm run test:privacy

import { runSuite, rpc, rest, book, bookingArgs, SYNTHETIC_PRIVATE_CUSTOMER } from './lib/harness.mjs';

const summary = await runSuite('CROSS-WORKSPACE PRIVACY REGRESSION', async ({ ids, fx, rec, T }) => {
  const { shared, private: priv } = ids.ws;
  const jack = ids.staff.jack;

  // ==========================================================================
  // Fixture: grant Jack a temporary second-workspace membership
  // ==========================================================================
  const before = await fx.query(
    `select is_active from public.staff_workspaces where staff_id = $1 and workspace_id = $2`, [jack, priv]);
  const preexisting = before.length > 0;
  fx.trackMembership(jack, priv, preexisting && before[0].is_active);

  const grant = await rpc('set_staff_workspace_active', T.kc, {
    p_staff_id: jack, p_workspace_id: priv, p_is_active: true });
  const isMember = (await fx.query(
    `select count(*)::int n from public.staff_workspaces
     where staff_id=$1 and workspace_id=$2 and is_active`, [jack, priv]))[0].n === 1;
  rec.check({
    id: 'XW-00 fixture: Jack shared across both workspaces', actor: 'KC (super_master)',
    setup: preexisting ? 'membership row already existed' : 'no membership row',
    action: 'grant Jack an active KC Private Team membership',
    expected: 'Jack is an active member of both workspaces',
    actual: `${grant.ok ? 'granted' : grant.msg} | active member = ${isMember}`, ok: isMember,
  });
  if (!isMember) return;

  // ==========================================================================
  // 1. Global physical availability — a hidden appointment still blocks
  // ==========================================================================
  const d1 = await fx.freeDate(jack);
  const hidden = await book(fx, T.kc, bookingArgs({
    ws: priv, staff: jack, date: d1, time: '10:00', amount: 200,
    customer: SYNTHETIC_PRIVATE_CUSTOMER, remarks: fx.TAG }));
  rec.check({
    id: 'XW-01 private appointment created', actor: 'KC', setup: 'Jack in both workspaces',
    action: 'create a KC Private Team appointment for Jack at 10:00',
    expected: 'ALLOWED', actual: hidden.ok ? 'created' : hidden.msg, ok: hidden.ok,
  });

  const blocked = await book(fx, T.nick, bookingArgs({
    ws: shared, staff: jack, date: d1, time: '10:00', amount: 200 }));
  rec.check({
    id: 'XW-02 hidden appointment blocks globally', actor: 'NICK (Shared only)',
    setup: 'Jack has a hidden private appointment at 10:00',
    action: 'book Jack 10:00 in Shared Team',
    expected: 'REJECT — physical availability is global',
    actual: blocked.ok ? 'CREATED (double-booked across workspaces)' : blocked.msg,
    ok: !blocked.ok, security: true,
  });

  // ==========================================================================
  // 2. The rejection must disclose NOTHING (0004)
  // ==========================================================================
  rec.check({
    id: 'XW-03 hidden direct overlap says only STAFF_UNAVAILABLE', actor: 'NICK',
    setup: 'blocked by a hidden appointment',
    action: 'inspect the rejection message',
    expected: 'exactly "STAFF_UNAVAILABLE"',
    actual: `"${blocked.msg}"`, ok: blocked.msg === 'STAFF_UNAVAILABLE', security: true,
  });

  const leakTerms = [
    ['customer name', SYNTHETIC_PRIVATE_CUSTOMER.p_customer_name],
    ['phone', SYNTHETIC_PRIVATE_CUSTOMER.p_customer_phone],
    ['address', SYNTHETIC_PRIVATE_CUSTOMER.p_address_line],
    ['city', SYNTHETIC_PRIVATE_CUSTOMER.p_area_city],
    ['private workspace id', priv],
    ['hidden start time', '10:00'],
  ];
  const leaked = leakTerms.filter(([, t]) => (blocked.msg || '').includes(t)).map(([l]) => l);
  rec.check({
    id: 'XW-04 rejection carries no hidden detail', actor: 'NICK', setup: 'same',
    action: 'scan the rejection message for hidden-appointment details',
    expected: 'no customer, phone, address, workspace or time',
    actual: leaked.length ? `LEAKED: ${leaked.join(', ')}` : 'nothing leaked',
    ok: leaked.length === 0, security: true,
  });

  // large-job variant: the message must not disclose the amount band either
  const d2 = await fx.freeDate(jack);
  await book(fx, T.kc, bookingArgs({
    ws: priv, staff: jack, date: d2, time: '10:00', amount: 800,
    customer: SYNTHETIC_PRIVATE_CUSTOMER, remarks: fx.TAG }));
  const blockedLarge = await book(fx, T.nick, bookingArgs({
    ws: shared, staff: jack, date: d2, time: '16:00', amount: 200 }));
  rec.check({
    id: 'XW-05 hidden large-job lock says only STAFF_UNAVAILABLE', actor: 'NICK',
    setup: 'Jack has a hidden private RM800 job at 10:00',
    action: 'book Jack 16:00 in Shared Team',
    expected: 'exactly "STAFF_UNAVAILABLE" — no time, no large-job classification',
    actual: `"${blockedLarge.msg}"`,
    ok: !blockedLarge.ok && blockedLarge.msg === 'STAFF_UNAVAILABLE'
        && !/10:00/.test(blockedLarge.msg) && !/large/i.test(blockedLarge.msg), security: true,
  });

  // a hidden conflict is not overridable, even with a reason supplied
  const blockedOverride = await book(fx, T.nick, bookingArgs({
    ws: shared, staff: jack, date: d2, time: '16:00', amount: 200,
    override: 'REGRESSION: Nick attempts to override a conflict he cannot see' }));
  rec.check({
    id: 'XW-06 hidden conflicts are not overridable', actor: 'NICK',
    setup: 'same hidden RM800 lock',
    action: 'supply a large-job override reason',
    expected: 'denied, still exactly "STAFF_UNAVAILABLE"',
    actual: blockedOverride.ok ? 'CREATED' : `"${blockedOverride.msg}"`,
    ok: !blockedOverride.ok && blockedOverride.msg === 'STAFF_UNAVAILABLE', security: true,
  });

  const committed = (await fx.query(
    `select count(*)::int n from public.appointments where appt_date = any($1::date[]) and workspace_id = $2`,
    [[d1, d2], shared]))[0].n;
  rec.check({
    id: 'XW-07 no Shared row committed by the blocked attempts', actor: 'NICK', setup: '-',
    action: 'count Shared Team appointments on the fixture dates',
    expected: '0', actual: `${committed} rows`, ok: committed === 0, security: true,
  });

  // An authorised viewer still gets an ACTIONABLE error — the fix must not
  // degrade the experience for someone who can see both sides.
  const kcSame = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: jack, date: d2, time: '16:00', amount: 200 }));
  rec.check({
    id: 'XW-08 authorised viewer keeps actionable detail', actor: 'KC (sees both workspaces)',
    setup: 'the same hidden RM800 lock',
    action: 'book Jack 16:00 in Shared Team',
    expected: 'LARGE_JOB_OVERRIDE_REQUIRED, naming the blocking time',
    actual: kcSame.ok ? 'CREATED' : kcSame.msg,
    ok: !kcSame.ok && /LARGE_JOB_OVERRIDE_REQUIRED/.test(kcSame.msg),
  });

  // ==========================================================================
  // 3. The private appointment itself stays invisible
  // ==========================================================================
  for (const [label, path] of [
    ['by staff', `appointments?select=id,customer_name&staff_id=eq.${jack}&appt_date=eq.${d1}`],
    ['by date', `appointments?select=id,customer_name&appt_date=eq.${d1}`],
    ['by id', `appointments?select=id&id=eq.${hidden.body}`],
  ]) {
    const r = await rest(path, T.nick);
    rec.check({
      id: `XW-09 private appointment invisible (${label})`, actor: 'NICK',
      setup: 'a private Jack appointment exists that day',
      action: `query appointments ${label}`, expected: '0 rows',
      actual: `${r.rows.length} rows`, ok: r.rows.length === 0, security: true,
    });
  }

  // ==========================================================================
  // 4. Cross-workspace override + audit privacy (0005)
  // ==========================================================================
  // KC legitimately overrides a lock held by a hidden appointment. The audit
  // trail this produces must not reach a Shared-only Master.
  const d3 = await fx.freeDate(jack);
  const hiddenLarge = await book(fx, T.kc, bookingArgs({
    ws: priv, staff: jack, date: d3, time: '10:00', amount: 800,
    customer: SYNTHETIC_PRIVATE_CUSTOMER, remarks: fx.TAG }));
  const crossOverride = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: jack, date: d3, time: '16:00', amount: 200,
    override: 'REGRESSION: KC cross-workspace override reason' }));
  rec.check({
    id: 'XW-10 cross-workspace override granted by KC', actor: 'KC', setup: 'hidden RM800 lock at 10:00',
    action: 'book Shared Team 16:00 with an override',
    expected: 'ALLOWED — KC administers both workspaces',
    actual: crossOverride.ok ? 'created' : crossOverride.msg, ok: crossOverride.ok,
  });

  const crossRows = await fx.query(
    `select o.id from public.appointment_rule_overrides o
     where o.subject_appointment_id = $1 and o.conflicting_appointment_id = $2`,
    [crossOverride.body, hiddenLarge.body]);
  rec.check({
    id: 'XW-11 the cross-boundary override row exists', actor: 'db', setup: '-',
    action: 'confirm the fixture actually produced a cross-workspace override row',
    expected: '1 row', actual: `${crossRows.length} rows`, ok: crossRows.length === 1,
  });

  const nickOv = await rest('appointment_rule_overrides?select=id,conflicting_appointment_id', T.nick);
  const nickSeesCross = nickOv.rows.filter(r => crossRows.some(c => c.id === r.id));
  rec.check({
    id: 'XW-12 Nick cannot read the cross-boundary override row', actor: 'NICK',
    setup: 'subject is Shared Team, conflicting is KC Private Team',
    action: 'query appointment_rule_overrides',
    expected: '0 cross-boundary rows — visibility is bounded by the most restrictive endpoint',
    actual: `${nickOv.rows.length} rows visible, ${nickSeesCross.length} cross-boundary`,
    ok: nickSeesCross.length === 0, security: true,
  });

  const kcOv = await rest('appointment_rule_overrides?select=id', T.kc);
  rec.check({
    id: 'XW-13 KC can read it', actor: 'KC', setup: 'same row',
    action: 'query appointment_rule_overrides',
    expected: 'the cross-boundary row is visible to a Master authorised for both workspaces',
    actual: `${kcOv.rows.filter(r => crossRows.some(c => c.id === r.id)).length} of ${crossRows.length} visible`,
    ok: kcOv.rows.filter(r => crossRows.some(c => c.id === r.id)).length === crossRows.length,
  });

  // audit_logs must not carry the same disclosure
  const nickAudit = await rest('audit_logs?select=*&limit=500', T.nick);
  const privateIds = (await fx.query(
    `select id from public.appointments where workspace_id = $1`, [priv])).map(r => r.id);
  const haystack = JSON.stringify(nickAudit.rows);
  const idsInPayload = privateIds.filter(i => haystack.includes(i));
  rec.check({
    id: 'XW-14 no private appointment id anywhere in Nick audit_logs', actor: 'NICK',
    setup: `${privateIds.length} private appointments exist`,
    action: 'scan every audit_logs row Nick can read',
    expected: '0 private appointment ids',
    actual: `${nickAudit.rows.length} rows scanned, ${idsInPayload.length} private ids found`,
    ok: idsInPayload.length === 0, security: true,
  });

  const overrideAudit = nickAudit.rows.filter(r =>
    r.action_type === 'appointment.large_job_override_granted'
    && r.after_json?.subject_appointment_id === crossOverride.body);
  rec.check({
    id: 'XW-15 the cross-boundary override audit event is hidden', actor: 'NICK',
    setup: 'KC granted a cross-workspace override',
    action: 'look for that audit event',
    expected: '0 rows — the event describes a hidden object',
    actual: `${overrideAudit.length} rows`, ok: overrideAudit.length === 0, security: true,
  });

  const kcAudit = await rest(
    `audit_logs?select=id,after_json&action_type=eq.appointment.large_job_override_granted&limit=500`, T.kc);
  const kcSeesIt = kcAudit.rows.some(r => r.after_json?.subject_appointment_id === crossOverride.body);
  rec.check({
    id: 'XW-16 KC still has the full audit trail', actor: 'KC', setup: 'same event',
    action: 'look for that audit event',
    expected: 'visible — the audit record is preserved for authorised Masters',
    actual: kcSeesIt ? 'visible' : 'MISSING', ok: kcSeesIt,
  });

  // A same-workspace override must remain visible: the fix must not over-restrict.
  const d4 = await fx.freeDate(ids.staff.dyron);
  const sharedLarge = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: ids.staff.dyron, date: d4, time: '10:00', amount: 800 }));
  const sharedOverride = await book(fx, T.kc, bookingArgs({
    ws: shared, staff: ids.staff.dyron, date: d4, time: '16:00', amount: 200,
    override: 'REGRESSION: same-workspace override' }));
  const sameRows = await fx.query(
    `select id from public.appointment_rule_overrides where subject_appointment_id = $1`, [sharedOverride.body]);
  const nickOv2 = await rest('appointment_rule_overrides?select=id', T.nick);
  const nickSeesSame = nickOv2.rows.filter(r => sameRows.some(s => s.id === r.id)).length;
  rec.check({
    id: 'XW-17 same-workspace override stays visible to Nick', actor: 'NICK',
    setup: `both endpoints in Shared Team (${sharedLarge.ok && sharedOverride.ok ? 'fixture ok' : 'FIXTURE FAILED'})`,
    action: 'query appointment_rule_overrides',
    expected: 'visible — the fix must not over-restrict same-workspace rows',
    actual: `${nickSeesSame} of ${sameRows.length} visible`,
    ok: sameRows.length > 0 && nickSeesSame === sameRows.length,
  });

  // ==========================================================================
  // 5. The second workspace itself is never discoverable
  // ==========================================================================
  const jackMemberships = await rest(`staff_workspaces?select=workspace_id&staff_id=eq.${jack}`, T.nick);
  const seesPrivate = jackMemberships.rows.some(r => r.workspace_id === priv);
  rec.check({
    id: 'XW-18 Nick cannot see Jack second membership', actor: 'NICK',
    setup: 'Jack is temporarily in both workspaces',
    action: 'query staff_workspaces for Jack',
    expected: 'the KC Private Team membership is not listed',
    actual: `${jackMemberships.rows.length} membership rows, private listed = ${seesPrivate}`,
    ok: !seesPrivate, security: true,
  });
});

process.exit(summary.fail === 0 ? 0 : 1);
