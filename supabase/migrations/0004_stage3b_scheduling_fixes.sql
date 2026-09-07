-- 0004_stage3b_scheduling_fixes.sql
--
-- Fixes the three defects found in Stage 3B QA. 0001/0002/0003 are
-- immutable and already applied; nothing here modifies them.
--
--   K4  PRIVACY  — the Appointment Engine's conflict errors disclosed a
--                  hidden appointment's start time and its "large job"
--                  (>= RM600) classification to a caller who cannot see
--                  that appointment or its workspace. Confirmed: Nick,
--                  booking Jack in Shared Team while Jack had a private
--                  KC Private Team RM800 job at 10:00, received
--                  "Blocked by a large-job lock starting 10:00:00".
--   BUG-1        — create_appointment used min(workspace_id) on a uuid
--                  column; PostgreSQL has no min(uuid) aggregate, so ALL
--                  staff self-booking via workspace auto-derivation
--                  failed with "function min(uuid) does not exist".
--   BUG-2        — set_staff_working_hours rejected a recurring-hours
--                  change based on booked appointments on ANY date with
--                  that weekday, including past ones, permanently
--                  blocking schedule changes.
--
-- Function bodies below are reproduced from pg_get_functiondef() of the
-- deployed functions; only the marked sections change.

-- =========================================================================
-- PART 1 — CONFLICT VISIBILITY RULE (single source of truth)
--
-- A conflicting appointment's details may be disclosed to the caller only
-- if the caller is independently entitled to see that appointment:
--   * a Master who administers the CONFLICTING appointment's workspace
--     (not merely the workspace being booked into), or
--   * the staff member the conflicting appointment is assigned to.
--
-- This deliberately keys on the conflicting row's own workspace. Nick
-- administering Shared Team does NOT entitle him to detail about a
-- KC Private Team appointment, even when the booking he is attempting is
-- in Shared Team. KC, who administers both workspaces, is entitled.
--
-- Internal only: revoked from PUBLIC and never granted to authenticated,
-- like assert_appointment_slot_available. It is reached solely from
-- inside SECURITY DEFINER engine functions, which run as their owner.
-- =========================================================================

create or replace function public.can_view_conflict(p_conflict_workspace_id uuid, p_conflict_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    p_conflict_workspace_id in (select * from public.my_workspace_ids())
    or (p_conflict_staff_id is not null and p_conflict_staff_id = public.my_staff_id()),
    false
  )
$function$;

revoke execute on function public.can_view_conflict(uuid, uuid) from public;

-- =========================================================================
-- PART 2 — K4: hidden conflicts leak nothing, and are never overridable
--
-- Client-facing error vocabulary:
--   STAFF_UNAVAILABLE            - conflict the caller may not see. No
--                                  category, no time, no amount, no
--                                  workspace, no override path.
--   PHYSICAL_OVERLAP             - visible direct overlap. Never
--                                  overridable by anyone, as before.
--   LARGE_JOB_OVERRIDE_REQUIRED  - visible large-job conflict; an
--                                  authorized Master may override.
--
-- The hidden-conflict branch is checked BEFORE the override branch, so
-- supplying p_override_large_job cannot be used to probe or bypass a
-- conflict the caller cannot see (Stage 3B §2).
-- =========================================================================

create or replace function public.assert_appointment_slot_available(p_staff_id uuid, p_appt_date date, p_start_time time without time zone, p_final_duration_min integer, p_buffer_minutes integer, p_total_amount numeric, p_exclude_appointment_id uuid DEFAULT NULL::uuid, p_override_large_job boolean DEFAULT false)
returns uuid[]
language plpgsql
security definer
set search_path to ''
as $function$
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

  if p_start_time < v_day_start
     or (p_start_time + make_interval(mins => p_final_duration_min)) > v_day_end
  then
    raise exception 'Outside working hours (% to %)', v_day_start, v_day_end;
  end if;

  v_candidate_start := (p_appt_date + p_start_time);
  v_candidate_end   := v_candidate_start + make_interval(mins => p_final_duration_min + p_buffer_minutes);
  v_day_end_ts      := (p_appt_date + v_day_end);

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

-- =========================================================================
-- PART 3 — BUG-1: UUID-safe workspace auto-derivation
--
-- min(uuid) does not exist in PostgreSQL. Replaced with an explicit
-- count, then a separate single-row select, which is UUID-safe and
-- deterministic. Behaviour per spec: exactly one active membership
-- auto-derives; more than one requires an explicit, validated choice;
-- zero rejects. p_staff_id remains ignored entirely for staff callers.
-- =========================================================================

create or replace function public.create_appointment(p_workspace_id uuid, p_staff_id uuid, p_customer_name text, p_customer_phone text, p_address_line text, p_area_city text, p_appt_date date, p_start_time time without time zone, p_items jsonb, p_final_duration_override_min integer DEFAULT NULL::integer, p_remarks text DEFAULT NULL::text, p_large_job_override_reason text DEFAULT NULL::text)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
  v_staff_id uuid;
  v_workspace_id uuid;
  v_membership_count integer;
  v_derived_workspace uuid;
  v_item jsonb;
  v_total numeric(10,2) := 0;
  v_rate numeric(10,2);
  v_buffer int;
  v_threshold numeric(10,2);
  v_calc_duration int;
  v_final_duration int;
  v_is_large boolean;
  v_conflicts uuid[];
  v_appt_id uuid;
begin
  if v_role is null then
    raise exception 'Not authorized';
  end if;

  if v_role = 'staff' then
    v_staff_id := public.my_staff_id();
    if v_staff_id is null then
      raise exception 'No staff profile for this account';
    end if;
    if p_final_duration_override_min is not null then
      raise exception 'Staff may not override duration';
    end if;
    if p_large_job_override_reason is not null then
      raise exception 'Staff may not perform a large-job override';
    end if;

    if p_workspace_id is null then
      -- BUG-1 fix: count first, then fetch the single row separately.
      select count(*) into v_membership_count
        from public.staff_workspaces
        where staff_id = v_staff_id and is_active;
      if v_membership_count = 0 then
        raise exception 'No active workspace membership';
      elsif v_membership_count > 1 then
        raise exception 'Multiple active workspace memberships — workspace_id is required';
      end if;
      select workspace_id into v_derived_workspace
        from public.staff_workspaces
        where staff_id = v_staff_id and is_active
        limit 1;
      v_workspace_id := v_derived_workspace;
    else
      if not exists (
        select 1 from public.staff_workspaces
        where staff_id = v_staff_id and workspace_id = p_workspace_id and is_active
      ) then
        raise exception 'Not an active member of this workspace';
      end if;
      v_workspace_id := p_workspace_id;
    end if;

  elsif v_role in ('super_master', 'partner_master') then
    if p_workspace_id is null or p_staff_id is null then
      raise exception 'workspace_id and staff_id are required';
    end if;
    if p_workspace_id not in (select * from public.my_workspace_ids()) then
      raise exception 'Not authorized for this workspace';
    end if;
    if not exists (
      select 1 from public.staff_workspaces
      where staff_id = p_staff_id and workspace_id = p_workspace_id and is_active
    ) then
      raise exception 'Staff is not an active member of this workspace';
    end if;
    v_staff_id := p_staff_id;
    v_workspace_id := p_workspace_id;
  else
    raise exception 'Not authorized';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one service item is required';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_total := v_total + (coalesce((v_item->>'quantity')::int, 1) * (v_item->>'unit_price')::numeric);
  end loop;
  if v_total <= 0 then
    raise exception 'Item total must be positive';
  end if;

  select rm_per_hour_rate, default_buffer_minutes, full_day_lock_threshold
    into strict v_rate, v_buffer, v_threshold
    from public.business_settings;

  v_calc_duration := greatest(1, ceil(v_total / v_rate * 60)::int);
  v_final_duration := coalesce(p_final_duration_override_min, v_calc_duration);
  v_is_large := v_total >= v_threshold;

  perform pg_advisory_xact_lock(hashtext(v_staff_id::text));

  v_conflicts := public.assert_appointment_slot_available(
    v_staff_id, p_appt_date, p_start_time, v_final_duration, v_buffer, v_total,
    null, p_large_job_override_reason is not null
  );
  if coalesce(array_length(v_conflicts, 1), 0) > 0 and p_large_job_override_reason is null then
    raise exception 'A reason is required to override the large-job lock';
  end if;

  insert into public.appointments (
    workspace_id, staff_id, customer_name, customer_phone, address_line,
    area_city, appt_date, start_time, calculated_duration_min,
    final_duration_min, buffer_minutes, total_amount, is_large_job,
    remarks, created_by
  ) values (
    v_workspace_id, v_staff_id, p_customer_name, p_customer_phone,
    p_address_line, p_area_city, p_appt_date, p_start_time, v_calc_duration,
    v_final_duration, v_buffer, v_total, v_is_large, p_remarks, auth.uid()
  )
  returning id into v_appt_id;

  if coalesce(array_length(v_conflicts, 1), 0) > 0 then
    insert into public.appointment_rule_overrides (subject_appointment_id, conflicting_appointment_id, approved_by, reason)
    select v_appt_id, c, auth.uid(), p_large_job_override_reason
    from unnest(v_conflicts) as c;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.appointment_items (appointment_id, description, quantity, unit_price)
    values (
      v_appt_id,
      v_item->>'description',
      coalesce((v_item->>'quantity')::int, 1),
      (v_item->>'unit_price')::numeric
    );
  end loop;

  return v_appt_id;
end;
$function$;

-- =========================================================================
-- PART 4 — BUG-2: working-hours guard considers FUTURE bookings only,
--          in Asia/Kuala_Lumpur business-local time; plus a
--          visibility-aware conflict message (§9 error-surface audit).
--
-- `(appt_date + start_time) > (now() at time zone 'Asia/Kuala_Lumpur')`
-- compares two local wall-clock timestamps: the appointment's own local
-- start, and the current Malaysian local time. This uses the actual
-- start time rather than appt_date alone, so an appointment earlier
-- today does not block a forward-looking schedule change, while a later
-- appointment today still does.
-- =========================================================================

create or replace function public.set_staff_working_hours(p_staff_id uuid, p_day_of_week smallint, p_start_time time without time zone, p_end_time time without time zone)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
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
        and (a.start_time < p_start_time
             or (a.start_time + make_interval(mins => a.final_duration_min)) > p_end_time)
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

-- =========================================================================
-- PART 5 — §9 error-surface audit: set_staff_time_off's conflict message
--          could also reference an appointment the caller cannot see
--          (e.g. Nick setting Jack's time off while Jack has a private
--          appointment that day). Same visibility rule applied.
-- =========================================================================

create or replace function public.set_staff_time_off(p_staff_id uuid, p_off_date date, p_start_time time without time zone DEFAULT NULL::time without time zone, p_end_time time without time zone DEFAULT NULL::time without time zone, p_reason text DEFAULT NULL::text)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
  v_id uuid;
  v_conflict_id uuid;
  v_conflict_visible boolean;
begin
  if auth.uid() is null
     or v_role is null
     or (v_role is distinct from 'super_master'::public.user_role
         and v_role is distinct from 'partner_master'::public.user_role) then
    raise exception 'Only a Master may set staff time off';
  end if;
  if not exists (
    select 1 from public.staff_workspaces
    where staff_id = p_staff_id and is_active
      and workspace_id in (select * from public.my_workspace_ids())
  ) then
    raise exception 'Not authorized for this staff member';
  end if;
  if (p_start_time is null) <> (p_end_time is null) then
    raise exception 'start_time and end_time must both be null (full day) or both set';
  end if;
  if p_start_time is not null and p_start_time >= p_end_time then
    raise exception 'start_time must be before end_time';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_staff_id::text));

  select a.id, public.can_view_conflict(a.workspace_id, a.staff_id)
    into v_conflict_id, v_conflict_visible
    from public.appointments a
    where a.staff_id = p_staff_id and a.status = 'booked' and a.appt_date = p_off_date
      and (
        p_start_time is null
        or tsrange((p_off_date + p_start_time), (p_off_date + p_end_time), '[)') && a.occupied_range
      )
    limit 1;

  if v_conflict_id is not null then
    if v_conflict_visible then
      raise exception 'Conflicts with an existing booked appointment — reschedule or cancel it first';
    else
      raise exception 'STAFF_UNAVAILABLE';
    end if;
  end if;

  insert into public.staff_time_off (staff_id, off_date, start_time, end_time, reason, created_by)
  values (p_staff_id, p_off_date, p_start_time, p_end_time, p_reason, auth.uid())
  returning id into v_id;

  return v_id;
end;
$function$;
