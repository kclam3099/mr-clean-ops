// Daily staff acknowledgement (0012) — privacy and integrity.
//
// The feature exists so a Master can see who has read today's work before the
// day starts. The risk it introduces is a new table keyed by staff_id: get its
// SELECT policy wrong and Nick learns that Victor exists, which is the one
// thing this whole system is built to prevent.
//
// Everything here goes through real JWTs and PostgREST, never the admin
// connection. A test that asserts RLS while bypassing RLS proves nothing.

import {
  adminClient, assertTestTarget, resolveIdentities, createRecorder,
  signInAll, rpc, rest,
} from './lib/harness.mjs';

assertTestTarget();

const rec = createRecorder('STAFF ACKNOWLEDGEMENT (0012)');
rec.plan(14);

const db = await adminClient();
const ids = await resolveIdentities(db);

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const OWNED = [ids.staff.jack, ids.staff.dyron, ids.staff.victor];
const clearOwn = async () => {
  for (const sid of OWNED) {
    await db.query(
      `delete from public.staff_day_acknowledgements where staff_id = $1 and ack_date = $2`,
      [sid, today]).catch(() => {});
  }
};

try {
  const T = await signInAll(ids);
  await clearOwn();

  // ---- the write path ---------------------------------------------------
  const jackAck = await rpc('acknowledge_day', T.jack, {});
  rec.check({
    id: 'ACK-01 a staff member can acknowledge their own day', actor: 'JACK',
    action: 'call acknowledge_day()',
    expected: `recorded for ${today}`,
    actual: jackAck.ok ? `recorded ${JSON.stringify(jackAck.body)}` : `FAILED ${jackAck.status} ${jackAck.msg}`,
    ok: jackAck.ok,
  });

  const again = await rpc('acknowledge_day', T.jack, {});
  const { rows: [count] } = await db.query(
    `select count(*)::int c from public.staff_day_acknowledgements
      where staff_id = $1 and ack_date = $2`, [ids.staff.jack, today]);
  rec.check({
    id: 'ACK-02 acknowledging twice does not create a second row', actor: 'JACK',
    action: 'call it again, then count rows',
    expected: 'still exactly 1 row',
    actual: `${again.ok ? 'ok' : 'failed'}, ${count.c} row(s)`,
    ok: again.ok && count.c === 1,
  });

  // ---- a Master has no staff identity -----------------------------------
  const kcAck = await rpc('acknowledge_day', T.kc, {});
  rec.check({
    id: 'ACK-03 a Master cannot acknowledge — no staff row to acknowledge for',
    actor: 'KC', action: 'call acknowledge_day() as super_master',
    expected: 'refused',
    actual: kcAck.ok ? 'ACCEPTED' : `refused ${kcAck.status}`,
    ok: !kcAck.ok,
  });

  // ---- nobody can write the table directly ------------------------------
  const forge = await rest('staff_day_acknowledgements', T.jack, {
    method: 'POST',
    body: JSON.stringify({ staff_id: ids.staff.dyron, ack_date: today }),
  });
  rec.check({
    id: 'ACK-04 a staff member cannot acknowledge FOR someone else (CRITICAL)',
    actor: 'JACK', action: "POST a row carrying Dyron's staff_id",
    expected: 'refused — the table has no INSERT policy',
    actual: forge.ok ? `ACCEPTED ${forge.status}` : `refused ${forge.status}`,
    ok: !forge.ok,
    security: true,
  });

  const backdate = await rest('staff_day_acknowledgements', T.jack, {
    method: 'POST',
    body: JSON.stringify({ staff_id: ids.staff.jack, ack_date: '2020-01-01' }),
  });
  rec.check({
    id: 'ACK-05 a staff member cannot backdate their own acknowledgement (CRITICAL)',
    actor: 'JACK', action: 'POST a row dated 2020-01-01 for themselves',
    expected: 'refused — the date is the server\'s, not the caller\'s',
    actual: backdate.ok ? `ACCEPTED ${backdate.status}` : `refused ${backdate.status}`,
    ok: !backdate.ok,
    security: true,
  });

  // ---- who can SEE what --------------------------------------------------
  await rpc('acknowledge_day', T.victor, {});
  await rpc('acknowledge_day', T.dyron, {});

  const kcSees = await rest(
    `staff_day_acknowledgements?ack_date=eq.${today}&select=staff_id`, T.kc);
  const kcIds = new Set(kcSees.rows.map((r) => r.staff_id));
  rec.check({
    id: 'ACK-06 a Super Master sees every workspace', actor: 'KC',
    action: "read today's acknowledgements",
    expected: 'Jack, Dyron and Victor all present',
    actual: `${kcIds.size} row(s)`,
    ok: kcIds.has(ids.staff.jack) && kcIds.has(ids.staff.dyron) && kcIds.has(ids.staff.victor),
  });

  const nickSees = await rest(
    `staff_day_acknowledgements?ack_date=eq.${today}&select=staff_id`, T.nick);
  const nickIds = new Set(nickSees.rows.map((r) => r.staff_id));
  rec.check({
    id: 'ACK-07 a Partner Master sees the staff of their own workspace', actor: 'NICK',
    action: "read today's acknowledgements",
    expected: 'Jack and Dyron present',
    actual: `${nickIds.size} row(s)`,
    ok: nickIds.has(ids.staff.jack) && nickIds.has(ids.staff.dyron),
  });

  rec.check({
    id: "ACK-08 a Partner Master cannot see another workspace's staff (CRITICAL)",
    actor: 'NICK', action: "look for Victor's acknowledgement",
    expected: 'absent — Victor is KC Private Team only',
    actual: nickIds.has(ids.staff.victor) ? 'PRESENT — Victor disclosed' : 'absent',
    ok: !nickIds.has(ids.staff.victor),
    security: true,
  });

  // Asking for Victor by id must answer exactly as asking for a uuid that
  // belongs to nobody. A different answer is an existence oracle.
  const probe = await rest(
    `staff_day_acknowledgements?staff_id=eq.${ids.staff.victor}&select=staff_id`, T.nick);
  const random = await rest(
    `staff_day_acknowledgements?staff_id=eq.${crypto.randomUUID()}&select=staff_id`, T.nick);
  rec.check({
    id: "ACK-09 Victor's uuid is indistinguishable from a random one (CRITICAL)",
    actor: 'NICK', action: 'filter by each id, compare status and body',
    expected: 'identical',
    actual: `victor=${probe.status}/${JSON.stringify(probe.body)} ` +
            `random=${random.status}/${JSON.stringify(random.body)}`,
    ok: probe.status === random.status &&
          JSON.stringify(probe.body) === JSON.stringify(random.body),
    security: true,
  });

  // ---- staff see themselves and nobody else ------------------------------
  const jackSees = await rest('staff_day_acknowledgements?select=staff_id', T.jack);
  const jackIds = new Set(jackSees.rows.map((r) => r.staff_id));
  rec.check({
    id: 'ACK-10 a staff member sees their own acknowledgements', actor: 'JACK',
    action: 'read the table unfiltered',
    expected: 'own row present',
    actual: `${jackIds.size} row(s)`,
    ok: jackIds.has(ids.staff.jack),
  });

  rec.check({
    id: "ACK-11 a staff member cannot see a colleague's acknowledgement (CRITICAL)",
    actor: 'JACK', action: 'look for Dyron and Victor in that same read',
    expected: 'neither present',
    actual: [
      jackIds.has(ids.staff.dyron) ? 'DYRON LEAKED' : 'dyron absent',
      jackIds.has(ids.staff.victor) ? 'VICTOR LEAKED' : 'victor absent',
    ].join(', '),
    ok: !jackIds.has(ids.staff.dyron) && !jackIds.has(ids.staff.victor),
    security: true,
  });

  // ---- the recorded time has to be trustworthy ---------------------------
  const { rows: [jackRow] } = await db.query(
    `select ack_date::text as ack_date,
            (acknowledged_at at time zone 'Asia/Kuala_Lumpur')::date::text as local_date
       from public.staff_day_acknowledgements
      where staff_id = $1 and ack_date = $2`, [ids.staff.jack, today]);
  rec.check({
    id: 'ACK-12 the row is filed under the BUSINESS date, not the UTC one',
    actor: 'HARNESS', action: 'compare ack_date with the local date of acknowledged_at',
    expected: `both ${today}`,
    actual: `ack_date=${jackRow?.ack_date} local=${jackRow?.local_date}`,
    ok: jackRow?.ack_date === today && jackRow?.local_date === today,
  });

  // ---- no UPDATE or DELETE either ----------------------------------------
  const patch = await rest(
    `staff_day_acknowledgements?staff_id=eq.${ids.staff.jack}&ack_date=eq.${today}`, T.jack,
    { method: 'PATCH', body: JSON.stringify({ acknowledged_at: '2020-01-01T00:00:00Z' }) });
  const { rows: [afterPatch] } = await db.query(
    `select acknowledged_at from public.staff_day_acknowledgements
      where staff_id = $1 and ack_date = $2`, [ids.staff.jack, today]);
  const rewritten = afterPatch
    && new Date(afterPatch.acknowledged_at).getUTCFullYear() === 2020;
  rec.check({
    id: 'ACK-13 a staff member cannot rewrite the recorded time (CRITICAL)',
    actor: 'JACK', action: 'PATCH acknowledged_at back to 2020, then read it',
    expected: 'unchanged — the table has no UPDATE policy',
    actual: rewritten ? 'REWRITTEN' : `unchanged (PATCH ${patch.status})`,
    ok: !rewritten,
    security: true,
  });

  const del = await rest(
    `staff_day_acknowledgements?staff_id=eq.${ids.staff.jack}&ack_date=eq.${today}`, T.jack,
    { method: 'DELETE' });
  const { rows: [afterDelete] } = await db.query(
    `select count(*)::int c from public.staff_day_acknowledgements
      where staff_id = $1 and ack_date = $2`, [ids.staff.jack, today]);
  rec.check({
    id: 'ACK-14 a staff member cannot delete their acknowledgement (CRITICAL)',
    actor: 'JACK', action: 'DELETE the row, then count',
    expected: 'still there — a late morning cannot be erased',
    actual: afterDelete.c === 1 ? `still there (DELETE ${del.status})` : 'DELETED',
    ok: afterDelete.c === 1,
    security: true,
  });
} catch (e) {
  rec.aborted(e);
} finally {
  // Owned by exact staff id and date, never by a broad predicate.
  await clearOwn();
  await db.end();
  rec.finish();
}
