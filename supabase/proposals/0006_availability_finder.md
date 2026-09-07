# Proposal — `0006_availability_finder.sql`

**Status: IMPLEMENTED.** Superseded by
[`supabase/migrations/0006_availability_finder.sql`](../migrations/0006_availability_finder.sql)
and locked in by `supabase/tests/availability-finder-regression.mjs`.

Kept as the design record. Two things changed between this document and the
shipped migration, both from the V1 design locks: `p_slot_times` was removed
entirely (configured `suggested_time_slots` only), and the return shape is
available rows only with no `is_available` column.

Answers *"show me available times this week / next week"*.

This is a **suggestion surface, not a booking authority.** `create_appointment`
remains the only thing that decides whether a booking is legal. The finder can
be optimistic or stale; the engine cannot.

---

## Why it must live in the database

A staff member shared across workspaces may be blocked by an appointment the
caller cannot see. A client-side calculation would therefore offer times the
engine then rejects — a broken experience, and a disclosure channel: watching
which "available" slots fail would map a private calendar.

`assert_appointment_slot_available` stays internal (no `EXECUTE` for `anon` or
`authenticated`, asserted by the security suite). It raises *descriptive* errors
and has no authorization of its own, because `create_appointment` authorizes
before calling it. Exposing it would hand callers the exact strings 0004 exists
to suppress. This is a separate, purpose-built, privacy-safe RPC.

---

## A. Signature

```sql
create function public.find_available_slots(
  p_staff_ids     uuid[],                   -- who to check
  p_from          date,
  p_to            date,                     -- inclusive; max 14 days (see G)
  p_workspace_id  uuid    default null,     -- operational scope, NOT a busy-time filter
  p_total_amount  numeric default null,     -- optional; duration derived server-side
  p_slot_times    time[]  default null      -- optional; defaults to suggested_time_slots
) returns table (
  staff_id  uuid,
  slot_date date,
  slot_time time
)
language plpgsql
stable
security definer
set search_path to ''
```

```sql
revoke execute on function public.find_available_slots(uuid[],date,date,uuid,numeric,time[]) from public;
grant  execute on function public.find_available_slots(uuid[],date,date,uuid,numeric,time[]) to authenticated;
```

**Available slots only.** No row means not available. There is no `is_available`
column, no reason column, and no unavailable rows — a caller cannot tell a
hidden conflict from time off from outside-hours, because the shapes are
identical: absence.

## B. Authorization flow

Evaluated once, before any slot work:

```
v_role := public.my_role();
if v_role is null then raise exception 'Not authorized'; end if;

if v_role = 'staff' then
    v_allowed := array[public.my_staff_id()]        -- own availability only
elsif v_role in ('super_master','partner_master') then
    v_allowed := (staff with an ACTIVE membership in a workspace the caller
                  administers, i.e. sw.workspace_id in (select * from my_workspace_ids());
                  further narrowed to p_workspace_id when supplied and visible)
else
    raise exception 'Not authorized';
end if;

v_targets := p_staff_ids ∩ v_allowed;      -- silent intersection
```

| Caller | May query |
| --- | --- |
| KC (super_master) | Jack, Dyron, Victor — narrowed by the selected KC-visible scope |
| Nick (partner_master) | Jack, Dyron only |
| Staff | themselves only |
| No profile / anon | nothing — raises |

**Unauthorized ids are dropped silently, never rejected.** Raising "not
authorized for staff X" would confirm X exists. Nick passing Victor's id gets
the same response as Nick passing a random UUID: no rows for it. A caller cannot
distinguish *exists but not yours*, *does not exist*, and *no availability*.

An empty `v_targets` returns zero rows rather than raising, for the same reason.

## C. Candidate-slot generation

Candidates are the cross product of `v_targets` × dates in `[p_from, p_to]` ×
slot times. Slot times resolve in order:

1. `p_slot_times` if supplied — **validated against the configured set**, not
   accepted freely (see I).
2. `suggested_time_slots` for `p_workspace_id`, if a workspace row exists.
3. The global `suggested_time_slots` rows: **10:00, 13:00, 15:00**.

This is deliberately *not* a minute-by-minute prober. Add Appointment may still
submit any arbitrary time — the engine validates it on save. The finder answers
"which of our standard visit times are open", which is the actual business
question and is a far smaller surface to probe.

## D. Duration and buffer

Never trusted from the browser.

| Case | Duration |
| --- | --- |
| `p_total_amount` is null | `business_settings.default_availability_job_duration_minutes` (60) |
| `p_total_amount` supplied | derived server-side by the same rule `create_appointment` uses: `greatest(1, ceil(amount / rm_per_hour_rate * 60))` |

Buffer is always `business_settings.default_buffer_minutes` (30). There is no
duration parameter at all, so there is nothing to spoof.

`p_total_amount` defaults to `0` for the hypothetical job when not supplied. That
keeps `is_large_job` false for the *candidate*, so a generic enquiry is not
treated as a large job that would blanket the rest of the day. Existing large
jobs still block forward normally. When a real amount is supplied, the reverse
large-job case is evaluated too — so a RM800 enquiry correctly shows fewer slots
than a RM200 one.

## E. Hidden-conflict behaviour

Availability is computed **globally for the person**. `p_workspace_id` scopes
*which staff the caller may ask about* — it never filters busy time.

A slot blocked by an appointment in a workspace the caller cannot see is simply
**omitted**. No row, no reason, no distinguishing mark. This is the same rule as
0004's `STAFF_UNAVAILABLE`, expressed as absence instead of a message.

## F. Return schema

```
staff_id   uuid
slot_date  date
slot_time  time
```

Never returned: blocking appointment id, conflict type, customer, amount,
workspace of a hidden conflict, hidden start/end time, large-job classification,
override reason, or any count of what was excluded.

Note that even a *count* of unavailable slots would be a channel, which is why
the function returns available rows only rather than a filtered-with-totals shape.

## G. Range and cost limits

```
if p_to < p_from then raise exception 'Invalid range'; end if;
if p_to - p_from > 13 then raise exception 'Range too large'; end if;   -- 14 days inclusive
```

A hard 14-day horizon. It covers "this week / next week" exactly and stops the
function being used as a bulk schedule-probing endpoint.

Worst case at V1 scale:

| Staff | Days | Slots/day | Checks |
| --- | --- | --- | --- |
| 2 | 14 | 3 | **84** |
| 3 | 14 | 3 | 126 |

Fine for V1. No route optimisation, no travel-time modelling, no map distance —
explicitly out of scope.

## H. Exception handling

**Not `when others`.** That would convert a genuine database fault — a missing
table, a permissions error, a broken migration — into a confident "no
availability", which is the worst possible failure mode for a scheduling tool.

The validator raises business-rule violations with `SQLSTATE P0001`
(`raise exception` without an explicit errcode, i.e. `raise_exception`). Only
that class is caught:

```sql
begin
  perform public.assert_appointment_slot_available(
    v_staff, v_date, v_slot, v_duration, v_buffer, v_amount, null, false);
  return next;                       -- available
exception
  when raise_exception then          -- P0001: a business rule said no
    null;                            -- omit the candidate, keep going
end;
```

Everything else — `undefined_table`, `insufficient_privilege`, `internal_error`
— propagates as a real error and the whole call fails loudly.

Reusing the validator is the point: working hours (company and staff-specific),
full-day and partial time off, physical overlap including buffer, the RM600
forward lock and the reverse case are all honoured because it is the same code
path booking uses. A rule added later is picked up for free.

**One caveat to accept explicitly:** this couples the finder to the validator's
exception *class*. If a future change starts raising business-rule violations
with a different SQLSTATE, they would propagate as errors instead of being
treated as "unavailable" — loud, not silent, which is the right direction to
fail. A test asserting each known rejection reason yields "omitted, no error"
guards this.

## I. Privacy side-channel analysis

| Channel | Mitigation |
| --- | --- |
| Reason disclosure | Only available rows are returned. Absence is uniform. |
| Existence of a hidden staff member | Unauthorized ids dropped silently; identical response to a random UUID. |
| Existence of a hidden workspace | `p_workspace_id` is validated against the caller's visible set; an unknown value narrows to nothing rather than erroring. |
| Timing | The validator runs for authorized targets only. Unauthorized ids are removed *before* the loop, so a caller cannot time-probe for existence. |
| Counting | No totals, no "n slots excluded". |
| Amount-band inference | A caller can vary `p_total_amount` and watch the result set shrink. This reveals something about **their own** hypothetical job's fit, not about the hidden job — the forward lock blocks the rest of the day regardless of the candidate's size, so the boundary observed is the caller's own duration, not the blocker's value. Worth re-checking during implementation. |
| Slot-time probing | `p_slot_times` is validated against the configured set rather than accepted freely — otherwise a caller could binary-search a hidden appointment's exact boundaries at minute resolution. **This is the one place the design deliberately refuses caller input**, and it is the reason the parameter is a filter over configured slots, not free times. |
| Error-message leakage | The finder raises only `Not authorized`, `Invalid range` and `Range too large`. It never surfaces the validator's text. |

## Tests to add before it ships

- Nick querying Jack, blocked by a hidden KC Private Team job → that slot absent;
  response identical in shape to a slot free for other reasons.
- KC querying the same → also absent, but KC still gets the real reason through
  the normal booking path.
- Nick querying Victor's id → dropped silently, no error, no rows.
- Nick querying a random UUID → **byte-identical response** to the Victor case.
- Staff querying another staff member's id → dropped silently.
- Round-trip both ways: a returned slot is actually bookable; a slot the engine
  rejects is never returned. These two are what prove finder and engine cannot
  drift apart.
- `p_slot_times` with an unconfigured time → rejected or ignored, never probed.
- Range of 15 days → raises.
- A forced database fault mid-loop → propagates, does **not** return "no availability".
- `anon` and no-profile authenticated → denied.
- `assert_appointment_slot_available` still not executable by `authenticated`.
