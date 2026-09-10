# QA data isolation policy

## The incident this exists because of

**A destructive test cleanup deleted an owner-created appointment.**

On 8 September 2026 a teardown ran:

```sql
delete from public.appointments where remarks is not null
```

reasoning that a non-empty remark looked like fixture text. It destroyed a real
booking — customer "Trent", 7 Sep 2026 14:00, remarks *"Total RM457 x 20%
discount"*. The row's phone, address, area, staff, workspace and line items were
not preserved anywhere, and its audit rows were deleted in the same operation.
**It is not recoverable.**

This was not a test-assertion problem. Product data was destroyed.

The root cause was using **resemblance** as a proof of ownership. Manual data
can resemble fixture data in every respect a predicate can see.

---

## The rules

### 1. No heuristic deletes — ever

A test may **never** delete rows selected by:

- `remarks IS NOT NULL`, or `remarks = <any tag>`
- `customer_name LIKE …`, equals, or starts-with
- dates or date ranges
- `staff_id`, `workspace_id`
- status, amount, phone shape, address shape
- "looks like a fixture", "is old", "is obviously test data"

None of these establish ownership. All of them can match a real booking.

### 2. Exact-id ownership is the only destructive authority

Capture the primary key at creation:

```js
const r = await rpc('create_appointment', token, args);
if (r.ok) fx.track(r.body);          // exact id, captured
```

Teardown deletes only what was captured:

```sql
delete from public.appointments where id = any($1::uuid[])
```

**If an id was not captured, the row is not deleted.** Reporting an unowned
leftover is correct behaviour; guessing is not.

### 3. Fixture markers are diagnostic only

`REGRESSION FIXTURE` still exists, because a human grepping the table wants to
see it. It carries **no authority to delete anything**. The cleanup-safety suite
plants a sentinel bearing that exact marker and requires it to survive.

| | role |
| --- | --- |
| marker (`REGRESSION FIXTURE`) | diagnostic label |
| captured primary key | destructive authority |

### 4. Child rows derive from owned parents

```sql
delete from public.appointment_items where appointment_id = any($1::uuid[])
```

…where `$1` is the owned parent set. Never a global predicate. Where ownership
of a child cannot be proven, leave it and report it.

### 5. Configuration is borrowed, not destroyed

Working hours and memberships used to be deleted by `(staff_id, day_of_week)`
and `(staff_id, workspace_id)`, which destroyed manual configuration rather than
borrowing it. The tracker now snapshots the exact row it displaces and restores
it at teardown:

| helper | use |
| --- | --- |
| `fx.setWorkingHours(staff, dow, start, end)` | replace a window, restore the original |
| `fx.clearWorkingHours(staff, dow)` | remove a window, restore the original |
| `fx.setMembership(staff, ws, active)` | grant or change a membership, restore exactly |
| `fx.restoreMembership(staff, ws)` | undo one membership mid-suite |
| `fx.rememberWorkingHours(staff, dow)` | snapshot before a **RPC** changes it |
| `fx.rememberMembership(staff, ws)` | snapshot before a **RPC** changes it |

A row that was absent at snapshot time and present at teardown was created by
that run, and is removed **by its own id**.

### 6. UI-created rows: watch, then adopt

A browser test never receives the id of a row the UI created. It must not clean
up by name. Instead:

```js
await fx.watchAppointments(`customer_name like 'F2 %'`, []);   // baseline BEFORE
…
const adopted = await fx.adoptNew();                            // only what APPEARED
await fx.cleanup();                                             // by exact id
```

A manual booking matching the same pattern existed at baseline, so it is never
adopted and never deleted.

### 7. Tests coexist with manual data

The owner uses DEV for real operational testing. Therefore:

- **No suite may assume `appointments = 0`**, before or after.
- **No suite may assume a fixed date or slot is free.** Use `fx.freeDate`,
  `fx.freeDateForAll`, or `fx.freePastDate`; or design the assertion so it
  concerns only the suite's own rows.
- A real appointment causing `PHYSICAL_OVERLAP` must never fail a security test.

`ISO-01` records the table size before a run; `ISO-02` requires that every id the
run created is gone **and** the table is back to the size it started at — proving
both that cleanup was complete and that nothing unowned was removed.

### 8. No throw-and-abandon

A suite that planned 30 checks and executed 17 must not look green. Every
expected check ends as **PASS**, **FAIL**, or **SKIP with a stated reason**.
Fixture failure is recorded and the dependent checks are skipped explicitly —
never thrown past.

### 9. Skips are visible and justified

`rec.skip()` counts as neither a pass nor a fail, prints `[SKIP]`, is listed
separately, and is surfaced in the aggregate verdict. Where practical, a
state-dependent skip is replaced by a fixture that **creates** the conditions it
needs rather than waiting for them.

### 10. The global reset is not part of any test run

`npm run db:reset-dev-fixtures` deletes every appointment, including manual
bookings. It is the only place allowed to delete by a broad predicate, it is not
in any suite, and it refuses unless the intent is stated:

```bash
CONFIRM_WIPE_DEV_APPOINTMENTS=yes npm run db:reset-dev-fixtures
```

### 11. Fail-closed target guard

`assertDevProject()` checks the **Supabase project ref** against an allowlist,
not a hostname substring — "dev" or "test" in a URL proves nothing, and a
production project could contain either word. An unparseable URL, a missing ref
and an unknown ref all refuse.

The previous `ALLOW_NON_DEV_TESTS=true` escape hatch is **removed**: a boolean
override is exactly what gets pasted into a shell against production. Allowing a
new project means adding its ref to `TEST_SAFE_PROJECT_REFS` in a reviewed diff.

---

## The regression that enforces this

`supabase/tests/cleanup-safety-regression.mjs` — **QA-DATA-01**.

It plants sentinels deliberately shaped like the fixtures around them:

| sentinel | why it is dangerous |
| --- | --- |
| "Trent", remarks `Total RM457 x 20% discount` | the row that was actually destroyed |
| "TEST CUSTOMER Wong", remarks `called ahead` | a name that looks like a fixture |
| "Siti", remarks **`REGRESSION FIXTURE`** | carries the literal marker |
| "Ahmad", historical date, remarks NULL | old enough to look disposable |

It then runs a full create-and-teardown cycle — including a fixture on the **same
staff member and the same date** as a sentinel — and requires every sentinel to
survive byte-for-byte. It also proves working-hours and membership changes revert
completely.

A teardown that cannot tell a sentinel from its own row is a teardown that will
eventually delete a customer.

---

## Proposed DEV / TEST separation

Not implemented — approval required first.

### A. Benefits

- Destructive resets become safe again, in a project with nothing to lose.
- Suites stop working around real data: no free-date searching, no skips caused
  by a busy day, no sentinel collisions.
- The owner can use DEV as an operational environment without a test run ever
  being a risk to it.
- A wipe becomes routine rather than a decision.

### B. Costs

- A second Supabase project to keep migrated and seeded.
- Migration drift becomes possible: two projects to apply 0001–0010 to.
- Two sets of auth identities and env values.
- Slightly slower onboarding for a new machine.
- Today's suites already coexist safely with manual data, so this buys headroom
  rather than fixing a live problem.

### C. Environment variables

```
NEXT_PUBLIC_SUPABASE_URL / ANON_KEY      the app's project (DEV)
SUPABASE_DB_*                            DEV direct connection

TEST_SUPABASE_URL / TEST_SUPABASE_ANON_KEY
TEST_SUPABASE_DB_*                       TEST direct connection
TEST_IDENTITY_PASSWORD                   shared by both
```

`.env.local` stays gitignored; `.env.example` gains the `TEST_*` names with
empty values.

### D. Runner selection

An explicit variable, not a guess:

```bash
TEST_TARGET=test npm run test:regression    # the TEST project
TEST_TARGET=dev  npm run test:regression    # DEV, for reproducing a report
```

Default **must** be `test` once it exists, so the safe target is the one you get
by forgetting.

### E. Migration sync

`supabase db push` against both, driven by one script that fails if the two
projects' `schema_migrations` differ. A regression check asserting DEV and TEST
report identical migration lists would catch drift the moment it appears.

### F. Seed and auth

Reuse `reset-dev-fixtures` as the TEST seeder — it already produces the exact
baseline the suites expect. Identities are created once per project with the same
synthetic emails, so no suite code changes.

### G. Safeguards

1. `TEST_SAFE_PROJECT_REFS` gains the TEST ref; **DEV's ref is removed** once the
   move is complete, so a destructive suite physically cannot target DEV.
2. The wipe script requires both the confirmation variable **and** a project ref
   on a separate `WIPEABLE_PROJECT_REFS` list.
3. Production's ref appears on no list and cannot be added by an environment
   variable — only by a reviewed code change.
4. A start-up check refuses if `TEST_TARGET=test` but the resolved ref is DEV's.

The principle throughout: **the default answer is no**, and widening it is a diff
someone reviews.
