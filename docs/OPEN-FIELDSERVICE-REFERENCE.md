# OpenFieldService — product/UX reference

A reference implementation we studied. **Not** a replacement architecture, not a
backend, not a deployment foundation, and not a code donor.

Everything here is a product observation or an independently-stated design
position. No source code, CSS, component, schema or route was copied into this
repository, and none will be without a separate decision.

---

## What was examined

`clawnify/open-fieldservice` @ `00da6ce`, checked out at
`../open-fieldservice-mrclean`. Cloudflare Workers + D1 (SQLite), Hono,
Preact, Vite. 4,339 lines across 31 files: a 1,425-line server, a 150-line
schema, 22 client components.

Read, not run. The observations below are from the source and schema, so where
this document states a fact about the software it is checkable.

### Licensing — the picture is more precise than "unresolved"

| | state |
| --- | --- |
| the repository | **MIT**, "Copyright (c) 2026 Clawnify" — a `LICENSE` file is present |
| `package.json` | declares **no** `license` field |
| `@clawnify/app@0.1.0` | **no license declared, no LICENSE file shipped** |
| `@clawnify/db@0.4.1` | **no license declared, no LICENSE file shipped** |

So the two halves differ. The application source is MIT and could lawfully be
copied **with attribution and the licence text retained**. The `@clawnify/*`
runtime packages it depends on are genuinely unlicensed — they grant nothing,
and the caution against vendoring them is correct.

This does not change what we do. The standing decision is concepts only, and
that is a stronger position than the licence requires: a pattern we design
ourselves carries no attribution obligation, no upstream coupling, and no
argument later about which file came from where. It is recorded here so the
reason is "we chose not to", not "we were not allowed to".

---

## Pattern catalogue

Each entry answers the same ten questions. Priorities mean:

- **Now** — worth scheduling next; the foundations already exist
- **Soon** — clearly valuable, needs a design pass first
- **Later** — real value, but depends on something we have deliberately deferred
- **Reject** — we should not do this

---

### 1. Job detail as one working surface

**What the user sees.** A single screen holding everything about one visit:
identifier, status and priority badges; a six-cell meta grid (customer, address,
scheduled time and duration, price, service type, assigned technician); then
stacked sections for checklist, materials used, and activity. A right sidebar
carries the controls — status, technician assignment — so the record and the
actions on it never compete for the same column.

**Why it is useful.** The dispatcher's questions ("who is going, when, for how
much, is it done") are answered without scrolling, and the actions sit beside
the facts they change. The split between "read this" and "change this" is what
keeps a dense screen calm.

| | |
| --- | --- |
| **Do we have an equivalent?** | Partly. Appointment Detail has Edit customer, Edit services, Reschedule, Mark completed and Cancel, and a conflict-override dialog they have nothing like. We have no sidebar split — our actions are a row of buttons that open panels inline. |
| **What could improve** | The read/act separation. Our panels push the record down the page when opened, so on a laptop the thing you are editing scrolls out of view. A right rail on wide screens, panels inline below `lg`, would fix that without changing a single server action. |
| **Priority** | **Soon** — presentation-only, no engine or schema change. |
| **Dependencies** | None. |
| **Privacy/security** | None beyond what Appointment Detail already enforces. A layout change must not widen the server-rendered payload: the detail page is already RLS-scoped and should stay field-for-field the same. |
| **Mobile** | The rail must collapse, not shrink. Their sidebar is a fixed 260px with no media query, which is exactly the failure we must not copy. |

*Concept only — no source code copied.*

---

### 2. Status as a visible state machine

**What the user sees.** Five statuses (`scheduled`, `confirmed`, `in_progress`,
`completed`, `cancelled`) rendered as a row of buttons with the current one
highlighted. Every state is visible at once; one click moves between any two.

**Why it is useful.** You can see the whole lifecycle and where this job sits in
it, without opening a menu. That is genuinely better than a dropdown for a
five-state machine.

| | |
| --- | --- |
| **Do we have an equivalent?** | Partially, and ours is safer. We have `booked / completed / cancelled` with explicit confirmation, a cancellation reason, and server-side lifecycle rules. Theirs has no guard at all: any status to any status, one click, no confirmation, and — see §12 — no authentication. |
| **What could improve** | The *visibility*, not the mechanism. Our status is a badge; the lifecycle is invisible until you press something. Showing the states with the current one marked, while keeping confirmation and server rules, is the useful half. |
| **Priority** | **Later** — cosmetic next to the work in §6, and our three-state machine gains less from it than their five-state one. |
| **Dependencies** | None. |
| **Privacy/security** | Adopt the display, never the freedom. A one-click irreversible transition is the §12 anti-pattern wearing different clothes. |
| **Mobile** | Five equal buttons do not fit at 390px. Ours is three, which does. |

*Concept only — no source code copied.*

---

### 3. Inline staff reassignment

**What the user sees.** A `<select>` on the job screen listing technicians, plus
"Unassigned". Change it and the job moves.

**Why it is useful.** Reassignment is the most common schedule edit in a service
business — someone is sick, someone is closer — and it does not deserve a
separate flow.

| | |
| --- | --- |
| **Do we have an equivalent?** | **No.** This is a real gap. Our Appointment Detail can change the customer, the services and the time, but not who is going. Today that means cancelling and rebooking, which loses the record. |
| **What could improve** | Add reassignment. But it is not a dropdown for us: our engine has to re-validate physical availability, working hours, time off, buffers and the large-job forward lock against the *new* staff member, and it must respect the global-availability rule — an unauthorised viewer learns only `STAFF_UNAVAILABLE`, never who is busy. |
| **Priority** | **Now** — highest-value gap this review surfaced. |
| **Dependencies** | A reassignment RPC in the appointment engine with the same validation and override path as `reschedule_appointment`; an audit entry; the existing conflict-override dialog reused unchanged. |
| **Privacy/security** | Significant. The staff list offered must be workspace-scoped: Nick must never see Victor in a dropdown, in the HTML, or in the RSC payload. Validation failures must not disclose *why* a hidden staff member is unavailable. |
| **Mobile** | A native select is the right control on a phone. Must remain reachable without a hover state. |

*Concept only — no source code copied.*

---

### 4. Job checklist

**What the user sees.** A list of free-text items on the job, each a tick box,
added by typing and pressing Enter. Checked items are struck through.

**Why it is useful.** It turns "did we do it" into a record instead of a memory,
and it is visible to whoever opens the job next.

| | |
| --- | --- |
| **Do we have an equivalent?** | No. |
| **What could improve** | Cleaning work suits this better than most trades: arrival, inspection, before-photo, cleaning completed, customer verification. But theirs is typed fresh on every job, which in practice means it is typed once and never again. For us it should be **optional templates per service type**, instantiated onto the appointment at booking and editable afterwards — per-appointment storage, per-service-type defaults. Not per-appointment-only (no consistency) and not per-service-type-only (no record of what actually happened). |
| **Priority** | **Later** — it implies a service-type catalogue we do not have, and imposing steps on staff is a workflow decision, not a UI one. |
| **Dependencies** | A service-type concept; a checklist table keyed to the appointment; a staff-side mobile surface, since the person ticking is in the field. |
| **Privacy/security** | Low, provided items inherit the appointment's visibility. A checklist must never become a second place customer details are stored. |
| **Mobile** | This is a phone feature first. Tick targets ≥44px; must work on a bad connection, which argues for optimistic local state. |

*Concept only — no source code copied.*

---

### 5. Materials as cost logging

**What the user sees.** A materials catalogue (name, unit, unit cost, stock
figure), and per job a table of what was used with quantity, unit cost and line
total.

**Why it is useful.** It answers "what did this job cost us" without pretending
to be an inventory system. Notably, the schema has an `in_stock` column that
**nothing ever decrements** — the stock number is decoration.

**Which of the three options we want.** The honest answer for Mr Clean is
**(2) consumable cost logging, and not yet**:

1. *No materials feature* — viable today. Chemicals and consumables are a small
   fraction of a job priced by hour and by item.
2. *Consumable cost logging* — the useful version. It would make gross margin per
   job visible, which the RM/hour model currently cannot show.
3. *Actual inventory* — **reject.** Reorder points, stock counts, wastage and
   shrinkage are a different product, and a stock number nobody maintains is
   worse than no stock number, as their own dead column demonstrates.

| | |
| --- | --- |
| **Do we have an equivalent?** | No. `appointment_items` records what the customer is charged, never what it cost us. |
| **What could improve** | Only pursue it when someone will actually record usage on every job. Half-recorded cost data produces confidently wrong margins. |
| **Priority** | **Later** (option 2), **Reject** (option 3). |
| **Dependencies** | A consumables catalogue; a per-appointment usage table snapshotting unit cost at the time (their one genuinely good schema decision — a later price change must not rewrite history); a staff-side entry surface. |
| **Privacy/security** | Cost data is commercially sensitive and is *not* the same as the price the customer sees. It must be Master-visible only, and must never reach a staff-side payload or a customer-facing message. |
| **Mobile** | Entry happens in the field, so it must be a phone form or it will not happen. |

*Concept only — no source code copied.*

---

### 6. Activity timeline on the record

**What the user sees.** A notes feed on the job: type a line, press send, it
appends with a timestamp.

**Why it is useful.** "What happened to this booking" is answered in place,
rather than reconstructed from memory.

**The important flaw.** It records only what someone types. Status changes,
reassignments and reschedules write nothing. So the timeline is a comment
thread wearing a history's clothes — the entries you most want ("who moved this
to Thursday, and when") are exactly the ones missing.

| | |
| --- | --- |
| **Do we have an equivalent?** | **We have the better half already and do not show it.** `audit_logs` is written by the RPC engine for every mutation — automatically, server-side, unforgeable. `/audit` is still a Phase 1 placeholder, and nothing in the frontend reads the table. |
| **What could improve** | Surface it. An "Activity" section on Appointment Detail reading the appointment's own audit rows — created, rescheduled, items changed, completed, cancelled with reason — gives us their pattern's value and none of its flaw, from data we are already writing. A free-text note could come later; the automatic history is what matters. |
| **Priority** | **Now** — the data exists, the writes exist, only the read is missing. |
| **Dependencies** | An RLS-checked read of `audit_logs` scoped to one appointment; actor display names. |
| **Privacy/security** | Real care needed. Audit rows name actors and may reference workspaces: a Shared-Team Master must not learn from a timeline that someone they cannot see touched a record. Scope the read to the appointment and filter actor identity to the caller's own visible workspaces. |
| **Mobile** | Collapsed by default, expandable. It is reference material, not the primary action. |

*Concept only — no source code copied.*

---

### 7. Customer service history

**What the user sees.** Open a customer, and their past and upcoming jobs are
listed underneath their contact details.

**Why it is useful.** It answers "have we been here before, what did we do, what
did we charge" at the moment of quoting — which is when it is worth money.

| | |
| --- | --- |
| **Do we have an equivalent?** | No, deliberately. V1 stores customer details as a **snapshot on each appointment**. There is no customers table and we are not adding one now. |
| **What could improve** | Eventually, a customer identity. The value is real and rises with every repeat booking. |
| **Future data-model implications** | Snapshots are the right V1: an address corrected in 2027 must not silently rewrite what we agreed in 2026. Introducing identity means adding a nullable `customer_id` alongside the snapshot, never replacing it — the snapshot stays the record of what was agreed, the link becomes the thread between records. |
| **Duplicate identity** | The hard part. "Grace", "Grace Tan" and "grace" are one person; two different Graces in Puchong are not. Any matching must **propose** and let a human confirm — never merge automatically. A wrong merge joins two people's addresses and histories, and is very hard to unpick afterwards. |
| **Phone matching** | The most reliable key we have, and still not a key. Malaysian numbers arrive as `0148136726`, `+60148136726`, `60148136726` and with spaces; households share numbers; agents book for tenants. Normalise to E.164 for *comparison only*, treat a match as a strong hint, and never as proof. |
| **Migration path** | Backfill is a suggestion engine, not a script: group existing appointments by normalised phone, present candidate clusters, let the owner confirm or reject each. Unmatched appointments simply keep their snapshot and no link. |
| **Priority** | **Later** — a genuine future feature, correctly deferred. |
| **Dependencies** | Customers table, dedup review UI, backfill tooling, RLS policies for a new entity. |
| **Privacy/security** | This is the largest privacy surface in the catalogue. A customer record spanning workspaces would let a Shared-Team Master infer that a private-workspace job exists for that customer. Cross-workspace history must be scoped per workspace, or the whole workspace-privacy model leaks through the customer page. |
| **Mobile** | A history list is easy; the dedup review screen is not. Design it for desktop. |

*Concept only — no source code copied.*

---

### 8. Today's operations view

**What the user sees.** A stat row across the top, then "Today's Schedule": a
compact table of today's jobs — time, identifier, customer, technician, status —
each row clickable through to the job.

**Why it is useful.** Rows beat cards for this. Five columns of aligned text
scan far faster than five cards, and the day fits on one screen.

**Two flaws worth naming.** "Today" is computed in **UTC**
(`toISOString().split("T")[0]`), which in UTC+8 means the day flips at 08:00
local — before 8am, "today" shows yesterday. And the stat row is a set of
**global aggregates**: total jobs, revenue, outstanding invoices, computed
without any scoping.

| | |
| --- | --- |
| **Do we have an equivalent?** | We have the month overview, and it is the same instinct: compact entries, `businessToday()` in `Asia/Kuala_Lumpur`, and totals summed from the rows RLS already returned rather than a separate aggregate query. |
| **What could improve** | A **Today** band above the month grid, when today has work: the same compact rows, so the day you are actually running is not something you have to find in a grid cell. `This Week / Next Week` can follow the same shape. None of it needs to return to oversized cards — one line per job, not one card per job. |
| **Priority** | **Soon** — additive, and the month redesign's density rules already apply. |
| **Dependencies** | None; the month query already covers today. Filter what we have, do not fetch again. |
| **Privacy/security** | Their global aggregate is precisely the mistake we must not make. Every total on our dashboard is computed from rows this caller received through RLS, so Nick and KC legitimately see different figures. Keep it that way. |
| **Mobile** | Our day agenda already is this pattern at `< lg`. A Today band should be rows on every width. |

*Concept only — no source code copied.*

---

### 9. Technician colour coding

**What the user sees.** Each technician has a colour. It appears as a dot beside
their name and as the left border of their entries in the schedule, so a week
reads as bands of colour per person.

**Why it is useful.** Distribution across staff becomes visible before you read
any text — "Dyron has four days, Jack has one" is apparent at a glance.

**They got the accessibility part right**, and it is worth saying: the colour is
always *accompanied* by the name in text. The colour is a second channel, never
the only one. The weakness is the source — a free colour picker per technician,
so nothing prevents two near-identical greens, or a colour illegible on white.

| | |
| --- | --- |
| **Do we have an equivalent?** | No. Our calendar and month grid identify staff by name only. |
| **What could improve** | A **fixed palette** assigned per staff member — chosen once for contrast against our surfaces and distinguishable under the common forms of colour blindness — rather than a free picker. Applied as a left border on calendar entries, exactly as they do, with the name still in text. |
| **Priority** | **Soon** — small, self-contained, and it makes the month grid measurably more scannable. |
| **Dependencies** | A stable colour per staff member. Derivable from the staff id, so no migration is needed for V1. |
| **Privacy/security** | Low, with one trap: a colour must not encode workspace. If private-workspace staff shared a distinguishing colour, an unauthorised viewer could infer their existence from a legend. Per person, never per workspace, and no legend listing staff the viewer cannot otherwise see. |
| **Mobile** | A 2px border costs no space. Never make colour the only difference between two entries at any width. |

*Concept only — no source code copied.*

---

### 10. Invoice from a completed job

**What the user sees.** A "Create Invoice" button on the job. Invoices carry
line items, a subtotal, a tax rate and amount, a total, a due date and a paid
date, and move through `draft → sent → paid / overdue / cancelled`.

**Why it is useful.** The job already knows the customer, the work and the
price, so re-entering it into an invoice is duplicated typing and a chance to
get it wrong. Generating from the completed job is the right default, and the
status lifecycle with a due date is what makes "who owes us money" answerable.

**Why their implementation is insufficient for Mr Clean.** Currency is hardcoded
`$` with no currency field, so it is not merely unlocalised — it has nowhere to
put RM. Tax is a single flat `tax_rate` with no tax code, no registration
number, no exemption handling, so Malaysian SST cannot be represented properly.
There is no PDF, no print stylesheet (the CSS has **no `@media` rules at all**),
no company letterhead, and no sharing — and for this business a WhatsApp-ready
document is not a nice-to-have, it is the delivery mechanism.

| | |
| --- | --- |
| **Do we have an equivalent?** | No. We record `total_amount` and line items on the appointment; there is no invoice entity. |
| **What could improve** | If we build invoicing, generate from the completed appointment and keep the status lifecycle. Everything else must be designed for Malaysia from the start — RM, SST treatment, a letterhead document, and a share path that produces something sendable on WhatsApp. |
| **Priority** | **Later** — a product decision, not a UI one, and it needs accounting input before design. |
| **Dependencies** | Invoice entity and numbering; a document renderer; tax rules confirmed with whoever files them. |
| **Privacy/security** | Invoices are financial records: immutable once sent, workspace-scoped, and fully audited. A shareable document is a link that escapes our authorization entirely — it must be deliberately scoped and expiring, not a guessable URL. |
| **Mobile** | The owner will send invoices from a phone. The share path must work there or it will not be used. |

*Concept only — no source code copied.*

---

### 11. Mobile — recorded as an anti-pattern

**What the user sees on a phone.** A desktop layout, unchanged. There are
**zero `@media` queries in 932 lines of CSS**. The navigation sidebar is a fixed
240px, the detail sidebar a fixed 260px, and the schedule is
`grid-template-columns: repeat(7, 1fr)` at every width — seven columns on a
390px screen.

**Why it matters to us.** This is the technician's primary device, and the
application is unusable on it. A field-service tool that assumes a desk has
misidentified who uses it.

| | |
| --- | --- |
| **Do we have an equivalent?** | We have the opposite, and it is a requirement rather than an aspiration. Staff surfaces are mobile-first; the calendar and dashboard switch layout by geometry; the responsive suite asserts no horizontal overflow and ≥32px tap targets at 390/768/850/1440. |
| **What could improve** | Nothing to adopt. The lesson is the standard: **any feature inspired by this document must arrive with its mobile behaviour designed, not retrofitted** — and must not be considered done until it has been measured at 390px. |
| **Priority** | **Reject** (as an implementation); **Now** (as a constraint on everything above). |
| **Dependencies** | None. |
| **Privacy/security** | None. |
| **Mobile** | The whole point. |

*Concept only — no source code copied.*

---

### 12. Delete safety — negative reference

**What happens.** "Delete" on a job or a customer fires immediately: no
confirmation dialog, no typed acknowledgement, no undo. `customers` cascades to
`jobs`, which cascades to job notes, checklist items and materials, and to
`invoices`, which cascades to invoice lines. One click on a customer can erase
their entire commercial history including issued invoices.

**And there is no authentication.** The server is 1,425 lines containing no
session, token, role or permission handling of any kind — nine `DELETE`
endpoints, all unauthenticated. The `isAgent` flag that hides some delete
buttons is client-side decoration; the endpoints answer to anyone.

**Why this is recorded.** We deleted a real customer booking once, through a
teardown that used resemblance instead of proof (`docs/QA-DATA-ISOLATION.md`).
The rules that came out of that incident are not theoretical, and this is what
the other approach looks like shipped.

| | |
| --- | --- |
| **Do we have an equivalent?** | No, and we must never. We use soft cancellation with a reason, explicit confirmation, server-side lifecycle rules, RLS on every path, and audit rows for every mutation. |
| **What could improve** | Nothing. **Never adopt one-click destructive cascade deletion.** Mr Clean keeps explicit confirmation, permission checks, auditability, and lifecycle rules that prefer cancellation to erasure. |
| **Priority** | **Reject.** |
| **Dependencies** | None. |
| **Privacy/security** | The entire point. Unauthenticated cascade deletion is the most serious defect in the codebase and on its own disqualifies it as a foundation. |
| **Mobile** | An unconfirmed destructive control beside a navigation control is worse on a touch screen, where mis-taps are routine. |

*Concept only — no source code copied.*

---

### 13. Recurring jobs — a flag, not an engine

**What the user sees.** A recurring toggle, an interval string, and a "Recurring"
box on the job showing that string.

**What is actually there.** Three columns — `is_recurring`,
`recurrence_interval`, `next_recurrence_date` — that are stored and echoed back.
Nothing computes the next date. Nothing generates an occurrence. The feature is
a label.

**Why it is recorded.** It looks finished in a demo, and this is exactly the kind
of thing that gets adopted by looking at screenshots rather than behaviour.

| | |
| --- | --- |
| **Do we have an equivalent?** | No. |
| **What could improve** | Nothing to copy. If recurring bookings are considered later they need a real design: a recurrence rule, generated occurrences with identity, exceptions, edit-this-vs-edit-the-series, staff availability across every generated occurrence, cancellation semantics for one and for all, and audit throughout. Recurrence is a scheduling feature, and ours would have to satisfy the same engine every other booking does — physical availability, working hours, time off, buffers, the large-job forward lock. |
| **Priority** | **Later**, and only with a full design. |
| **Dependencies** | All of the above. |
| **Privacy/security** | A series spanning workspaces would leak the existence of hidden occurrences through gaps in a visible series. Would need deliberate design. |
| **Mobile** | Editing a series on a phone is genuinely hard. Design it last. |

*Concept only — no source code copied.*

---

## Priority summary

| # | Pattern | Priority |
| --- | --- | --- |
| 3 | Inline staff reassignment | **Now** |
| 6 | Activity timeline from existing audit rows | **Now** |
| 11 | Mobile-first as a constraint on every item here | **Now** |
| 1 | Job detail read/act split | **Soon** |
| 8 | Today band above the month overview | **Soon** |
| 9 | Fixed per-staff colour accents | **Soon** |
| 2 | Status shown as a state machine | Later |
| 4 | Checklists (templates per service type) | Later |
| 5 | Materials as consumable cost logging | Later |
| 7 | Customer identity and service history | Later |
| 10 | Invoicing | Later |
| 13 | Recurring bookings | Later (full design required) |
| 5b | Materials as real inventory | **Reject** |
| 12 | One-click destructive cascade deletion | **Reject** |
| 11b | Non-responsive desktop-only layout | **Reject** |

### The strongest five

1. **Staff reassignment on the appointment** (§3) — the clearest capability gap
   we have. Today, changing who is going means cancelling and rebooking.
2. **Activity timeline** (§6) — we already write the audit rows and have never
   shown them. The highest value for the least work in this list.
3. **Today band above the month** (§8) — the month answers "how full are we";
   it does not answer "what am I running today".
4. **Per-staff colour accents** (§9) — makes workload distribution legible
   before any text is read, at almost no cost.
5. **Read/act split on the detail screen** (§1) — stops the panel you opened
   pushing the record you are editing off the screen.

### Explicitly rejected

- **Inventory management** — a different product; their own unused `in_stock`
  column is the evidence.
- **One-click cascade deletion** — and unauthenticated deletion above all.
- **Desktop-only layout** — incompatible with a mobile-first staff requirement.
- **A recurrence flag without a recurrence engine** — finished-looking and
  functionally empty.
- **Global unscoped aggregates** — a dashboard total must be computed from rows
  the caller can actually see.
- **UTC "today"** — wrong by eight hours for the first third of every day here.

---

## ADR: OpenFieldService will not replace mr-clean-ops

**Status:** accepted. **Date:** 2026-09-12.

**Decision.** `mr-clean-ops` remains the production-direction codebase.
OpenFieldService is a reference implementation and UX research input only.

**Reasons.**

1. **mr-clean-ops already holds the more important foundations.** Supabase Auth,
   database-enforced RLS, the KC/Nick/Jack/Dyron/Victor identity model, the
   Shared Team / KC Private Team privacy boundary including "Nick must never
   discover Victor", global physical availability across workspaces, working
   hours, time off, buffers, RM200/hour duration derivation, the RM600 large-job
   forward lock, historical appointment confirmation, the appointment mutation
   RPC engine, the WhatsApp Quick Add parser, the calendar, the customer-facing
   availability message, the dashboard scope model, DEV/TEST QA isolation, and
   the regression suites that hold all of it in place. None of that exists in
   OpenFieldService, and rebuilding it there to obtain better UX pieces would
   trade the hard part for the easy part.
2. **Migrating to D1 would be churn without a benefit.** Our authorization is
   enforced *in the database* by RLS. D1 has no equivalent, so the boundary
   would move into application code — the weakest place to put it.
3. **It has no authentication or authorization.** Not weak ones: none. Nine
   unauthenticated `DELETE` endpoints, and a client-side flag standing in for a
   permission model.
4. **The technician mobile experience is not production-ready** — zero media
   queries, fixed-width sidebars, a seven-column grid at every width.
5. **Our scheduling engine is specific to this business** in ways a generic
   field-service tool is not: the large-job forward lock, workspace-scoped
   visibility over global physical availability, RM/hour duration derivation.
6. **Licensing is partly resolved and we are choosing the stricter path
   anyway.** The repository is MIT; the `@clawnify/*` runtime packages are
   unlicensed. Designing our own implementations avoids attribution obligations
   and upstream coupling entirely.
7. **The valuable parts are patterns, not code.** Everything in the catalogue
   above can be reproduced as independently designed UX, which is what this
   document exists to enable.

**Consequences.** No repository merge, no dependency adoption, no Cloudflare
infrastructure, no change of Supabase direction. The evaluation checkout stays
local and unpublished, holds no real customer data, and is not deployed. Items
marked **Now** and **Soon** enter the normal feature queue as our own designs,
each subject to the existing privacy, audit and mobile-first requirements.
