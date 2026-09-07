# DEV regression suites

Integration tests for the Appointment Engine backend. They lock in the rules
proven by Security QA and Stage 3B against migrations `0001`–`0005`.

These are **not** unit tests. They sign in as real synthetic identities, call
the real RPCs over PostgREST, and assert what each role can actually see — so
they exercise Row Level Security exactly as the browser will.

## Running

```bash
npm run test:regression
```

Or one suite at a time:

```bash
npm run test:security
npm run test:engine
npm run test:privacy
```

## Configuration

All credentials come from `.env.local`, which is gitignored. Nothing in this
directory contains a secret.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | DEV project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable key — client-safe by design |
| `TEST_IDENTITY_PASSWORD` | shared password for the five synthetic DEV logins |
| `SUPABASE_DB_USER` | pooler user, for fixture setup/teardown only |
| `SUPABASE_DB_PASSWORD` | database password — **never commit** |
| `SUPABASE_DB_HOST` | optional; defaults to the DEV pooler host |

The harness refuses to run against anything but the known DEV project. Override
with `ALLOW_NON_DEV_TESTS=true` only if you are certain — **these suites create
and delete rows.**

## Design rules

**Every suite creates its own fixture and removes it.** `createFixture()` tracks
every appointment, time-off row, working-hours override and membership change,
and deletes them in a `finally` block. Teardown runs even when assertions fail.

**No suite depends on accumulated data.** Dates are allocated at runtime by
`fx.freeDate(staffId)`, which finds a far-future date on which that staff member
has no appointment at all. Identities are resolved by name, not by hard-coded
UUID, so the suites survive a DEV data reset.

**The cross-workspace suite builds its own cross-workspace condition.** It
grants Jack a temporary KC Private Team membership and removes it afterwards.
The normal DEV baseline is Jack = Shared Team only; nothing here should change
that permanently.

**Synthetic data only.** Never point these at real customer records. Bookings
use `TEST CUSTOMER A` / `+60000000001` and the private-workspace variants.

**A direct database connection is used only for fixtures and assertions** —
never as the system under test. Anything being tested goes through an RPC or
PostgREST with a real JWT.

## What is covered

### `security-regression.mjs`
Nick cannot discover Victor (profile, staff row, appointments, time off,
memberships, workspace, and unfiltered sweeps) · staff identity is
server-derived and a foreign `staff_id` parameter is ignored · `created_by`
comes from the JWT · staff cannot override duration or grant a large-job
override · override/audit tables are Master-only · internal engine functions
(`assert_appointment_slot_available`, `can_view_conflict`) reject anon and
authenticated, checked both over HTTP and in `pg_proc` · anon reads nothing ·
an authenticated caller with **no profile** resolves to a null role and has
zero mutation capability across five RPCs and zero read visibility.

> The no-profile case drives the database with the `authenticated` role and a
> JWT claim for a uuid that owns no profile — the state a newly signed-up,
> not-yet-provisioned account is in. No synthetic auth user exists for it, and
> creating one would mean writing to `auth.users` directly.

### `appointment-engine-regression.mjs`
RM/hour duration and the 30-minute buffer, including exact boundaries at RM200
and RM400 · RM600 forward lock, and that it does not block earlier slots ·
Master override of the forward lock · per-exception override (granting one
exception must not disable the rule for later bookings) · reverse large-job
case · physical overlap never overridable, even by a Super Master with a reason
· staff self-booking, workspace derivation and identity binding · item edits
recalculating duration and large-job classification, and the new classification
taking effect immediately · terminal statuses, and that cancelling frees the
slot · time off, including a booking-vs-time-off race · working hours, company
default and staff-specific, including that **past** bookings never block a
recurring-hours change while **future** ones still do · genuine concurrent
double-booking over two simultaneous HTTP calls.

### `cross-workspace-privacy-regression.mjs`
Physical availability is global — a hidden appointment blocks a Shared Team
booking · the rejection is exactly `STAFF_UNAVAILABLE`, with no customer,
phone, address, workspace, time or amount band · hidden conflicts are not
overridable even when a reason is supplied · nothing is committed by the
blocked attempts · an authorised viewer (KC) still gets the actionable
`LARGE_JOB_OVERRIDE_REQUIRED` detail · the private appointment stays invisible
by staff, by date and by id · cross-workspace override rows and their audit
events are hidden from a Shared-only Master but preserved for KC ·
same-workspace override rows stay visible, so the fix is not over-restrictive ·
Jack's second membership is not discoverable.

## Adding a test

Use `runSuite()`; it wires up the admin connection, identity resolution, the
fixture tracker, the recorder and teardown:

```js
import { runSuite, book, bookingArgs } from './lib/harness.mjs';

const summary = await runSuite('MY SUITE', async ({ db, ids, fx, rec, T }) => {
  const date = await fx.freeDate(ids.staff.jack);
  const r = await book(fx, T.kc, bookingArgs({
    ws: ids.ws.shared, staff: ids.staff.jack, date, time: '10:00', amount: 200,
  }));
  rec.check({
    id: 'MY-01', actor: 'KC', setup: 'empty day', action: 'create 10:00 RM200',
    expected: 'ALLOWED', actual: r.ok ? 'created' : r.msg, ok: r.ok,
  });
});

process.exit(summary.fail === 0 ? 0 : 1);
```

Always create appointments through `book()` rather than `rpc()` directly — it
registers the result for teardown. Mark privacy and authorization assertions
`security: true` so they are counted separately in the summary.
