# Overnight autonomous run — 2026-09-08

Durable log for the unattended session. Newest entries at the bottom of each
phase. No secrets, no real data.

**Starting state (accepted green baseline):** migrations 0001–0008 locked ·
backend regression 174/174 · F2 E2E 46/46 · browser privacy 19/19 · unit 7/7 ·
lint, build, secret scan clean · DEV baseline clean · Git = DEV.

**Starting HEAD:** `b27d796` *Phase 1: fix working-hours midnight boundary*

---

## Phase O1 — F3 lifecycle audit — DONE

### Deployed signatures (authoritative, all `authenticated`-callable)

```
update_appointment(uuid,text,text,text,text,text,integer,text) -> void
update_appointment_items(uuid,jsonb,integer,text)              -> void
reschedule_appointment(uuid,date,time,text)                    -> void
cancel_appointment(uuid,text)                                  -> void
mark_appointment_completed(uuid)                               -> void
```

### Override support is NOT uniform — do not assume

| function | override param | passes to validator | records exception | staff blocked |
| --- | --- | --- | --- | --- |
| `update_appointment` | yes | yes | yes | yes |
| `update_appointment_items` | yes | yes | yes | yes |
| `reschedule_appointment` | yes | yes | yes | yes |
| `cancel_appointment` | **no** | no | no | n/a |
| `mark_appointment_completed` | **no** | no | no | n/a |

So the override flow belongs on edit / item-edit / reschedule only. Cancel and
complete take no reason and must not offer one.

All five carry both a staff-ownership check (`Not your appointment`) and a
Master workspace check, plus a `booked`-only status guard.

### Confirmed backend gap → migration 0009

`mark_appointment_completed` reads `business_settings.staff_can_mark_completed`
for staff callers and raises *"Staff completion is currently disabled in
Settings"*. But **staff cannot read `business_settings`** (verified: TEST_JACK
sees 0 rows) and `get_booking_config()` did not expose the flag — so the staff
UI had no honest way to decide whether to render Complete.

`0009_booking_config_completion_permission` adds `staff_can_mark_completed` to
that RPC. Table RLS **not** widened (re-verified after apply: Jack still reads 0
rows). Threshold, day window and WA templates remain excluded. Applied to DEV
after clean rollback-only validation.

### Second finding — error mapping had 15 holes

Enumerated every `raise exception` message in all 21 application functions and
mapped each. **15 fell through to `UNEXPECTED`** — i.e. rendered as "Something
went wrong" — four of them squarely on the F3 lifecycle path:
`Appointment not found`, `Not your appointment`,
`Staff completion is currently disabled in Settings`, and (already live in F2)
`Appointment must be in the future`.

Also a real rule-ordering bug: *"Only a Master may set staff time off"* is an
authorization failure but matched the looser `time off` rule first, telling the
user the staff member was unavailable.

Fixed in `lib/errors/appError.ts`: authorization now tested before time-off, two
new codes (`PAST_DATETIME`, `BLOCKING_APPOINTMENTS`), and the remaining messages
mapped. `Appointment not found` and `Not your appointment` map to the **same**
result on purpose — a distinguishable error would confirm an appointment exists.

New suite `error-mapping-coverage-regression.mjs` (15 checks) generates the
message list from the database, so a message added by a future migration is
caught immediately rather than silently degrading to "Something went wrong".

---

## Phase O2 — F3 appointment detail / edit — DONE

Routes `/appointments/[id]` (Master) and `/my/appointments/[id]` (Staff), one
shared `AppointmentDetailView`. Agenda and calendar cards now link through.

**The privacy property.** `getAppointmentDetail` returns `null` for a hidden
appointment, a nonexistent one, a malformed id and a read error alike — there is
no branch that could tell them apart. Verified by comparing rendered pages:
Nick opening Victor's real appointment id gets byte-identical visible text to a
uuid that does not exist, and the copy says "not available", never "not
authorized".

**Actions.** Five Server Actions, each re-resolving the session and re-reading
the appointment through RLS before touching anything. No direct table writes.
The O1 audit shaped this directly: `update_appointment`,
`update_appointment_items` and `reschedule_appointment` take an override reason;
`cancel_appointment` and `mark_appointment_completed` do not, so those two never
offer one.

**Completion permission** comes from `get_booking_config().staffCanMarkCompleted`
(0009), proven by toggling the setting and checking the button appears and
disappears — not hard-coded.

Terminal appointments render no mutation controls, and forged posts against them
are refused by the RPC status guard as well.

**F3 E2E: 40/40, 0 security failures** on the first full run.

---

## Phase O3 — operational dashboard polish — DONE

`/dashboard` was a placeholder and was not even linked. It is now the Master
home and the first nav item ("Today"): Today / Tomorrow / large-jobs-today
counts with booked totals, today grouped **by staff member** (the question a
Master actually asks in the morning), and tomorrow as a flat agenda.

Agenda and calendar cards now link through to F3 detail. `loading.tsx`
skeletons added for all eight data-backed routes.

**A leak that a summary invites, checked rather than assumed.** The private
appointment never appears as a card on Nick's dashboard — but a total computed
over all rows would still disclose its value. Measured on DEV: for the same
day KC sees `Tomorrow 3 · RM900.00` and Nick sees `Tomorrow 2 · RM600.00`. The
aggregate is computed from RLS-filtered rows, so it is correct by construction;
`DASH-02` now asserts the two figures differ, which would fail immediately if
anyone introduced a shared aggregate.

Also strengthened the privacy suite: with `loading.tsx` in place its snapshot
was catching the skeleton (111 characters) rather than the rendered page, which
would have made the scan vacuous. It now waits for streaming to finish — 464
characters of real content.

Browser screenshots could not be captured this session (the host window is
hidden, the capture times out). Verification was done through DOM assertions
instead, which is stronger evidence for these properties anyway.

---

## Phase O4 — WhatsApp and Maps quick actions — DONE

Deep links only: no WhatsApp API, no Maps API key, no automated sending, no
background work. Every link is opened by the user clicking it, and WhatsApp
opens with the message prefilled for them to review and send themselves.

`lib/external-links.ts` centralises the builders, replacing the Maps logic that
had been duplicated in two components. The inputs are customer-controlled free
text, so the rules are strict: the scheme is a literal in the module and never
comes from input; every interpolated value is percent-encoded; and a value that
does not validate produces **no link at all** rather than a broken one.

16 unit tests, weighted towards the negative cases — `javascript:alert(1)`,
`012 javascript:alert(1)`, `0123456789@evil.example` and `+60-12-345-6789?text=x`
all yield null, and a hostile message or address cannot add a second `?` or an
extra `&` parameter. Four E2E checks confirm the rendered links, including that
an unusable phone number renders no WhatsApp button.

Reminder text is generated in code for now. `business_settings` carries
`wa_reminder_template_en/_zh/_ms`, but they are empty and deliberately not
exposed through `get_booking_config` — when they are populated, this becomes
the fallback rather than the only option.

---

## Phase O5 — visual / UX QA — DONE

Screenshots are uncapturable this session, so the QA pass was written as
measurements rather than eyeballing: `tests/e2e/responsive-qa.test.mjs` loads
all nine routes as both a master and a staff member at 390px, 768px and 1440px
and asserts against the rendered geometry. **65 checks, all passing.**

What it measures, and why each one is the thing that actually breaks:

- **Horizontal overflow** — `scrollWidth > clientWidth` on every route at every
  width, and when it fails it names the offending elements. A single wide
  `<select>`, table or long unbroken address is the usual cause, and on a phone
  it is invisible to whoever built the page on a laptop.
- **Tap-target height** — every `button`, `a[href]`, `select` and `input` at
  390px must be at least 32px tall.
- **Content actually rendered** — guards against a route that only ever shows
  its skeleton, which would otherwise make the two checks above pass vacuously.
- **Dialog semantics** — the cancel confirmation must carry `aria-modal`, be
  labelled, fit inside the viewport, and offer a way out as well as a way
  through.
- **Empty state** — asserted against a staff member confirmed by query to have
  nothing booked today, rather than one assumed to be free.

The fixture is a deliberately hostile one: a 55-character customer name and a
long Jalan address, since truncation defects only appear with real-length data.

### Defect found and fixed

**Dashboard section links were 20px tall at 390px** — "All appointments" and
"Open calendar" sit beside their section headings and are the primary way to
reach the full lists on a phone, but as bare inline text they were half the
minimum comfortable tap size. Fixed with `-my-2 py-2`, which grows the hit area
to 36px while the negative margin keeps the header row exactly the same height —
no visual change, a target twice the size.

### Test defect found and fixed (the product was correct)

`/my/month` failed once with `net::ERR_ABORTED`, and the suite crashed on it.
Both parts were wrong:

- The route is fine — three consecutive direct loads all succeeded. `next dev`
  compiles routes on demand, and the first compile racing an in-flight prefetch
  aborts the navigation. A dev-server artefact, not a product defect, so the
  navigation now retries once.
- More importantly the crash abandoned every remaining check, so the run would
  have looked *shorter* rather than *failed*. A navigation that fails twice is
  now recorded as a failed check and the suite continues — the same class of
  bug as the "0 PASS / 0 FAIL" trap fixed earlier tonight.

Privacy was not re-tested per viewport: the RSC payload does not vary by
viewport width, so a per-width repeat would add passes without adding evidence.


## Phase O6 — regression hardening — DONE

The theme of this phase is that a green suite is only worth what its weakest
assertion is worth. Four classes of weakness were found and closed.

### 1. Skips were being recorded as passes

`past-guard-and-config-regression` had three branches shaped like

```js
if (hourNow >= 10) { ...the real check... }
else { rec.check({ action: "skipped: before 10:00 MYT", ok: true }); }
```

Run before 10:00 MYT, the suite reported full marks while never exercising the
guard. **This run started at 01:42 MYT, so two of those three were in their
skipped window** — the suite would have claimed a pass for the "earlier today
is rejected" property without testing it at all.

Fixed at both levels:

- **The recorder now has `skip()`**, which counts as neither a pass nor a
  fail, prints `[SKIP]`, and is listed separately under "SKIPPED (not counted
  as passes)". Verified end to end: one check plus one skip yields
  `1 PASS / 0 FAIL / 1 SKIPPED`.
- **`run-all` surfaces it in the verdict.** A skip cannot appear in an exit
  code, so a verdict built from exit codes alone would print "All suites
  passed" over an unexercised property. It now captures each suite's output as
  well as echoing it, and annotates the verdict line.

Then most of the skipping was removed outright, by choosing inputs that hold at
every hour rather than inputs that need a favourable clock:

- **PG-02 / PG-09** now use **today at 00:00**. The guard rejects `<= now()`,
  so midnight today is in the past at every instant of the day — including
  00:00:00 itself. These can never be skipped again.
- **PG-03** clamps "30 minutes from now" to 23:59, shrinking its unrunnable
  window from 30 minutes a day to the final minute, and calls `rec.skip()`
  rather than claiming a pass when it lands there.

### 2. Security checks that passed without reaching the guard

`SEC-13` asserted only `!r.ok` for five privileged mutations attempted by a
no-profile identity. Any failure satisfied that — a type error, an expired
token, a rate limit — so the check could go green while the authorization code
never ran. It now asserts the message is an authorization refusal.

This was not hypothetical. **`SEC-13b` was added to prove it**: the same call
with its casts removed fails with `function public.set_staff_working_hours(
unknown, integer, unknown, unknown) does not exist` — dead in overload
resolution, nowhere near a guard. Under the old assertion that was a security
pass. The trap had already been noted in a code comment; it is now an executed
check that fails if anyone reintroduces it.

`AV-15` had the same shape: `!withAmount.ok` for the removed amount-taking
signature. It now requires HTTP 404 *and* `could not find the function` *and*
`p_total_amount` in the message, so it can only pass because the signature is
genuinely gone. `AV-15b`'s sweep likewise distinguishes "refused" from
"failed-500".

### 3. Fixture isolation was assumed rather than asserted

Every suite now runs `ISO-01` before its body and `ISO-02` after teardown —
fourteen new checks confirming no fixture rows exist on entry and none survive
on exit. `ISO-02` runs inside `finally`, so it still reports after a crash,
which is precisely when a suite is most likely to leave rows behind.

### 4. Fixed-offset dates could collide silently

Several suites pick dates as `today + 70` rather than through `freeDate()`, and
they must: the working-hours cases are weekday-sensitive, where `d` and `d + 7`
have to share a weekday for one window to govern both. That is only safe while
the slot is empty. The DEV baseline holds **zero** appointments today, so it is
— but that is a property of the current data, not of the test, and a collision
would surface as a baffling `PHYSICAL_OVERLAP` several assertions downstream.

`fx.requireFree(staff, date, label)` now turns that into an immediate, named
failure at the point of setup, and the working-hours suite checks both staff it
books on every date it derives.

### Result

Backend regression grew from **189 to 204 checks**, all passing — and the
fifteen new ones are all of the kind that make the other 189 mean something.


---

## End-of-run full gate — PASSED

| Gate | Result |
| --- | --- |
| Secret scan (tree + full git history) | **CLEAN** — no JWT, service-role key or credentialed connection string in any blob of any commit. `SUPABASE_SERVICE_ROLE_KEY` appears only as a variable *name*; `.env.example` is the only tracked env file and its values are empty. |
| Service-role reachability | `lib/supabase/adminClient.ts` has **zero importers** in `app/`, `lib/` or `components/`, and is guarded by `import "server-only"`. No browser or server-user path can reach it. |
| Lint | clean |
| Build | passes |
| Unit | 16/16 |
| Backend regression | **204/204**, 0 security failures, 0 skipped |
| Cross-user browser privacy | 24/24 |
| F2 E2E (add appointment) | 46/46 |
| F3 E2E (detail + lifecycle) | 44/44 |
| Responsive / UX QA | 65/65 |
| Git migrations vs DEV history | **identical** — 0001…0009, same order, same names |
| Migrations 0001–0008 | **unmodified**; last touched before this run began. 0009 was *added*, never an edit to a locked file |
| DEV baseline | reset and verified — 18/18 baseline assertions OK, 0 appointments |
| Working tree | clean, level with `origin/main` |
| Real customer data | none — every fixture is `TEST_*` / `*.dev.test` |

**Final HEAD:** `3679c73` *Phase 6: regression hardening*

**Total: 399 automated checks green.**

---

## Post-overnight reconciliation audit

### Correction: the availability finder IS connected

The morning report claimed `find_available_slots` was *"fully built, privacy-safe
and completely unused by the frontend."* **That was wrong**, and it was wrong
about F2, which was approved and shipped with the finder wired in.

The error came from conflating two different things: the **`/availability`
route** is still a Phase-1 scaffold placeholder, but the **finder itself** has
been live inside both booking forms since F2. A placeholder page is not an
unused RPC.

No product code was changed. The evidence, gathered at `e41c216`:

| Reference | Location |
| --- | --- |
| `find_available_slots` | `lib/appointments/actions.ts:137` · `lib/appointments/lifecycle-actions.ts:253` |
| `findAvailabilityAction` | defined `lib/appointments/actions.ts:116`, called `AppointmentForm.tsx:93` |
| `AvailabilitySuggestions` | defined `AvailabilitySuggestions.tsx:14`, rendered `AppointmentForm.tsx:251` |
| `/appointments/new` | renders `AppointmentForm` (`page.tsx:65`) → calls the finder |
| `/my/appointments/new` | renders `AppointmentForm` (`page.tsx:59`) → calls the finder |

**Live proof, not code reading.** `pg_stat_statements` was reset immediately
before driving the real UI, and the statement Postgres actually executed was:

```
"public"."find_available_slots"("p_staff_ids" := …, "p_from" := …,
                                "p_to" := …, "p_workspace_id" := …)
```

Exactly the four 0007 arguments. No `p_total_amount`, no numeric argument.

**The chips are not hard-coded.** A differential settles it: KC saw
`10:00, 13:00, 15:00`; one appointment was then booked at 10:00 directly through
the RPC; on reload the chips read `13:00, 15:00`. A static or client-derived
list cannot do that.

**0007 semantics intact.** `AppointmentForm`'s availability effect keys on
`workspaceId|staffId|date` only — `total` is deliberately excluded, with the
reason in a comment. Changing the item total triggers no availability request
(`AVAIL-03`), and no request carries an amount (`AVAIL-04`). An unauthorised
staff/workspace pairing returns **empty slots rather than an error**, which is
the same answer a genuinely empty schedule gives.

### Feature-phase ledger

The overnight log numbers its own phases `O1…O6`. Those are *run* phases and do
not line up with *feature* phases, which caused the next-phase name to collide.
The authoritative feature ledger:

| Phase | Scope | Status |
| --- | --- | --- |
| F1 | Login, session, role-aware navigation, shared agenda | DONE |
| F2 | Add Appointment (incl. availability suggestions) | DONE |
| F3 | Appointment detail, edit and lifecycle | DONE |
| F4 | Operational dashboard polish (+ WhatsApp/Maps deep links) | DONE |
| **F5** | **Calendar Operations / Availability UX** | **NEXT — not started** |

Historical commit messages are left as they are.

### Authoritative route / feature map

| Route | Role | State |
| --- | --- | --- |
| `/login` | public | **IMPLEMENTED** |
| `/` | any | **IMPLEMENTED** — redirects by role |
| `/dashboard` | master | **IMPLEMENTED** — Master home, first nav item |
| `/calendar` | master | **IMPLEMENTED** — week view, prev/this/next, scope-aware |
| `/appointments` | master | **PARTIAL** — fixed next-30-days list; no filter, search or paging |
| `/appointments/new` | master | **IMPLEMENTED** |
| `/appointments/[id]` | master | **IMPLEMENTED** — detail + full lifecycle |
| `/availability` | master | **PLACEHOLDER** — Phase-1 scaffold (the RPC behind it is live in F2) |
| `/staff` | master | **PLACEHOLDER** |
| `/staff/[id]` | master | **PLACEHOLDER** |
| `/reports/monthly` | master | **PLACEHOLDER** |
| `/settings` | super_master | **PLACEHOLDER** |
| `/audit` | master | **PLACEHOLDER** — not in the nav |
| `/my/today` | staff | **IMPLEMENTED** — staff home |
| `/my/tomorrow` | staff | **IMPLEMENTED** |
| `/my/month` | staff | **IMPLEMENTED** |
| `/my/appointments/new` | staff | **IMPLEMENTED** |
| `/my/appointments/[id]` | staff | **IMPLEMENTED** — own appointments only |

### Landing routes, measured with real logins

| Identity | After login | `/` | Nav |
| --- | --- | --- | --- |
| KC (super_master) | `/dashboard` | `/dashboard` | Today · Calendar · Appointments · Staff · Availability · Reports · Settings |
| Nick (partner_master) | `/dashboard` | `/dashboard` | same, **no Settings** |
| Jack (staff) | `/my/today` | `/my/today` | Today · Tomorrow · Month |
| Victor (staff) | `/my/today` | `/my/today` | Today · Tomorrow · Month |

Consistent with the report — no routing inconsistency, and nothing was changed.
