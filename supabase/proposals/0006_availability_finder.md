# Availability finder — design record

**Status: IMPLEMENTED, then AMENDED.**

- [`0006_availability_finder.sql`](../migrations/0006_availability_finder.sql) — original.
- [`0007_availability_privacy_and_past_guard.sql`](../migrations/0007_availability_privacy_and_past_guard.sql) — **removed `p_total_amount` after a confirmed side channel.** 0007 is the current behaviour.

Locked in by `supabase/tests/availability-finder-regression.mjs` and
`supabase/tests/past-guard-and-config-regression.mjs`.

---

## The amount side channel — measured, not theorised

The 0006 design shipped with `p_total_amount`, which drove the server-derived
duration. This section of the original proposal read:

> *Amount-band inference — a caller can vary `p_total_amount` and watch the
> result set shrink. This reveals something about their own hypothetical job's
> fit, not about the hidden job … Worth re-checking during implementation.*

**That reasoning was wrong, and the re-check found it.** Amount changed the
candidate's duration, which changed its occupied range, which changed whether it
overlapped a **hidden** cross-workspace appointment. The boundary observed was
the *blocker's*, not the caller's.

Measured on DEV as TEST_NICK with a real JWT, against a hidden KC Private Team
job at 12:00 (RM200, 60 min, deliberately **non-large** so the RM600 forward lock
could not contaminate the result), probing the 10:00 candidate:

| `p_total_amount` | Duration | Candidate ends | Result |
| --- | --- | --- | --- |
| NULL / 200 | 60 min | 11:30 | AVAILABLE |
| 250 | 75 min | 11:45 | AVAILABLE |
| **300** | **90 min** | **12:00** | **AVAILABLE** |
| **301** | **91 min** | **12:01** | **OMITTED** |
| 350+ | 105+ min | 12:15+ | OMITTED |

Nine calls binary-searched the hidden appointment's start time **to the exact
minute**. A control date with no hidden appointment stayed AVAILABLE across the
same sweep, so the transition was attributable to the hidden job alone.

Candidate end = `slot + duration + buffer`, every term of which the caller knows.
The last amount that stays available therefore pins the blocker's start exactly.
Hiding the appointment id, the reason and the conflict type did not help: the
**boundary** leaked through a caller-controlled probe window.

A frontend restriction would not have been a fix — the RPC is directly callable
by any authenticated client.

## Current behaviour (0007)

```sql
find_available_slots(
  p_staff_ids     uuid[],
  p_from          date,
  p_to            date,
  p_workspace_id  uuid default null
) returns table (staff_id uuid, slot_date date, slot_time time)
```

A **standard-job recommendation surface**. There is no public amount, duration,
buffer or slot-time input, so nothing a caller controls can vary the probe
window. Duration is always
`business_settings.default_availability_job_duration_minutes`; buffer is always
`default_buffer_minutes`.

Everything else from the original design is unchanged and still holds:

- **Available rows only.** No reason, no unavailable rows, no counts. A slot
  blocked by a hidden appointment is simply absent, indistinguishable from one
  blocked by time off or working hours.
- **Availability is global.** `p_workspace_id` scopes *which staff* the caller
  may ask about; it never filters busy time. Verified: a hidden 12:00 job still
  removes the 13:00 candidate for a Shared-only Master.
- **Unauthorized ids dropped silently**, so the RPC cannot confirm a staff
  member or a workspace exists.
- **Rules reused** from `assert_appointment_slot_available`, catching only its
  business-rule class (P0001) so real database faults propagate rather than
  being reported as "no availability".
- **Hard 14-day horizon**, forward-looking only, Asia/Kuala_Lumpur.
- Not marked `STABLE`, because the validator it calls is `VOLATILE`.

`create_appointment` remains authoritative for the real items, value and
duration.

## Locked F2 consequence

The earlier F2 design said availability re-runs when the item total changes.
**That is no longer permitted** and has been removed.

Availability suggestions:

- use standard-job availability only,
- **do not vary when the item total changes**,
- come from the configured suggested slots,
- are a recommendation, never a reservation.

Job items may still update the subtotal and a **display-only** estimated
duration, which the UI derives from `get_booking_config()`.

This is therefore expected and accepted:

```
13:00 appears in standard-job suggestions
  → user enters a very large job
  → Save
  → Appointment Engine rejects 13:00
```

The UI must say: **"Available when checked — final availability is confirmed
when saving."** The trade-off is intentional: a suggestion that always matched
the final answer would have to leak the schedule to compute it.

## Booking configuration

`business_settings` is not readable by staff (verified: kc=1, nick=1, jack=0,
victor=0 rows), so the form could not render an estimate for them. Rather than
widening table RLS, 0007 adds:

```sql
get_booking_config()
  returns table (rm_per_hour_rate, default_buffer_minutes,
                 default_availability_job_duration_minutes)
```

Excluded on purpose: `full_day_lock_threshold` (the UI must not pre-judge whether
an override is needed — the server decides from real conflicts),
`default_day_start`/`default_day_end` (staff-specific hours override them, so
company defaults would mislead; the server returns the real window in
`OUTSIDE_WORKING_HOURS`), and the completion flag and WhatsApp templates, which
are unrelated to booking.

## Lesson worth keeping

The original analysis listed this exact channel and talked itself out of it. The
table row that said "worth re-checking" was right; the paragraph next to it was
not. **Where a side channel is cheap to measure, measure it** — the experiment
took one fixture and nine requests, and produced an unambiguous answer that no
amount of reasoning had.
