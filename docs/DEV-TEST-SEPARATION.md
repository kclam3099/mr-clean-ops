# DEV / TEST Supabase separation

Automated suites get their own Supabase project. DEV stops being a place a
destructive teardown can reach.

`docs/QA-DATA-ISOLATION.md` fixed the harness after a teardown deleted a real
booking. Exact-id ownership works — the suites now run green with manual data
present — but it is one layer, and it is the layer that already failed once.
This adds a second: the automated suites and the owner's data stop sharing a
database at all.

**Defense in depth. Exact-id cleanup stays required in TEST**, disposable or
not. A harness that is careless because the database is cheap is a harness that
will be careless the day it is pointed somewhere expensive.

---

## The three environments

| | DEV | TEST | Production |
| --- | --- | --- | --- |
| ref | `ozojfflkchltwqnbflso` | *(created at step 1)* | does not exist |
| local preview `:3100` | **yes** | never | — |
| owner / manual testing | yes | never | — |
| real customer data | may be present | **never** | — |
| automated destructive suites | **never** | yes | never |
| fixture reset / wipe | **never automated** | allowed | never |
| read-only diagnostics | `npm run dev:inspect` | n/a | — |

Production is not created, attached, or touched in this phase.

---

## A–F: the specification this phase was approved against

**A. Project name** — `mr-clean-ops-test`.

**B. Organisation** — the same organisation DEV belongs to,
`oohtrfiknpbzcmbjifwn`. A separate org would mean separate billing and separate
access, for no isolation benefit: the isolation that matters is the database.

**C. Region** — `ap-southeast-1` (Singapore), matching DEV. Same latency, same
timezone behaviour, same Postgres version. A test project in another region
would make timing differences look like defects.

**D. Environment variables** — the application keeps pointing at DEV; the
automated suites get their own names. See `.env.example`.

| variable | project |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | DEV — the app, the `:3100` preview |
| `SUPABASE_DB_USER` / `_PASSWORD` / `_HOST` | DEV — read-only diagnostics only |
| `EXPECTED_TEST_PROJECT_REF` | the ref the environment claims to be talking to |
| `TEST_SUPABASE_URL` / `_ANON_KEY` | TEST |
| `TEST_SUPABASE_DB_USER` / `_PASSWORD` / `_HOST` | TEST |
| `TEST_IDENTITY_PASSWORD` | shared; synthetic identities in both |

No values are committed. `.env.local` is gitignored; `.env.example` carries
empty placeholders only.

**E. How the runner distinguishes TEST from DEV** — by **project ref**, never by
a hostname substring. "test" or "dev" in a URL proves nothing and a production
project could contain either word.

Two independent facts must agree before anything writes:

1. the ref parsed from the live connection equals `EXPECTED_TEST_PROJECT_REF` —
   the environment's own claim about where it is pointed; and
2. that ref appears in `TEST_SAFE_PROJECT_REFS`, a reviewed list in
   `supabase/tests/lib/target.mjs`.

One without the other is not enough. A stale copied `.env` fails (1); an
environment variable pointed somewhere new fails (2), because widening the
allowlist is a diff someone reads, not a variable someone exports.

**F. Fail-closed safeguards** — every one of these refuses rather than guesses:

| situation | result |
| --- | --- |
| resolved ref is DEV | **refuse**, and say to use `npm run dev:inspect` |
| resolved ref is Production | refuse — it is on no list and cannot be added by a variable |
| no URL resolved | refuse |
| URL not parseable as a project host | refuse |
| ref not on the reviewed allowlist | refuse |
| `EXPECTED_TEST_PROJECT_REF` unset (post-cutover) | refuse |
| connection disagrees with the claim | refuse |
| `ALLOW_NON_DEV_TESTS` &c. set | refuse **outright** — not ignored |
| wipe requested, ref not on the wipe list | refuse |

There is no boolean escape hatch, and setting one that looks like it might be
honoured makes the run fail rather than silently proceeding: a silently ignored
override leaves the person believing it worked.

The whole matrix is asserted in `tests/unit/test-target.test.mjs` — pure, no
database — including that a ref embedded in someone else's URL
(`https://evil.example/<ref>.supabase.co`) does not parse, and that a 19- or
21-character lookalike is a different project.

---

## Two allowlists, not one

```js
export const TEST_SAFE_PROJECT_REFS = [ … ];  // may create and delete its own rows
export const WIPEABLE_PROJECT_REFS  = [ … ];  // may EMPTY tables
```

Being allowed to clean up after yourself is not permission to wipe a table, so
the reset/seed command requires membership of both. `WIPEABLE_PROJECT_REFS`
starts empty and gains only TEST. DEV must never appear on it. Production must
never appear on either, and cannot be put there by an environment variable —
only by editing the file.

A unit test asserts the invariants: wipeable ⊆ test-safe, DEV never wipeable,
and — once the cutover switch is flipped — DEV on neither list.

---

## The cutover switch

`TEST_PROJECT_REQUIRED` in `supabase/tests/lib/target.mjs` is one boolean with
one job: it marks the moment the TEST project exists.

While **false** (today) the suites resolve the legacy DEV variables and the
allowlist is what protects them — the state the QA hardening left behind, which
runs green.

Once **true**: `TEST_SUPABASE_*` and `EXPECTED_TEST_PROJECT_REF` become
mandatory, there is no fallback, DEV comes off both allowlists, and a machine
that has not been configured for TEST runs *nothing* rather than quietly running
against the owner's data. The unit test refuses to pass if the switch is flipped
without removing DEV, so the switch enforces its own precondition.

---

## Steps

| # | step | state |
| --- | --- | --- |
| 1 | target resolution, guards, two allowlists, cutover switch | **done** |
| 2 | guard matrix unit-tested (25 checks, no database) | **done** |
| 3 | `npm run db:check-parity` — git / DEV / TEST | **done** (TEST leg pending) |
| 4 | `npm run dev:inspect` — read-only DEV diagnostics + snapshot/verify | **done** |
| 5 | `.env.example` placeholders | **done** |
| 6 | create `mr-clean-ops-test` | **blocked — needs a credential** |
| 7 | apply 0001–0010 to TEST, verify parity three ways | after 6 |
| 8 | seed synthetic identities, workspaces, baseline | after 7 |
| 9 | cutover: flip the switch, remove DEV from both allowlists | after 8 |
| 10 | point the E2E app server at TEST on its own port | after 9 |
| 11 | acceptance: DEV snapshot → full suite on TEST → DEV verify | after 10 |
| 12 | acceptance: TEST reset produces the intended baseline | after 10 |

### Why step 6 is blocked

Creating a Supabase project requires either the dashboard or a Supabase personal
access token, and it requires choosing a database password. Neither belongs in
an agent's hands: entering or generating account credentials is exactly the
category of action that stays with the person who owns the account.

There is no CLI in this repository and no access token in the environment, which
is the correct state — it is why a stray script cannot create or destroy cloud
resources here.

Everything downstream of the project existing is direct `pg` work, which this
repository already does: migrations are applied from the SQL files in order and
recorded in `supabase_migrations.schema_migrations`, and identities are seeded
through the `auth` schema. No CLI is needed for any of it.

### Read-only DEV diagnostics

`npm run dev:inspect` connects with `default_transaction_read_only` set and then
**proves** it by attempting a write and requiring `25006`. If the write
succeeds, the tool exits rather than continuing. It cannot reset, delete, alter
a membership, alter working hours, alter time off, or create a fixture — not by
policy, by the database.

Customer details are never printed; rows are identified by id and by a hash of
their contents.

`--snapshot FILE` / `--verify FILE` are the DEV protection acceptance test:
fingerprint every appointment and its items, run the full suite against TEST,
then require every id present and every fingerprint identical. Missing, changed
and unexpectedly-added rows are each reported separately, and the instrument was
checked against a deliberately tampered snapshot so a clean result means
something.

---

## What does not change

- The two-week Dashboard stays.
- `:3100` keeps pointing at DEV. After cutover this is verified by creating one
  synthetic appointment through the UI, confirming it lands in DEV and not TEST,
  and removing it by its exact id.
- Exact-id ownership, the cleanup-safety regression, and every rule in
  `docs/QA-DATA-ISOLATION.md` remain in force in TEST.
- Migrations 0001–0010 are not edited. TEST is brought forward by applying them,
  never by rewriting them.
- `db:check-parity` never mutates DEV to make itself green. Drift is reported
  and decided on by a person.
