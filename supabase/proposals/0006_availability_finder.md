# Proposal — `0006_availability_finder.sql`

**Status: design only. Not written, not applied.** This document is for review.

Answers the business question *"give me available times this week / next week"*
without ever disclosing why a time is unavailable.

---

## Why this cannot be done in the browser

The client can only see rows RLS grants it. A staff member shared across
workspaces may be blocked by an appointment the caller cannot see, so a
client-side slot calculation would offer times the server then rejects with
`STAFF_UNAVAILABLE` — a broken experience, and a slow disclosure channel: a
Shared-Team Master could map a private calendar by watching which "available"
slots fail.

Only a `SECURITY DEFINER` function can evaluate hidden conflicts and return a
verdict without the reason.

## Why not expose `assert_appointment_slot_available`

It stays internal (no `EXECUTE` for `anon`/`authenticated`, verified by the
security suite). It is the wrong shape for a public API — it raises *descriptive*
errors, it answers one slot at a time, and it has no authorization of its own
because `create_appointment` authorizes before calling it. Exposing it would
hand callers the exact error strings 0004 was written to suppress.

The new RPC is purpose-built and privacy-safe.

---

## Signature

```sql
create function public.find_available_slots(
  p_staff_ids        uuid[],
  p_from             date,
  p_to               date,
  p_slot_times       time[]  default null,   -- default: suggested_time_slots
  p_total_amount     numeric default null,   -- supply for a real quote
  p_duration_min     integer default null    -- default: business_settings
) returns table (
  staff_id     uuid,
  slot_date    date,
  slot_time    time,
  is_available boolean          -- the ONLY output. No reason, ever.
)
language plpgsql stable security definer set search_path to ''
```

`grant execute ... to authenticated;` — unlike the internal helpers, this one is
designed to be called.

## Defaults

| Input | Default | Source |
| --- | --- | --- |
| slot times | `10:00, 13:00, 15:00` | `suggested_time_slots`, workspace row first then the global row |
| duration | 60 min | `business_settings.default_availability_job_duration_minutes` |
| buffer | 30 min | `business_settings.default_buffer_minutes` |
| amount | `0` | generic enquiry: treated as a normal job |

Amount defaulting to `0` matters. It keeps `is_large_job` false for the
*hypothetical* job, so a generic enquiry is not treated as a large job that
would block everything after it. Existing large jobs still block forward as
normal. When the caller supplies a real `p_total_amount`, the reverse large-job
case is evaluated too.

## Core loop — one source of truth for the rules

```sql
for each staff, date in [p_from, p_to], slot in slot_times loop
  begin
    perform public.assert_appointment_slot_available(
      v_staff, v_date, v_slot, v_duration, v_buffer, v_amount, null, false);
    is_available := true;
  exception when others then
    is_available := false;      -- message deliberately discarded
  end;
  return next;
end loop;
```

Reusing the engine is the whole point: working hours (company default and
staff-specific), full-day and partial time off, physical overlap including
buffer, the RM600 forward lock and the reverse case are all honoured because
they are the same code path `create_appointment` uses. A rule added later is
picked up here for free, and availability can never drift from what booking
actually accepts.

Discarding the exception message is what makes it privacy-safe. Every failure —
hidden cross-workspace appointment, time off, outside hours — collapses to
`is_available = false`.

## Authorization

Checked once, up front, against `my_role()`:

| Caller | May query |
| --- | --- |
| Super Master | staff with an active membership in any workspace they administer |
| Partner Master | staff in their own workspace(s) only — Jack and Dyron in Shared Team |
| Staff | themselves only |
| No profile / anon | nothing — raises |

**Unauthorized staff ids are silently omitted from the result, not rejected.**
Raising "not authorized for staff X" would confirm X exists, which is the
enumeration channel the standing rule about UUID secrecy warns against. The
trade-off — a mistyped id returns nothing rather than an error — is worth it.

The Jack case is the one that matters: Nick *is* authorized to query Jack, and
slots Jack cannot take because of a KC Private Team job simply come back
`is_available = false`. Nick learns the slot is not free. Nothing more.

## Open questions for review

1. **Return shape.** Proposed: every evaluated slot with a boolean, so the UI can
   grey out unavailable times. Equally safe alternative: return only available
   slots. The boolean is better UX and discloses no more, since no reason is
   attached either way — but say if you would rather omit them entirely.
2. **Cost.** One subtransaction per slot: 7 days × 3 slots × 3 staff = 63. Fine
   at this scale. If the range ever widens to a month across many staff, this
   wants a pre-filter that skips days with no working hours before entering the
   loop.
3. **Staff attribution.** The RPC does not take a workspace — availability is a
   physical property of a person, not of a workspace. Workspace only matters at
   booking time. Worth confirming that matches your intent.

## Tests to add before it ships

Extending the existing suites:

- Nick querying Jack, blocked by a hidden KC Private Team job → `is_available = false`,
  and the result carries no time, amount, workspace or reason.
- KC querying the same slot → also `false`, but KC can see the real reason
  through the normal booking path.
- Nick querying Victor's staff id → Victor silently omitted, no error confirming him.
- Staff querying another staff member's id → silently omitted.
- A slot reported available is then actually bookable — availability and booking
  must not disagree.
- A slot reported unavailable is then rejected by `create_appointment`.
- `anon` and a no-profile authenticated caller → denied.
- `assert_appointment_slot_available` remains non-executable by `authenticated`.

The last two round-trip tests are the important ones: they are what prove the
finder and the engine cannot drift apart.
