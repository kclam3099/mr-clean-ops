-- 0017 — fix: add_appointment_addon let a Master of ANOTHER workspace through
--
-- Found while validating 0018 (invoices), confirmed against the live database
-- in a rolled-back transaction: NICK (Master of Shared Team only) could add an
-- add-on to an appointment in KC Private Team, given its id.
--
-- The check was
--
--   if not found or not (
--        v_appt.workspace_id in (select my_workspace_ids())
--     or (v_appt.staff_id is not null and v_appt.staff_id = my_staff_id())
--   ) then raise …
--
-- A Master has no staff row, so my_staff_id() is NULL and the second branch is
-- NULL, not false. FALSE OR NULL is NULL, NOT NULL is NULL, and an IF on NULL
-- does not fire — the refusal was skipped. Each comparison is now coalesced to
-- a definite boolean, so "unknown" can never mean "allowed".
--
-- Not exploited: at the time of the fix the table held no add-ons at all.
-- remove_appointment_addon was checked and is not affected (its staff branch
-- is ANDed with created_by = auth.uid(), which is false for an outsider), but
-- it gets the same explicit form so the two read alike.
--
-- Function bodies only; no table, policy or data change.

create or replace function public.add_appointment_addon(
  p_appointment_id uuid,
  p_description    text,
  p_amount         numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appt  public.appointments%rowtype;
  v_desc  text := btrim(coalesce(p_description, ''));
  v_id    uuid;
  v_row   public.appointment_addons%rowtype;
  v_ok    boolean;
begin
  if auth.uid() is null or public.my_role() is null then
    raise exception 'Not authorized';
  end if;

  select * into v_appt from public.appointments where id = p_appointment_id;

  v_ok := found and (
    coalesce(v_appt.workspace_id in (select public.my_workspace_ids()), false)
    or coalesce(v_appt.staff_id = public.my_staff_id(), false)
  );
  if not v_ok then
    raise exception 'Not authorized';
  end if;

  if v_appt.status = 'cancelled' then
    raise exception 'Add-ons cannot be recorded on a cancelled appointment';
  end if;

  if v_appt.staff_id is null then
    raise exception 'Appointment has no assigned staff to credit';
  end if;

  if char_length(v_desc) < 1 or char_length(v_desc) > 120 then
    raise exception 'Add-on item is required (up to 120 characters)';
  end if;

  if p_amount is null or p_amount <= 0 or p_amount > 100000 then
    raise exception 'Invalid amount';
  end if;

  insert into public.appointment_addons (appointment_id, staff_id, description, amount, created_by)
  values (v_appt.id, v_appt.staff_id, v_desc, round(p_amount, 2), auth.uid())
  returning * into v_row;
  v_id := v_row.id;

  insert into public.audit_logs (actor_profile_id, action_type, entity_type, entity_id, workspace_id, before_json, after_json)
  values (auth.uid(), 'appointment.addon_added', 'appointment', v_appt.id, v_appt.workspace_id, null, to_jsonb(v_row));

  return v_id;
end;
$$;

create or replace function public.remove_appointment_addon(p_addon_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  public.appointment_addons%rowtype;
  v_appt public.appointments%rowtype;
  v_ok   boolean;
begin
  if auth.uid() is null or public.my_role() is null then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.appointment_addons where id = p_addon_id;
  if not found then
    raise exception 'Not authorized';
  end if;

  select * into v_appt from public.appointments where id = v_row.appointment_id;

  v_ok := coalesce(v_appt.workspace_id in (select public.my_workspace_ids()), false)
          or (coalesce(v_row.created_by = auth.uid(), false)
              and coalesce(v_appt.staff_id = public.my_staff_id(), false));
  if not v_ok then
    raise exception 'Not authorized';
  end if;

  delete from public.appointment_addons where id = v_row.id;

  insert into public.audit_logs (actor_profile_id, action_type, entity_type, entity_id, workspace_id, before_json, after_json)
  values (auth.uid(), 'appointment.addon_removed', 'appointment', v_appt.id, v_appt.workspace_id, to_jsonb(v_row), null);
end;
$$;
