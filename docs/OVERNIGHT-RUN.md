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
