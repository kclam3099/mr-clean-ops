# F5 — Calendar Operations, Availability UX & Quick Add

**STATUS: DELIVERED AND LOCKED.** This is now the record of what was built,
not a proposal. Locked decisions are marked **LOCKED** and must not be
revisited without a new approval.

Delivered in `01b9271`, `d642a10`, `5527e56` and `1de0d1c`, on top of this
design at `1d931c6`.

**Quick Add V2 — paste a WhatsApp message — is DONE**, delivered in `93c85e5`.
Pasting parses locally and deterministically, review and assignment share one
screen, and one tap on a staff card still means ASSIGN + CREATE. The locked
decisions behind it: no external AI or LLM and no customer data sent to any
third party; DD/MM/YY Malaysia dates; past/future validated on the COMBINED
appointment datetime against an injectable clock; a trailing RM amount is the
line TOTAL with quantity fixed at 1 and quantity-like wording kept inside the
description; no amount-aware availability pre-flight; the raw message is not
persisted; the structured form remains the Edit and fallback path; Nick still
sees Jack and Dyron only; and pasted `Staff:` / `Workspace:` / `Role:` text
carries zero authorization meaning, because the parser's output type has no
such field.

### Local hosting

Until the site moves to its own domain, the app is served from a production
build on **http://localhost:3100**, bound to `127.0.0.1`. Port 3000 is left
alone: another project on this machine uses it. `npm run dev` and `npm start`
both target 3100, and the E2E suites default to it.

Feature ledger:

| Phase | Scope | Status |
| --- | --- | --- |
| F1 | Auth / session / role navigation | DONE |
| F2 | Add Appointment | DONE |
| F3 | Appointment detail / lifecycle | DONE |
| F4 | Operational dashboard | DONE |
| F5 | Calendar operations / availability UX / Quick Add | **DONE** |
| F5.1 | Quick Add V2 — paste a WhatsApp message | **DONE** |

Migrations `0001–0009` are locked. **F5 added none and edited none** — the
whole implementation range touches no file under `supabase/migrations/`.

### Accepted V1 deviation

`?new=<id>` highlighting is wired through the calendar — `StaffWeekGrid` and
`CalendarDayView` accept `highlightId`, and the page parses the parameter — but
nothing sets it. Quick Add finishes with `router.refresh()` and an
"Assigned to …" toast, which is sufficient for V1.

The unused plumbing is harmless and is deliberately left in place: introducing
navigation and history handling for a cosmetic highlight is not worth the
complexity. Decided explicitly, not overlooked.

---

## 1. The problem F5 solves

Booking today starts by choosing a workspace, then a staff member, then filling
in the job. That is backwards for daily operations: a customer messages, and the
owner wants to type what the customer said and decide *who takes it* last.

F5 makes staff assignment the final decision, and makes the calendar the surface
that answers "who is free, and when".

---

## 2. Quick Add — the primary booking path

### 2.1 Floating action button

Mounted once in each authenticated shell (`app/(master)/layout.tsx`,
`app/(staff)/layout.tsx`), so it is present on every operational surface:
`/dashboard`, `/calendar`, `/appointments`, `/availability`, `/my/today`,
`/my/tomorrow`, `/my/month`.

```
Desktop (>=640px)                    Mobile (<640px)
+-----------------------+            +-------------+
|  page content         |            |  agenda     |
|                       |            |             |
|         +-----------+ |            |        (+)  |  56x56 circle
|         | + New     | |            |             |
|         | appointment| |           +-------------+
+---------+-----------+-+
          pill, ~48px high
```

- `fixed bottom-6 right-6 z-40`, `aria-label="New appointment"`
- Desktop shows the label inline. **Not** hover-only — a hover-revealed label is
  unreachable by touch and by keyboard.
- Mobile is a 56x56 circle, past the 44px minimum.
- `z-40` sits below `OverrideDialog`'s `z-50`, so a dialog is never overlapped.
- `bottom-6` clears the existing sticky action bars.
- Suppressed on `/appointments/new`, `/my/appointments/new`, and while the sheet
  is open — a FAB floating over the form it opens is noise. Suppression is
  cosmetic only (`usePathname()`).

### 2.2 Overlay

One component, two presentations, selected by CSS rather than a JS media query
so there is no hydration flash.

| | Desktop | Mobile |
| --- | --- | --- |
| Shape | right-side drawer, `max-w-lg`, full height | full-screen sheet |
| Dismiss | Esc, backdrop, close button | close button, Esc |
| Actions | footer bar | **sticky** bottom bar |

`role="dialog"`, `aria-modal="true"`, labelled, focus trapped, focus restored to
the FAB on close.

### 2.3 Two steps — never a wizard

```
STEP 1 - Appointment details          STEP 2 - Assign to
+----------------------------+        +----------------------------+
| Customer   [Ahmad        ] |        | Ahmad . Tue 9 Sep . 13:00  |
| Phone      [012-3456789  ] |        | Sofa cleaning . RM400      |
| Address    [12 Jalan ...  ] |        |                    [Edit]  |
| Area       [Cheras       ] |        +----------------------------+
| -- Services --             |        | +------------------------+ |
| [Sofa cleaning] [1] [400 ] |        | |  Jack                  | |
| + Add item                 |        | +------------------------+ |
| Date [Tue 9 Sep] Time[13:00]|       | +------------------------+ |
| Remarks    [            ]  |        | |  Dyron                 | |
+----------------------------+        | +------------------------+ |
|           [ Assign staff ->]|       | +------------------------+ |
+----------------------------+        | |  Victor                | | <- KC only
                                      | +------------------------+ |
                                      |        one tap = book      |
                                      +----------------------------+
```

No workspace field anywhere on the happy path. No staff field in step 1. Step 2
carries a one-line summary with **Edit** back to step 1; entered data is never
lost.

### 2.4 LOCKED — one tap means ASSIGN + CREATE

Tapping a staff card immediately attempts the real booking through
`create_appointment()`. There is **no second Save button**.

### 2.5 LOCKED — no pre-flight availability check

Do **not** check availability before the tap.

`find_available_slots()` is deliberately standard-job only: it uses the fixed
`default_availability_job_duration_minutes` from `business_settings`. A real
Quick Add job may be RM200, RM400 or RM800 with a different computed duration,
so a standard-job pre-check can disagree with the actual appointment — telling
the owner someone is free when the real booking will refuse, or implying someone
is busy when they are not. A wrong hint on the decisive tap is worse than no
hint, and it costs a round-trip between the two steps.

**Do not make the pre-check amount-aware.** The amount/duration availability
oracle was a confirmed privacy defect, closed in migration `0007`. It must not
return in any form.

The database remains authoritative. The failure path (2.7) is fast and lossless.

### 2.6 Success path

KC enters Ahmad / 012… / Cheras / Sofa cleaning / RM400 / Tuesday / 13:00, taps
**Assign**, sees Jack · Dyron · Victor, taps **Jack**:

- committed through the trusted RPC
- `staff_id` = Jack
- `workspace_id` auto-derived = Shared Team
- sheet closes
- current calendar / dashboard / agenda refreshes in place via `router.refresh()`
- concise feedback: **"Assigned to Jack"**

No optimistic rows — nothing renders before the database commits.
`revalidatePath` already sweeps `/calendar`, `/appointments` and `/my/*`.

The new row is highlighted for one render via `?new=<id>` on the current page.
That is the caller's own appointment id, the same class of value already present
in `/appointments/[id]` URLs.

### 2.7 Failure path — nothing is ever cleared

```
CLOSED --FAB--> DETAILS --Assign staff--> ASSIGN --tap staff--> SUBMITTING
                   ^                        ^  ^                    |
        VALIDATION |            STAFF_UNAVAILABLE |                 |
            _ERROR |      PHYSICAL_OVERLAP, TIME_OFF,               |
       (field errs)|      OUTSIDE_WORKING_HOURS, PAST_DATETIME      |
                   |                           |                    |
                   +---------------------------+                    |
                                               |   LARGE_JOB_       |
                                    OVERRIDE <-+-- OVERRIDE_REQUIRED
                                       |  (reason + acknowledgement)
                                       +--- retry SAME staff -------+
                                                                    v
                                                        SUCCESS -> CLOSED
                                                   router.refresh() + toast
```

Customer, job, date and time live in the sheet's client state and are re-sent on
every attempt. Only the staff choice is retried.

**`STAFF_UNAVAILABLE`** shows exactly:

> Jack is not available at this time. Choose another staff member or time.

Then the same authorised assignment list. No reason, no time, no amount, no
conflict type, no workspace, no large-job classification. It **never** opens the
override dialog — that code means the blocking appointment is hidden from this
caller, so offering to override it would disclose its existence and the database
would refuse anyway.

**`PHYSICAL_OVERLAP`** remains permanently non-overridable.

**`LARGE_JOB_OVERRIDE_REQUIRED`** for an authorised Master opens the existing
`OverrideDialog` — non-empty reason plus explicit acknowledgement — then retries
the **same** staff member. Per-exception only; there is no persistent toggle.
Staff callers never see override UI, and their `overrideReason` is dropped
server-side, so the UI's absence is not the control.

All codes route through the existing `AppError` mapping. Raw Postgres or
PostgREST text is never rendered.

---

## 3. LOCKED — Nick privacy

The assignment list is fetched by a Server Action when the sheet **opens**, not
embedded in any page's payload. So on `/calendar`, `/dashboard` and everywhere
else there is **no staff array in the RSC flight payload at all** — nothing to
hide with CSS, because nothing was sent.

When it is fetched it comes from `resolveBookingContext`, whose ordering is the
security property: it enumerates RLS-visible workspaces, active staff and active
memberships **first**, then matches anything requested against that set. Nick's
queries do not return Victor or KC Private Team.

From Nick's browser the system contains exactly Jack and Dyron. There must be
no Victor name, uuid, count, disabled entry, placeholder, autocomplete entry or
background-fetch trace; no `KC Private Team` string or uuid; no "1 hidden
staff", "3 total staff" or "1 unavailable".

**Do not fetch all staff and filter client-side.**

The list renders as a **flat staff list**, not grouped by workspace, so no
workspace names leak into it either.

A forged Victor uuid in the Server Action payload resolves to zero eligible
workspaces and returns a generic `NOT_AUTHORIZED` — identical in message, shape
and timing class to a random uuid, since both fail the same in-memory lookup
after the same queries and before any RPC call. Enforcement is server-side and
database-side; React rendering is never the control.

---

## 4. Roles

| Caller | Step 2 |
| --- | --- |
| KC (super_master) | Jack · Dyron · Victor |
| Nick (partner_master) | Jack · Dyron |
| Any staff | **skipped entirely** |

Staff Quick Add is one step: details, then Save. No assign screen, and no staff
list is fetched at all. `create_appointment` derives identity from the JWT
(`p_staff_id: null`), so the client never names the staff member and there is
nothing to forge. Jack creates only for Jack; Victor only for Victor.

---

## 5. Workspace derivation

Derived server-side **after** staff selection. Never asked on the normal path,
never sent by the browser.

```
eligible = context.workspaces.filter(w => w.staff.some(s => s.id === staffId))

0  -> NOT_AUTHORIZED  (indistinguishable from a random uuid)
1  -> derive it       (the normal path)
2+ -> ask, showing only those workspaces
```

Current data: KC->Jack = Shared Team · KC->Dyron = Shared Team ·
KC->Victor = KC Private Team · Nick->Jack = Shared Team.

**All Operations is virtual and is never stored as `workspace_id`.** It cannot
be, because the value is computed from memberships rather than taken from the
scope parameter.

The multi-workspace question appears only when `eligible.length > 1`, only after
staff selection, with the details intact. It costs the normal path nothing — the
value is `1` for every staff member today — and exists so a future Settings
change cannot silently misattribute a booking.

---

## 6. Component reuse — no second engine

`createAppointmentAction` requires `workspaceId` up front, which Quick Add
cannot supply. Rather than a parallel action, extract the shared core:

```
lib/appointments/booking.ts
  bookAppointment(session, context, input) -> CreateResult
      |-- assertBookable          (unchanged)
      |-- create_appointment RPC  (unchanged arguments)
      |-- revalidatePath sweep    (unchanged)
      +-- logAndMap               (unchanged)
           ^                              ^
  createAppointmentAction        quickAddCreateAction
  (F2 - behaviour unchanged)     (derives workspace first)
```

One code path reaches the database. Reused as-is: `ItemsEditor`,
`OverrideDialog`, `itemSchema`, `AppError` mapping, `getBookingConfig`, and the
date/time controls.

`quickAddSchema = createAppointmentSchema.omit({ workspaceId: true, returnTo: true })
.extend({ workspaceId: uuid.optional() })` — optional purely for the
multi-workspace exception.

`AvailabilitySuggestions` is **not** reused in Quick Add: no staff is chosen at
the point the time is entered.

**`/appointments/new` and `/my/appointments/new` remain.** They serve calendar
click-to-book, availability Book-this-time, deep links and manual booking. Quick
Add is an additional fast path, not a replacement.

---

## 7. Calendar

### 7.1 Desktop — staff rows x day columns

```
+------------------------------------------------------------------+
| Calendar   Mon 8 - Sun 14 Sep 2026 . All Operations              |
| [<- Prev] [This week] [Next ->]      [Find a time] [+ New]       |
+--------+------+------+------+------+------+------+---------------+
|        | MON 8| TUE 9| WED10| THU11| FRI12| SAT13| SUN14         |
|        | TODAY|      |      |      |      |      |               |
+--------+------+------+------+------+------+------+---------------+
| Jack   | 10:00|  --  | 13:00|  --  | 10:00|  --  |  --           |
|        | Tan  | [+]  | Lim  | [+]  | Wong | [+]  | [+]           |
+--------+------+------+------+------+------+------+---------------+
| Dyron  |  --  | 10:00|  --  |  --  | 15:00|  --  |  --           |
+--------+------+------+------+------+------+------+---------------+
| Victor | 13:00|  --  |  --  | 10:00|  --  |  --  |  --           |  <- KC only
+--------+------+------+------+------+------+------+---------------+
```

The Master's question is "who is free, and when". Days-as-columns makes that a
scan-and-group task across every card; staff-as-rows makes an empty cell the
answer itself. It fits the data — three staff, seven days, slot-based times, so
a cell holds nought to three entries. A pixel-positioned time grid would waste
vertical space on empty hours and break on mobile.

Rows follow the scope: All Operations gives every authorised active staff
member, a workspace scope gives that workspace's, and Nick always gets Jack and
Dyron only.

### 7.2 LOCKED — calendar honesty rule

An empty cell means **"no appointment visible here"**. It does **not** mean
"free".

A staff member may hold a hidden cross-workspace appointment that physically
blocks that time. That gap is the privacy model working correctly and must not
be closed — closing it would disclose the hidden job.

So a cell is never labelled **Free** or **Available**. It renders a neutral
`—` with a `+` affordance. The authoritative answer to "can this be booked"
comes from `find_available_slots()` and, finally, from `create_appointment()`.

### 7.3 Mobile — day picker plus day agenda

A 3x7 matrix cannot survive 390px.

```
Calendar . Mon 8 - Sun 14 Sep      [Find a time]
+----+----+----+----+----+----+----+
|MON |TUE |WED |THU |FRI |SAT |SUN |   scrollable, >=44px, TODAY ringed
| 8. | 9  |10. |11  |12. |13  |14  |   . = has visible jobs
+----+----+----+----+----+----+----+
 Monday 8 September
 -- Jack ---------------------------
   [10:00-11:00  Tan Ah Kow   RM200]
   [+ Book Jack on Mon 8]
 -- Dyron --------------------------
   Nothing scheduled  [+ Book Dyron]
```

The day picker is server-rendered `<a href>` links (`?day=`), keyboard
navigable, no hydration cost. It reuses the full (non-compact) card, which
already carries real status badges and the Directions / Call / WhatsApp actions.

The desktop/mobile switch is CSS (`hidden lg:block` / `lg:hidden`).

### 7.4 Other calendar fixes

- Explicit date range in the header (`Mon 8 – Sun 14 Sep 2026`), not just
  "week of".
- A real **Today** indicator; there is none today.
- Grid goes to seven columns at `lg`, not `xl` — the current `xl:7` leaves a
  4+3 wrap at `lg` that reads as two weeks.
- Empty week state with a New appointment action.
- Compact card status is currently a coloured dot only. `aria-label` and
  `title` cover screen readers, but it is visually colour-alone; add a glyph or
  short text.

### 7.5 Click-to-book

Empty cell or `+` opens `/appointments/new` with **hints only**:

| Scope | Link |
| --- | --- |
| Real workspace | `?ws=<uuid>&staff=<uuid>&date=<iso>&return=calendar` |
| All Operations | `?staff=<uuid>&date=<iso>&return=calendar` — **`ws` omitted** |

`all` is never emitted as a workspace id. Under All Operations a staff member
may belong to several workspaces, so attribution is genuinely ambiguous — the
form requires a real workspace before save rather than guessing.

No new plumbing: the page already accepts `ws/staff/date/time/return`, and
`resolveBookingContext` drops a hint that does not match the caller's visible
set, in silence. Cells carry no `time` hint — a day is not a time.

### 7.6 Appointment click-through

Unchanged: `/appointments/[id]`. **No detail UI is built inside the calendar.**

### 7.7 Aggregates

Any count or total on `/calendar` is computed from the already-RLS-filtered
array the page received — never a separate server aggregate. KC and Nick
legitimately see different figures, and the test asserts they differ. This is
the `DASH-02` lesson.

Never render a "Private booking" placeholder card: a greyed block at 10:00
announces that something exists at 10:00.

---

## 8. `/availability` — Find a time

```
Find a time                                    All Operations
Team members   [x Jack] [x Dyron] [x Victor]      chips, >=44px
When           (o) Today ( ) Tomorrow ( ) This week ( ) Next week ( ) Custom
               [2026-09-08] -> [2026-09-14]        max 14 days
                                          [ Find times ]

3 suggested times
 Mon 8 Sep   10:00  Jack    [Book this time]
 Mon 8 Sep   13:00  Dyron   [Book this time]
 Tue 9 Sep   10:00  Jack    [Book this time]

Suggested for a standard job. Final availability is confirmed when saving.
```

Available rows only. No reasons, no count of what was excluded, no hidden
schedule information.

**The RPC is unchanged and stays exactly four arguments:**

```
find_available_slots(p_staff_ids, p_from, p_to, p_workspace_id)
```

No amount, no duration, no buffer, no caller-supplied probe times. It already
accepts a staff array and returns `(staff_id, slot_date, slot_time)`, so
multi-staff search needs no backend work. Staff names are resolved from the
RLS-visible roster, never echoed from input.

**Find -> Book**: `/appointments/new?ws=…&staff=…&date=…&time=…&return=availability`,
same hint rules as 7.5. Requires adding `availability: "/availability"` to
`RETURN_DESTINATIONS` — the closed enum, so redirecting off-site stays
impossible.

The 14-day cap is enforced in the action before the RPC, so the user gets a
precise message; the RPC's own `Range too large` remains the backstop.

### 8.1 Full flow

```
        +----------+  who is free?   +--------------+
        | /calendar| --------------->| /availability|
        +----+-----+                 +------+-------+
   click job |        click empty cell      | Book this time
             |        (ws?,staff,date)      | (ws?,staff,date,TIME)
             v                  +-------+   |
   +-------------------+                v   v
   | /appointments/[id]|         +------------------+
   |   F3 - unchanged  |         | /appointments/new|
   +-------------------+         |   F2 - unchanged |
                                 +--------+---------+
                        hints re-validated| server-side
                       (assertBookable +  |  create_appointment)
                                          v
                              return=calendar | availability

        Quick Add (FAB) is the fast path past all of this:
        (+) -> details -> assign staff -> create
```

---

## 9. States

**Calendar** — loading skeleton in the matrix shape; empty week with an action;
failures through `ErrorNotice`.

**Availability** — needs a new `loading.tsx`. Initial (no search yet, and no
premature "none found"), searching, "No suggested times in this range. You can
still book a custom time.", invalid range, and error.

Verified mapping status: `Invalid range`, `Range too large` and
`Multiple active workspace memberships` already map to `VALIDATION_ERROR`.

---

## 10. Accessibility

Keyboard-reachable cards and buttons, visible focus states, labelled calendar
controls, no status encoded by colour alone, and no tiny time-slot targets.

---

## 11. Test plan

### Quick Add (`tests/e2e/quick-add.test.mjs`)

| # | Check |
| --- | --- |
| 1-3 | KC sees Jack/Dyron/Victor; Jack lands in **Shared Team**; Victor lands in **KC Private Team** |
| 4-5 | Nick sees exactly Jack and Dyron; visible text has no Victor |
| 6-8 | Full HTML, **RSC flight payload** and the **Server Action response body** carry no Victor uuid or name, no private workspace uuid, no "KC Private Team" |
| 9-10 | Forged Victor uuid creates nothing and behaves identically to a random uuid |
| 11 | No staff count anywhere — no "3 staff", "1 hidden", "1 unavailable" |
| 12-14 | Jack sees no assign step; Jack's row is `staff_id = Jack`; Victor's is Victor |
| 15-16 | Jack unavailable: details preserved field by field, assign reopens, **no override UI** |
| 17-18 | Master `LARGE_JOB_OVERRIDE_REQUIRED` opens the dialog; staff never see it |
| 19-20 | Single workspace auto-derived with no prompt; a temporary dual-membership fixture makes the workspace question appear only after staff selection, then is torn down |

Plus: FAB on all seven routes and absent on the two `new` pages; >=44px at
390px; focus trap and restore; `router.refresh()` puts the row on the calendar
without a navigation.

### Calendar and availability (`tests/e2e/calendar-availability.test.mjs`)

KC: matrix in all three scopes; rows match scope; appointment click-through;
empty cell prefills correctly; All Operations emits no `ws`; availability across
all three staff; Book -> save -> return.

Nick (critical): no scope selector; no Victor row ever; visible text, HTML and
RSC payload clean; availability returns only Jack and Dyron; forged private
workspace and Victor uuid behave like random uuids; a hidden Private appointment
never renders.

Semantics: a hidden appointment may remove a suggested slot with no reason
returned; `pg_stat_statements` proves only the four-argument signature executes.

Honesty: an empty cell is never labelled "Free" or "Available".

Navigation: an unknown `?return=` falls back; no off-site redirect.

Mobile: no horizontal overflow at 390/768/1440; day picker and Book targets
>=44px; matrix hidden and agenda shown.

Aggregates: KC and Nick see different week totals.

---

## 12. Files

**New** — `components/quick-add/{QuickAddFab,QuickAddSheet,QuickAddDetails,AssignStaff,WorkspaceChoice}.tsx`,
`lib/appointments/booking.ts`, `lib/appointments/quick-add-actions.ts`,
`components/agenda/StaffWeekGrid.tsx`, `components/agenda/DayPicker.tsx`,
`components/agenda/CalendarDayAgenda.tsx`,
`components/availability/{AvailabilityFinder,AvailabilityResults}.tsx`,
`lib/availability/queries.ts`, `app/(master)/availability/page.tsx` and its
`loading.tsx`, `tests/e2e/quick-add.test.mjs`,
`tests/e2e/calendar-availability.test.mjs`.

**Modified** — both `layout.tsx` (mount the FAB), `lib/appointments/actions.ts`
(delegate to the shared core; no behaviour change),
`lib/appointments/schema.ts` (add `quickAddSchema`),
`lib/navigation/return-to.ts` (add `availability`),
`app/(master)/calendar/page.tsx`, `components/agenda/AppointmentCard.tsx`
(status glyph).

**Untouched** — all migrations, every RPC, `/appointments/new`,
`/my/appointments/new`, F3, `/settings`, `/staff`, `/reports`.

`/appointments` gets only a matching range header for consistency. Search,
filtering and pagination remain future work.

---

## 13. Implementation order

1. Commit this document
2. Extract the shared `bookAppointment()` core
3. Prove F2 remains 46/46 unchanged
4. FAB and responsive sheet shell
5. Quick Add details step
6. Quick Add server-side authorised context
7. Assign staff step
8. Workspace auto-derivation
9. One-tap create
10. Conflict / override state machine
11. Nick privacy security suite
12. Calendar staff-row matrix
13. Mobile day picker and agenda
14. Click-to-book
15. `/availability` Find a time
16. Find -> Book integration
17. Responsive and accessibility QA
18. Full regression and DEV baseline cleanup

---

## 14. Notes carried forward

Not defects; recorded so they are not rediscovered as surprises.

1. **All Operations uses the company-default slot list.** With
   `p_workspace_id` null the RPC skips the per-workspace `suggested_time_slots`
   lookup and falls back to the `workspace_id IS NULL` set. DEV holds only
   company defaults (10:00 / 13:00 / 15:00), so nothing diverges today — but if
   Settings ever adds per-workspace slots, All Operations will differ from that
   workspace's own view.
2. **An empty calendar cell is not "free"** — see 7.2.
3. **Availability errors map to a generic `VALIDATION_ERROR`** — mitigated by
   validating the range in the action first.
4. **Staff with two or more active workspaces** raises
   `Multiple active workspace memberships` when no workspace is passed.
   Unreachable today, and both booking forms always pass one. Worth a
   regression test so a future Settings change surfaces it loudly.
