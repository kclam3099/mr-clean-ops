-- 0006_availability_finder.sql
--
-- Answers "show me available times this week / next week".
--
-- SNAPSHOT, NOT A RESERVATION. This function is read-only recommendation logic.
-- It takes NO advisory lock: availability can change the instant after it
-- returns, so holding a lock across the scan would buy nothing and would block
-- real bookings. create_appointment / reschedule_appointment /
-- update_appointment_items remain the sole authority and keep their advisory
-- lock, latest-state validation and the GiST exclusion constraint. The UI must
-- present these results as "available when checked", never as reserved.
--
-- PRIVACY. Availability is computed GLOBALLY for a person: an appointment in a
-- workspace the caller cannot see still blocks the slot. A blocked candidate is
-- simply ABSENT from the result — there is no reason column, no unavailable
-- rows and no counts, so a hidden cross-workspace conflict is indistinguishable
-- from time off or from outside working hours. p_workspace_id scopes WHICH
-- STAFF the caller may ask about; it never filters busy time.
--
-- RULE REUSE. The candidate check delegates to
-- assert_appointment_slot_available, so working hours (company and
-- staff-specific), full-day and partial time off, physical overlap including
-- buffer, the RM600 forward lock and its reverse case are all honoured by the
-- same code path booking uses. A rule added later is picked up here for free.
-- That validator stays internal-only; it is NOT exposed by this migration.
--
-- VOLATILITY. Deliberately not marked STABLE: assert_appointment_slot_available
-- is VOLATILE (verified in pg_proc), and a STABLE wrapper around a VOLATILE
-- callee would be a false promise to the planner. The function performs no
-- writes regardless.
--
-- Does not modify 0001-0005. Does not change scheduling semantics.

create or replace function public.find_available_slots(
  p_staff_ids     uuid[],
  p_from          date,
  p_to            date,
  p_workspace_id  uuid    default null,
  p_total_amount  numeric default null
)
returns table (
  staff_id  uuid,
  slot_date date,
  slot_time time without time zone
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role              public.user_role := public.my_role();
  v_my_staff          uuid;
  v_now               timestamp := (now() at time zone 'Asia/Kuala_Lumpur');
  v_today             date      := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_config_ws         uuid;
  v_targets           uuid[];
  v_slots             time without time zone[];
  v_rate              numeric(10,2);
  v_buffer            integer;
  v_default_duration  integer;
  v_amount            numeric(10,2);
  v_duration          integer;
  v_membership_count  integer;
  v_staff             uuid;
  v_date              date;
  v_slot              time without time zone;
begin
  -- --------------------------------------------------------------------
  -- 1. Authorization — fail closed
  -- --------------------------------------------------------------------
  if auth.uid() is null or v_role is null then
    raise exception 'Not authorized';
  end if;

  -- --------------------------------------------------------------------
  -- 2. Range — Asia/Kuala_Lumpur calendar dates, forward-looking only
  -- --------------------------------------------------------------------
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Invalid range';
  end if;
  if p_from < v_today then
    -- Not a historical schedule-probing API.
    raise exception 'Invalid range';
  end if;
  if (p_to - p_from) > 13 then
    raise exception 'Range too large';
  end if;

  -- --------------------------------------------------------------------
  -- 3. Authorized targets, and the workspace whose slot config applies
  -- --------------------------------------------------------------------
  if v_role = 'staff' then
    v_my_staff := public.my_staff_id();
    if v_my_staff is null then
      return;                                     -- no staff row: fail safe
    end if;

    select count(*) into v_membership_count
      from public.staff_workspaces sw
     where sw.staff_id = v_my_staff and sw.is_active;

    if v_membership_count = 0 then
      return;                                     -- no memberships: fail safe
    elsif p_workspace_id is not null then
      if not exists (
        select 1 from public.staff_workspaces sw
         where sw.staff_id = v_my_staff
           and sw.workspace_id = p_workspace_id
           and sw.is_active
      ) then
        raise exception 'Not an active member of this workspace';
      end if;
      v_config_ws := p_workspace_id;
    elsif v_membership_count = 1 then
      select sw.workspace_id into v_config_ws     -- exactly one: derive it
        from public.staff_workspaces sw
       where sw.staff_id = v_my_staff and sw.is_active
       limit 1;
    else
      -- Several memberships: the caller must say which one, for attribution
      -- and slot configuration. Mirrors create_appointment's message.
      raise exception 'Multiple active workspace memberships — workspace_id is required';
    end if;

    -- Staff may only ever ask about themselves. Any other id is dropped
    -- silently, so this cannot confirm that another staff member exists.
    if p_staff_ids is null then
      v_targets := array[v_my_staff];
    else
      select array_agg(distinct t.id) into v_targets
        from unnest(p_staff_ids) as t(id)
       where t.id = v_my_staff;
    end if;

    -- An inactive staff member has no availability.
    if not exists (select 1 from public.staff s where s.id = v_my_staff and s.is_active) then
      return;
    end if;

  elsif v_role in ('super_master', 'partner_master') then
    if p_workspace_id is not null then
      if p_workspace_id in (select * from public.my_workspace_ids()) then
        v_config_ws := p_workspace_id;
      else
        -- Not a workspace this Master administers. Return nothing rather than
        -- raising: an error would confirm the workspace exists.
        return;
      end if;
    end if;

    -- Allowed = active staff with an active membership in a workspace this
    -- Master administers, narrowed to p_workspace_id when supplied.
    -- DISTINCT deduplicates a staff member visible through several workspaces.
    -- Unauthorized or unknown ids in p_staff_ids simply fail to match.
    select array_agg(distinct sw.staff_id) into v_targets
      from public.staff_workspaces sw
      join public.staff s on s.id = sw.staff_id
     where sw.is_active
       and s.is_active
       and sw.workspace_id in (select * from public.my_workspace_ids())
       and (v_config_ws is null or sw.workspace_id = v_config_ws)
       and (p_staff_ids is null or sw.staff_id = any (p_staff_ids));

  else
    raise exception 'Not authorized';
  end if;

  if v_targets is null or cardinality(v_targets) = 0 then
    return;
  end if;

  -- --------------------------------------------------------------------
  -- 4. Candidate times — configured suggested slots only
  -- --------------------------------------------------------------------
  -- There is deliberately no caller-supplied slot parameter. Free times would
  -- let a caller binary-search a hidden appointment's exact boundaries at
  -- minute resolution. Add Appointment may still submit any time; the engine
  -- validates it on save.
  --
  -- Precedence: active workspace-specific rows, else active global rows.
  if v_config_ws is not null then
    select array_agg(t.slot_time order by t.sort_order, t.slot_time)
      into v_slots
      from (
        select distinct on (s.slot_time) s.slot_time, s.sort_order
          from public.suggested_time_slots s
         where s.is_active and s.workspace_id = v_config_ws
         order by s.slot_time, s.sort_order
      ) t;
  end if;

  if v_slots is null or cardinality(v_slots) = 0 then
    select array_agg(t.slot_time order by t.sort_order, t.slot_time)
      into v_slots
      from (
        select distinct on (s.slot_time) s.slot_time, s.sort_order
          from public.suggested_time_slots s
         where s.is_active and s.workspace_id is null
         order by s.slot_time, s.sort_order
      ) t;
  end if;

  if v_slots is null or cardinality(v_slots) = 0 then
    return;                                       -- nothing configured
  end if;

  -- --------------------------------------------------------------------
  -- 5. Duration and buffer — server-derived, never caller-supplied
  -- --------------------------------------------------------------------
  select bs.rm_per_hour_rate, bs.default_buffer_minutes,
         bs.default_availability_job_duration_minutes
    into strict v_rate, v_buffer, v_default_duration
    from public.business_settings bs;

  if p_total_amount is null or p_total_amount = 0 then
    -- Generic enquiry. Amount 0 keeps the CANDIDATE from being classified as a
    -- large job (which would make it block the rest of the day for itself);
    -- existing large jobs still block it forward as normal.
    v_amount   := 0;
    v_duration := greatest(1, coalesce(v_default_duration, 60));
  else
    if p_total_amount < 0 then
      raise exception 'Invalid amount';
    end if;
    -- Same formula and rate as create_appointment. No override is supported.
    v_amount   := p_total_amount;
    v_duration := greatest(1, ceil(v_amount / v_rate * 60)::int);
  end if;

  -- --------------------------------------------------------------------
  -- 6. Evaluate candidates
  -- --------------------------------------------------------------------
  foreach v_staff in array v_targets loop
    v_date := p_from;
    while v_date <= p_to loop
      foreach v_slot in array v_slots loop

        -- Never suggest a time that has already passed today.
        if (v_date + v_slot) > v_now then
          begin
            -- p_override_large_job = false, so a slot that would need a Master
            -- override raises and is omitted. Availability stays conservative:
            -- an authorized Master can still force the booking through
            -- create_appointment and receive LARGE_JOB_OVERRIDE_REQUIRED there.
            perform public.assert_appointment_slot_available(
              v_staff, v_date, v_slot, v_duration, v_buffer, v_amount, null, false);

            staff_id  := v_staff;
            slot_date := v_date;
            slot_time := v_slot;
            return next;

          exception
            -- ONLY the validator's business-rule class (P0001). Everything else
            -- — undefined_table, insufficient_privilege, internal errors —
            -- propagates. A database fault must never be reported to the user
            -- as "no availability".
            when raise_exception then
              null;
          end;
        end if;

      end loop;
      v_date := v_date + 1;
    end loop;
  end loop;

  return;
end;
$function$;

-- --------------------------------------------------------------------------
-- Privileges
-- --------------------------------------------------------------------------
-- 0002 altered default privileges so functions created by postgres grant
-- EXECUTE to nobody. These statements make the final state explicit rather
-- than relying on that default, and are verified empirically after apply.
revoke execute on function public.find_available_slots(uuid[], date, date, uuid, numeric) from public;
revoke execute on function public.find_available_slots(uuid[], date, date, uuid, numeric) from anon;
grant  execute on function public.find_available_slots(uuid[], date, date, uuid, numeric) to authenticated;
