-- 0010: allow recording appointments that already happened.
--
-- The owner records jobs after the fact -- a customer is served at 2pm and the
-- booking is entered at 4pm. Until now create_appointment refused any past
-- datetime outright (0007), which made historical recording impossible.
--
-- This migration makes a past appointment recordable, but never silently: the
-- caller must pass p_confirm_past explicitly. Absent or null refuses, so the
-- guard fails closed and every existing client keeps its current behaviour.
--
-- WHY DROP AND RECREATE RATHER THAN ADD AN OVERLOAD
--
-- CREATE OR REPLACE cannot change a parameter list, so adding a parameter would
-- leave TWO create_appointment functions and force PostgREST to disambiguate by
-- the JSON keys it happens to receive. A single signature is unambiguous, so
-- the twelve-argument form is dropped and replaced by the thirteen-argument one.
-- Grants are re-applied below because DROP discards them.
--
-- WHAT THIS DOES NOT CHANGE
--
--   * reschedule_appointment keeps its 0007 guard: back-dating an existing
--     appointment stays refused. Historical recording is a create-time concern.
--   * assert_appointment_slot_available is untouched. It has no past guard, so
--     overlap, working hours, time off, large-job rules, duration and buffer all
--     still apply to a historical record exactly as they do to a future one.
--   * find_available_slots is untouched and still offers future slots only.
--   * No authorization, RLS, membership or identity rule is relaxed.
--
-- Migrations 0001-0009 are untouched.

drop function if exists public.create_appointment(uuid, uuid, text, text, text, text, date, time without time zone, jsonb, integer, text, text);

CREATE OR REPLACE FUNCTION public.create_appointment(p_workspace_id uuid, p_staff_id uuid, p_customer_name text, p_customer_phone text, p_address_line text, p_area_city text, p_appt_date date, p_start_time time without time zone, p_items jsonb, p_final_duration_override_min integer DEFAULT NULL::integer, p_remarks text DEFAULT NULL::text, p_large_job_override_reason text DEFAULT NULL::text, p_confirm_past boolean DEFAULT false)
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

  -- 0010: past-datetime guard, now with explicit historical recording.
  --
  -- The owner needs to record jobs that already happened, so a past datetime is
  -- permitted -- but ONLY when the caller explicitly passes p_confirm_past.
  -- Absent or null means refuse, so the flag fails closed and any client that
  -- knows nothing about it behaves exactly as it did before.
  --
  -- The flag bypasses NOTHING else. Authorization, workspace membership, staff
  -- identity, physical overlap, working hours, time off, large-job rules,
  -- duration, buffer and concurrency protection all still run below --
  -- assert_appointment_slot_available carries no past guard of its own, so
  -- recording a historical job is validated exactly like any other booking.
  --
  -- reschedule_appointment keeps the original guard unchanged: back-dating an
  -- existing appointment is a different operation from recording a job that
  -- genuinely happened, and remains refused.
  if (p_appt_date + p_start_time) <= (now() at time zone 'Asia/Kuala_Lumpur')
     and not coalesce(p_confirm_past, false) then
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
$function$
;

-- DROP discarded the grants; restore exactly the previous exposure.
revoke execute on function public.create_appointment(uuid, uuid, text, text, text, text, date, time without time zone, jsonb, integer, text, text, boolean) from public;
revoke execute on function public.create_appointment(uuid, uuid, text, text, text, text, date, time without time zone, jsonb, integer, text, text, boolean) from anon;
grant  execute on function public.create_appointment(uuid, uuid, text, text, text, text, date, time without time zone, jsonb, integer, text, text, boolean) to authenticated;

comment on function public.create_appointment(uuid, uuid, text, text, text, text, date, time without time zone, jsonb, integer, text, text, boolean) is
  'Creates an appointment. p_confirm_past allows recording a job that already happened; it fails closed when absent and bypasses no other rule.';
