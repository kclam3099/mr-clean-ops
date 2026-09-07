-- 0008_working_hours_timestamp_bounds.sql
--
-- Fixes a confirmed scheduling defect: working-hours validation compared
-- time-of-day values, and `time + interval` wraps modulo 24 hours in
-- PostgreSQL.
--
--     select '23:05'::time + make_interval(mins => 60);   -->  00:05:00
--     select '00:05'::time > '19:00'::time;               -->  false
--
-- So an appointment whose duration crossed midnight passed the upper bound and
-- was accepted outside working hours. Reproduced on DEV through the normal
-- create_appointment RPC: a 23:05 booking was created against a 09:00-19:00
-- window. Its occupied_range, which is built from timestamps, correctly spanned
-- 23:05 to 00:35 the next day — so the row also blocked the following morning
-- while having escaped the check that should have refused it.
--
-- Present since 0001. Two application functions carry the pattern; a full audit
-- of all 21 application functions (extension-owned objects excluded) found no
-- others.
--
--     assert_appointment_slot_available   the booking-time check, shared by
--                                         create_appointment,
--                                         reschedule_appointment,
--                                         update_appointment_items and
--                                         find_available_slots
--     set_staff_working_hours             the future-appointment revalidation
--                                         when a staff-specific window changes
--
-- Both bodies below are the DEPLOYED definitions read from pg_get_functiondef,
-- with only the affected expression replaced. Nothing else changed.
--
-- SEMANTIC NOTE, called out because it is more than arithmetic: the working
-- hours comparison now includes the BUFFER as well as the duration, matching
-- occupied_range and the availability finder. Previously only the duration was
-- measured against the closing time, so a job could end on time while its
-- buffer ran past closing. The inclusive boundary is preserved — a candidate
-- ending exactly at the closing time is still valid, one minute later is not.
--
-- Narrow by design. Does not modify 0001-0007, and does not touch the RM600
-- rules, overrides, privacy, workspace membership, the working-hours storage
-- model, time off, occupied_range, the availability signature, the past-date
-- guard or the booking config RPC. No overnight shifts are introduced: the V1
-- same-day working-window model is unchanged.

CREATE OR REPLACE FUNCTION public.assert_appointment_slot_available(p_staff_id uuid, p_appt_date date, p_start_time time without time zone, p_final_duration_min integer, p_buffer_minutes integer, p_total_amount numeric, p_exclude_appointment_id uuid DEFAULT NULL::uuid, p_override_large_job boolean DEFAULT false)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_staff public.staff%rowtype;
  v_dow smallint;
  v_day_start time;
  v_day_end time;
  v_threshold numeric(10,2);
  v_candidate_start timestamp;
  v_candidate_end timestamp;
  v_day_end_ts timestamp;
  v_this_is_large boolean;
  v_conflicts uuid[] := '{}';
  v_appt record;
  v_appt_start timestamp;
  v_appt_end timestamp;
  v_visible boolean;
begin
  select * into v_staff from public.staff where id = p_staff_id;
  if not found or not v_staff.is_active then
    raise exception 'Staff is not active';
  end if;

  if exists (
    select 1 from public.staff_time_off
    where staff_id = p_staff_id and off_date = p_appt_date
      and start_time is null and end_time is null
  ) then
    raise exception 'Staff is unavailable on this date (full day off)';
  end if;

  v_dow := extract(dow from p_appt_date)::smallint;
  select start_time, end_time into v_day_start, v_day_end
    from public.staff_working_hours
    where staff_id = p_staff_id and day_of_week = v_dow;
  if not found then
    select start_time, end_time into v_day_start, v_day_end
      from public.staff_working_hours
      where staff_id is null and day_of_week = v_dow;
  end if;
  if v_day_start is null then
    select default_day_start, default_day_end into v_day_start, v_day_end
      from public.business_settings;
  end if;

  -- 0008: build the candidate window FIRST, then compare timestamps.
  v_candidate_start := (p_appt_date + p_start_time);
  v_candidate_end   := v_candidate_start + make_interval(mins => p_final_duration_min + p_buffer_minutes);
  v_day_end_ts      := (p_appt_date + v_day_end);

  -- The previous form compared time-of-day values:
  --     (p_start_time + make_interval(mins => p_final_duration_min)) > v_day_end
  -- `time + interval` wraps modulo 24 hours in PostgreSQL, so
  -- '23:05' + 60min yields '00:05', and '00:05' > '19:00' is FALSE. A job that
  -- ran past midnight therefore escaped the upper bound entirely, while its
  -- occupied_range (built from timestamps) correctly spanned into the next day.
  --
  -- Comparing the timestamps that already exist here cannot wrap.
  --
  -- The candidate window now also includes the buffer, matching occupied_range
  -- and the availability finder. The boundary stays inclusive: ending exactly
  -- at v_day_end is allowed; one minute later is not.
  if v_candidate_start < (p_appt_date + v_day_start)
     or v_candidate_end > v_day_end_ts
  then
    raise exception 'Outside working hours (% to %)', v_day_start, v_day_end;
  end if;

  if exists (
    select 1 from public.staff_time_off
    where staff_id = p_staff_id and off_date = p_appt_date
      and start_time is not null
      and tsrange(
            (p_appt_date + start_time),
            (p_appt_date + end_time),
            '[)'
          ) && tsrange(v_candidate_start, v_candidate_end, '[)')
  ) then
    raise exception 'Staff is unavailable during this time (time off)';
  end if;

  select full_day_lock_threshold into v_threshold from public.business_settings;
  v_this_is_large := p_total_amount >= v_threshold;

  for v_appt in
    select * from public.appointments
    where staff_id = p_staff_id
      and status <> 'cancelled'
      and appt_date = p_appt_date
      and (p_exclude_appointment_id is null or id <> p_exclude_appointment_id)
  loop
    v_appt_start := (v_appt.appt_date + v_appt.start_time);
    v_appt_end   := v_appt_start + make_interval(mins => v_appt.final_duration_min + v_appt.buffer_minutes);

    -- K4: may this caller be told anything about THIS conflicting row?
    v_visible := public.can_view_conflict(v_appt.workspace_id, v_appt.staff_id);

    -- direct overlap: NEVER bypassable, by any override, under any
    -- circumstance — the GiST exclusion constraint enforces the same
    -- thing at the hard layer regardless of this check.
    if tsrange(v_appt_start, v_appt_end, '[)') && tsrange(v_candidate_start, v_candidate_end, '[)') then
      if v_visible then
        raise exception 'PHYSICAL_OVERLAP: conflicts with an existing appointment at %', v_appt.start_time;
      else
        raise exception 'STAFF_UNAVAILABLE';
      end if;
    end if;

    -- forward case — always re-evaluated fresh, never skipped because of
    -- anything recorded against v_appt previously
    if v_appt.is_large_job
       and v_candidate_start >= v_appt_start and v_candidate_start < v_day_end_ts
    then
      -- hidden conflict: generic, and NOT overridable (checked before the
      -- override branch on purpose)
      if not v_visible then
        raise exception 'STAFF_UNAVAILABLE';
      end if;
      if not p_override_large_job then
        raise exception 'LARGE_JOB_OVERRIDE_REQUIRED: blocked by a large-job lock starting %', v_appt.start_time;
      end if;
      v_conflicts := array_append(v_conflicts, v_appt.id);
    end if;

    -- reverse case
    if v_this_is_large and v_appt_start >= v_candidate_start and v_appt_start < v_day_end_ts then
      if not v_visible then
        raise exception 'STAFF_UNAVAILABLE';
      end if;
      if not p_override_large_job then
        raise exception 'LARGE_JOB_OVERRIDE_REQUIRED: this large job would block an existing appointment at %', v_appt.start_time;
      end if;
      v_conflicts := array_append(v_conflicts, v_appt.id);
    end if;
  end loop;

  return v_conflicts;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_staff_working_hours(p_staff_id uuid, p_day_of_week smallint, p_start_time time without time zone, p_end_time time without time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role public.user_role := public.my_role();
  v_conflict_id uuid;
  v_conflict_visible boolean;
begin
  if auth.uid() is null or v_role is null then
    raise exception 'Not authorized';
  end if;

  if p_start_time >= p_end_time then
    raise exception 'start_time must be before end_time';
  end if;

  if p_staff_id is null then
    if v_role is distinct from 'super_master'::public.user_role then
      raise exception 'Only Super Master may set the company default working hours';
    end if;
  else
    if v_role is null
       or (v_role is distinct from 'super_master'::public.user_role
           and v_role is distinct from 'partner_master'::public.user_role) then
      raise exception 'Only a Master may set staff working hours';
    end if;
    if not exists (
      select 1 from public.staff_workspaces
      where staff_id = p_staff_id and is_active
        and workspace_id in (select * from public.my_workspace_ids())
    ) then
      raise exception 'Not authorized for this staff member';
    end if;

    perform pg_advisory_xact_lock(hashtext(p_staff_id::text));

    select a.id, public.can_view_conflict(a.workspace_id, a.staff_id)
      into v_conflict_id, v_conflict_visible
      from public.appointments a
      where a.staff_id = p_staff_id
        and a.status = 'booked'
        and extract(dow from a.appt_date)::smallint = p_day_of_week
        and (a.appt_date + a.start_time) > (now() at time zone 'Asia/Kuala_Lumpur')
        -- 0008: same wrap, same fix. Anchor both the existing appointment and
        -- the proposed window on that appointment's own date, and include the
        -- buffer, so an appointment running past midnight can no longer look
        -- like it fits inside a same-day window.
        and ((a.appt_date + a.start_time) < (a.appt_date + p_start_time)
             or (a.appt_date + a.start_time)
                  + make_interval(mins => a.final_duration_min + a.buffer_minutes)
                > (a.appt_date + p_end_time))
      limit 1;

    if v_conflict_id is not null then
      if v_conflict_visible then
        raise exception 'An existing booked appointment falls outside the new hours — reschedule it first';
      else
        raise exception 'STAFF_UNAVAILABLE';
      end if;
    end if;
  end if;

  delete from public.staff_working_hours
  where day_of_week = p_day_of_week
    and staff_id is not distinct from p_staff_id;

  insert into public.staff_working_hours (staff_id, day_of_week, start_time, end_time)
  values (p_staff_id, p_day_of_week, p_start_time, p_end_time);
end;
$function$;
