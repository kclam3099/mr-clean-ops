-- 0007_availability_privacy_and_past_guard.sql
--
-- Three fixes. Does not modify 0001-0006.
--
-- 1. CONFIRMED SIDE CHANNEL in find_available_slots (0006).
--
--    p_total_amount drove the server-derived duration, which changed the
--    candidate's occupied range, which changed whether a candidate overlapped a
--    HIDDEN cross-workspace appointment. A Shared-Team-only Master could sweep
--    the amount and watch a suggested slot disappear.
--
--    Measured on DEV against a hidden KC Private Team job at 12:00 (RM200,
--    60 min, non-large so the RM600 lock could not contaminate the result),
--    querying the 10:00 candidate as TEST_NICK with a real JWT:
--
--        RM300 -> 90 min -> candidate ends 12:00 -> AVAILABLE
--        RM301 -> 91 min -> candidate ends 12:01 -> OMITTED
--
--    Nine calls binary-searched the hidden appointment's start time to the
--    exact minute. A control date with no hidden appointment stayed AVAILABLE
--    across the same sweep, so the transition was attributable to the hidden
--    job alone.
--
--    Fix: the finder becomes a STANDARD-JOB recommendation surface. The
--    p_total_amount parameter is removed entirely and the duration is always
--    the configured default. There is no longer any caller-controlled input
--    that can vary the probe window, so the boundary cannot be swept.
--
--    A frontend restriction would not have been a fix: the RPC is directly
--    callable by any authenticated client.
--
--    create_appointment remains authoritative for the real items and value.
--
-- 2. CONFIRMED GAP: create_appointment and reschedule_appointment accepted
--    appointments in the past (verified: a booking three days ago, and 09:00
--    today when it was already evening in MYT, were both accepted). Both now
--    require a start strictly in the future in Asia/Kuala_Lumpur.
--
--    These two function bodies are the DEPLOYED definitions with only the guard
--    inserted; they were read from pg_get_functiondef rather than retyped, so
--    no other behaviour changes.
--
-- 3. business_settings is not readable by staff (verified: kc=1, nick=1,
--    jack=0, victor=0 rows), so the booking UI cannot render a duration
--    estimate for staff. Rather than widening table access, a narrow RPC
--    exposes only the three fields the booking form needs.

-- --------------------------------------------------------------------------
-- 1. Availability finder — standard-job only, no amount input
-- --------------------------------------------------------------------------
-- The old five-argument signature is dropped outright. F2 has not shipped, so
-- nothing depends on it.
drop function if exists public.find_available_slots(uuid[], date, date, uuid, numeric);

create or replace function public.find_available_slots(
  p_staff_ids     uuid[],
  p_from          date,
  p_to            date,
  p_workspace_id  uuid default null
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
  v_buffer            integer;
  v_default_duration  integer;
  v_duration          integer;
  v_membership_count  integer;
  v_staff             uuid;
  v_date              date;
  v_slot              time without time zone;
begin
  if auth.uid() is null or v_role is null then
    raise exception 'Not authorized';
  end if;

  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Invalid range';
  end if;
  if p_from < v_today then
    raise exception 'Invalid range';
  end if;
  if (p_to - p_from) > 13 then
    raise exception 'Range too large';
  end if;

  if v_role = 'staff' then
    v_my_staff := public.my_staff_id();
    if v_my_staff is null then
      return;
    end if;

    select count(*) into v_membership_count
      from public.staff_workspaces sw
     where sw.staff_id = v_my_staff and sw.is_active;

    if v_membership_count = 0 then
      return;
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
      select sw.workspace_id into v_config_ws
        from public.staff_workspaces sw
       where sw.staff_id = v_my_staff and sw.is_active
       limit 1;
    else
      raise exception 'Multiple active workspace memberships — workspace_id is required';
    end if;

    if p_staff_ids is null then
      v_targets := array[v_my_staff];
    else
      select array_agg(distinct t.id) into v_targets
        from unnest(p_staff_ids) as t(id)
       where t.id = v_my_staff;
    end if;

    if not exists (select 1 from public.staff s where s.id = v_my_staff and s.is_active) then
      return;
    end if;

  elsif v_role in ('super_master', 'partner_master') then
    if p_workspace_id is not null then
      if p_workspace_id in (select * from public.my_workspace_ids()) then
        v_config_ws := p_workspace_id;
      else
        return;
      end if;
    end if;

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
    return;
  end if;

  -- STANDARD JOB ONLY. The probe window is fixed server-side configuration, so
  -- a caller has no way to vary it and sweep for a hidden boundary. This is the
  -- whole point of the 0007 change; do not reintroduce a caller-supplied
  -- amount, duration or buffer here.
  select bs.default_buffer_minutes, bs.default_availability_job_duration_minutes
    into strict v_buffer, v_default_duration
    from public.business_settings bs;

  v_duration := greatest(1, coalesce(v_default_duration, 60));

  foreach v_staff in array v_targets loop
    v_date := p_from;
    while v_date <= p_to loop
      foreach v_slot in array v_slots loop
        if (v_date + v_slot) > v_now then
          begin
            -- Amount 0: the candidate is never itself classified as a large
            -- job. Existing large jobs still block it forward.
            perform public.assert_appointment_slot_available(
              v_staff, v_date, v_slot, v_duration, v_buffer, 0, null, false);

            staff_id  := v_staff;
            slot_date := v_date;
            slot_time := v_slot;
            return next;

          exception
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

revoke execute on function public.find_available_slots(uuid[], date, date, uuid) from public;
revoke execute on function public.find_available_slots(uuid[], date, date, uuid) from anon;
grant  execute on function public.find_available_slots(uuid[], date, date, uuid) to authenticated;

-- --------------------------------------------------------------------------
-- 2. Booking configuration for the UI — narrow, read-only
-- --------------------------------------------------------------------------
-- Only what the Add Appointment form needs to render an ESTIMATE. Deliberately
-- excluded:
--   full_day_lock_threshold  - the UI must not pre-judge whether an override is
--                              needed; the server decides from real conflicts.
--   default_day_start/end    - staff-specific hours override these, so showing
--                              company defaults would mislead. The server
--                              returns the real window in OUTSIDE_WORKING_HOURS.
--   staff_can_mark_completed, wa_reminder_template_*  - unrelated to booking.
create or replace function public.get_booking_config()
returns table (
  rm_per_hour_rate                          numeric,
  default_buffer_minutes                    integer,
  default_availability_job_duration_minutes integer
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
begin
  -- An authenticated account without a profile has no capability anywhere else
  -- either; it does not get configuration.
  if auth.uid() is null or v_role is null then
    raise exception 'Not authorized';
  end if;

  return query
    select bs.rm_per_hour_rate,
           bs.default_buffer_minutes,
           bs.default_availability_job_duration_minutes
      from public.business_settings bs;
end;
$function$;

revoke execute on function public.get_booking_config() from public;
revoke execute on function public.get_booking_config() from anon;
grant  execute on function public.get_booking_config() to authenticated;

-- --------------------------------------------------------------------------
-- 3. Past-datetime guard
-- --------------------------------------------------------------------------
-- Both bodies below are the deployed definitions with only the guard inserted.

CREATE OR REPLACE FUNCTION public.create_appointment(p_workspace_id uuid, p_staff_id uuid, p_customer_name text, p_customer_phone text, p_address_line text, p_area_city text, p_appt_date date, p_start_time time without time zone, p_items jsonb, p_final_duration_override_min integer DEFAULT NULL::integer, p_remarks text DEFAULT NULL::text, p_large_job_override_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- 0007: past-datetime guard. A booking must start strictly in the future in
  -- the business timezone. Deliberately placed before every other rule so no
  -- role, and no large-job override, can bypass it.
  if (p_appt_date + p_start_time) <= (now() at time zone 'Asia/Kuala_Lumpur') then
    raise exception 'Appointment must be in the future';
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

CREATE OR REPLACE FUNCTION public.reschedule_appointment(p_appointment_id uuid, p_new_date date, p_new_start_time time without time zone, p_large_job_override_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role public.user_role := public.my_role();
  v_appt public.appointments%rowtype;
  v_conflicts uuid[];
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then raise exception 'Appointment not found'; end if;

  if v_role = 'staff' then
    if v_appt.staff_id is distinct from public.my_staff_id() then
      raise exception 'Not your appointment';
    end if;
    if p_large_job_override_reason is not null then
      raise exception 'Staff may not perform a large-job override';
    end if;
  elsif v_role in ('super_master', 'partner_master') then
    if v_appt.workspace_id not in (select * from public.my_workspace_ids()) then
      raise exception 'Not authorized for this workspace';
    end if;
  else
    raise exception 'Not authorized';
  end if;

  if v_appt.status <> 'booked' then
    raise exception 'Only a booked appointment can be rescheduled';
  end if;

  -- 0007: past-datetime guard. A booking must start strictly in the future in
  -- the business timezone. Deliberately placed before every other rule so no
  -- role, and no large-job override, can bypass it.
  if (p_new_date + p_new_start_time) <= (now() at time zone 'Asia/Kuala_Lumpur') then
    raise exception 'Appointment must be in the future';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_appt.staff_id::text));
  v_conflicts := public.assert_appointment_slot_available(
    v_appt.staff_id, p_new_date, p_new_start_time,
    v_appt.final_duration_min, v_appt.buffer_minutes, v_appt.total_amount,
    p_appointment_id, p_large_job_override_reason is not null
  );
  if coalesce(array_length(v_conflicts, 1), 0) > 0 then
    if p_large_job_override_reason is null then
      raise exception 'A reason is required to override the large-job lock';
    end if;
    insert into public.appointment_rule_overrides (subject_appointment_id, conflicting_appointment_id, approved_by, reason)
    select p_appointment_id, c, auth.uid(), p_large_job_override_reason
    from unnest(v_conflicts) as c;
  end if;

  update public.appointments
  set appt_date = p_new_date, start_time = p_new_start_time, updated_at = now()
  where id = p_appointment_id;
end;
$function$;
