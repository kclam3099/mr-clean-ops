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

## Phase O3 — operational dashboard polish

**Status:** started.

---
