-- 0021 — KC (Super Master) may correct a completed job
--
-- Owner's rule (2026-10-03): a completed appointment is history for everyone
-- else, but the Super Master can still change its customer details and its
-- services — a misspelt name, a wrong address, an item that was not done.
--
-- Bodies are the deployed definitions (pg_get_functiondef, 2026-10-03) with
-- only these changes:
--   - the status guard also admits status = 'completed' when the caller is a
--     Super Master;
--   - for a completed job, update_appointment_items keeps the job's time slot
--     exactly as it was: no duration recalculation and no availability check
--     (the work is done; re-validating a past slot can only fail spuriously
--     or, by changing its length, collide with a neighbour);
--   - the job's automatic invoice follows the correction while nobody has
--     edited the invoice by hand (updated_at is null) — the same rule add-ons
--     already follow (0020). A hand-edited invoice is left alone.
-- Partner Masters and staff are unchanged: completed is still read-only to them.

create or replace function public.update_appointment(p_appointment_id uuid, p_customer_name text DEFAULT NULL::text, p_customer_phone text DEFAULT NULL::text, p_address_line text DEFAULT NULL::text, p_area_city text DEFAULT NULL::text, p_remarks text DEFAULT NULL::text, p_final_duration_override_min integer DEFAULT NULL::integer, p_large_job_override_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role public.user_role := public.my_role();
  v_appt public.appointments%rowtype;
  v_conflicts uuid[];
  v_correction boolean;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then raise exception 'Appointment not found'; end if;

  if v_role = 'staff' then
    if v_appt.staff_id is distinct from public.my_staff_id() then
      raise exception 'Not your appointment';
    end if;
    if p_final_duration_override_min is not null then
      raise exception 'Staff may not override duration';
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

  -- A Super Master correcting a completed job (0021).
  v_correction := v_appt.status = 'completed' and v_role = 'super_master';

  if v_appt.status <> 'booked' and not v_correction then
    raise exception 'Only a booked appointment can be edited';
  end if;

  if not v_correction and p_final_duration_override_min is not null and p_final_duration_override_min <> v_appt.final_duration_min then
    perform pg_advisory_xact_lock(hashtext(v_appt.staff_id::text));
    v_conflicts := public.assert_appointment_slot_available(
      v_appt.staff_id, v_appt.appt_date, v_appt.start_time,
      p_final_duration_override_min, v_appt.buffer_minutes, v_appt.total_amount,
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
  end if;

  -- workspace_id and staff_id are not parameters here — this function
  -- structurally cannot move or reassign an appointment.
  update public.appointments set
    customer_name       = coalesce(p_customer_name, customer_name),
    customer_phone      = coalesce(p_customer_phone, customer_phone),
    address_line        = coalesce(p_address_line, address_line),
    area_city            = coalesce(p_area_city, area_city),
    remarks              = coalesce(p_remarks, remarks),
    -- A completed job keeps its slot.
    final_duration_min   = case when v_correction then final_duration_min
                                else coalesce(p_final_duration_override_min, final_duration_min) end,
    updated_at           = now()
  where id = p_appointment_id
  returning * into v_appt;

  if v_correction then
    update public.invoices set
      bill_to_name    = left(btrim(v_appt.customer_name), 200),
      bill_to_address = left(case
        when coalesce(v_appt.area_city, '') = '' or position(lower(v_appt.area_city) in lower(v_appt.address_line)) > 0
          then v_appt.address_line
        else v_appt.address_line || ', ' || v_appt.area_city end, 500)
    where appointment_id = p_appointment_id and updated_at is null;
  end if;
end;
$function$;

create or replace function public.update_appointment_items(p_appointment_id uuid, p_items jsonb, p_final_duration_override_min integer DEFAULT NULL::integer, p_large_job_override_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_role public.user_role := public.my_role();
  v_appt public.appointments%rowtype;
  v_item jsonb;
  v_total numeric(10,2) := 0;
  v_rate numeric(10,2);
  v_threshold numeric(10,2);
  v_calc_duration int;
  v_final_duration int;
  v_is_large boolean;
  v_conflicts uuid[];
  v_correction boolean;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then raise exception 'Appointment not found'; end if;

  if v_role = 'staff' then
    if v_appt.staff_id is distinct from public.my_staff_id() then
      raise exception 'Not your appointment';
    end if;
    if p_final_duration_override_min is not null then
      raise exception 'Staff may not override duration';
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

  -- A Super Master correcting a completed job (0021).
  v_correction := v_appt.status = 'completed' and v_role = 'super_master';

  if v_appt.status <> 'booked' and not v_correction then
    raise exception 'Only a booked appointment can be edited';
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

  select rm_per_hour_rate, full_day_lock_threshold into strict v_rate, v_threshold
    from public.business_settings;
  v_is_large := v_total >= v_threshold;

  if v_correction then
    -- The work is done: its slot stays exactly as it was.
    v_calc_duration := v_appt.calculated_duration_min;
    v_final_duration := v_appt.final_duration_min;
  else
    v_calc_duration := greatest(1, ceil(v_total / v_rate * 60)::int);
    v_final_duration := coalesce(p_final_duration_override_min, v_calc_duration);

    perform pg_advisory_xact_lock(hashtext(v_appt.staff_id::text));

    v_conflicts := public.assert_appointment_slot_available(
      v_appt.staff_id, v_appt.appt_date, v_appt.start_time,
      v_final_duration, v_appt.buffer_minutes, v_total,
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
  end if;

  update public.appointments set
    total_amount            = v_total,
    calculated_duration_min = v_calc_duration,
    final_duration_min      = v_final_duration,
    is_large_job             = v_is_large,
    updated_at                = now()
  where id = p_appointment_id;

  delete from public.appointment_items where appointment_id = p_appointment_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.appointment_items (appointment_id, description, quantity, unit_price)
    values (
      p_appointment_id,
      v_item->>'description',
      coalesce((v_item->>'quantity')::int, 1),
      (v_item->>'unit_price')::numeric
    );
  end loop;

  if v_correction then
    perform public.refresh_auto_invoice(p_appointment_id);
  end if;
end;
$function$;
