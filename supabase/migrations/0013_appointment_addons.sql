-- 0013 — appointment add-ons
--
-- An add-on is extra work a staff member sells on site — "also did the
-- mattress, RM80" — recorded against the appointment it happened on. The owner
-- wants to see, per staff member, how much was added on in a month.
--
-- DELIBERATELY SEPARATE FROM appointment_items. Items are what was BOOKED: they
-- drive total_amount, the calculated duration, the RM600 large-job lock and the
-- availability engine. An add-on happens after the slot is already fixed, so
-- it must not move any of those — a RM300 add-on recorded at 4pm must not turn
-- a finished job retroactively into a "large job" or invalidate the bookings
-- that came after it. Booked revenue and add-on revenue are reported side by
-- side, never summed into one another.
--
-- CREDIT. staff_id is the appointment's assigned staff member at the moment the
-- add-on is recorded, copied onto the row. Reassigning the appointment later
-- does not silently move commission that was already earned.
--
-- VISIBILITY. An add-on is exactly as visible as its appointment, using the
-- same predicate as appointment_items_select. A staff member shared between two
-- workspaces therefore has add-ons a Master can and cannot see, and the monthly
-- report — computed from these rows through RLS — totals only the visible ones.
-- There is no aggregate function that could sum across what the caller cannot
-- see.
--
-- WRITES go only through the two SECURITY DEFINER functions below. No INSERT,
-- UPDATE or DELETE policy exists: a policy would let a caller choose staff_id
-- and credit someone else.

create table if not exists public.appointment_addons (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  staff_id       uuid not null references public.staff(id),
  description    text not null check (char_length(btrim(description)) between 1 and 120),
  amount         numeric(10,2) not null check (amount > 0 and amount <= 100000),
  created_by     uuid not null references public.profiles(id),
  created_at     timestamptz not null default now()
);

comment on table public.appointment_addons is
  'Extra work sold on site, recorded against an appointment and credited to its '
  'assigned staff. Not part of total_amount. Written only by '
  'add_appointment_addon() / remove_appointment_addon().';

create index if not exists appointment_addons_appointment_idx
  on public.appointment_addons (appointment_id);
create index if not exists appointment_addons_staff_idx
  on public.appointment_addons (staff_id);

alter table public.appointment_addons enable row level security;

create policy appointment_addons_select
  on public.appointment_addons for select
  using (
    exists (
      select 1 from public.appointments a
       where a.id = appointment_addons.appointment_id
         and (a.workspace_id in (select public.my_workspace_ids())
              or a.staff_id = public.my_staff_id())
    )
  );

revoke all on public.appointment_addons from anon;

-- ---------------------------------------------------------------------------
-- add_appointment_addon
--
-- Callable by a Master who administers the appointment's workspace, or by the
-- staff member the appointment is assigned to. Anyone else — including a Master
-- of a different workspace — gets the same 'Not authorized' as for an id that
-- does not exist, so the call cannot be used to probe for hidden appointments.
-- ---------------------------------------------------------------------------
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
begin
  if auth.uid() is null or public.my_role() is null then
    raise exception 'Not authorized';
  end if;

  select * into v_appt from public.appointments where id = p_appointment_id;

  if not found
     or not (
       v_appt.workspace_id in (select public.my_workspace_ids())
       or (v_appt.staff_id is not null and v_appt.staff_id = public.my_staff_id())
     ) then
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

-- ---------------------------------------------------------------------------
-- remove_appointment_addon
--
-- A Master of the workspace may remove any add-on on its appointments (fixing a
-- typo, a refund). A staff member may remove only an add-on they recorded
-- themselves, on an appointment still assigned to them.
-- ---------------------------------------------------------------------------
create or replace function public.remove_appointment_addon(p_addon_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  public.appointment_addons%rowtype;
  v_appt public.appointments%rowtype;
begin
  if auth.uid() is null or public.my_role() is null then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.appointment_addons where id = p_addon_id;
  if not found then
    raise exception 'Not authorized';
  end if;

  select * into v_appt from public.appointments where id = v_row.appointment_id;

  if not (
    v_appt.workspace_id in (select public.my_workspace_ids())
    or (v_row.created_by = auth.uid()
        and v_appt.staff_id is not null
        and v_appt.staff_id = public.my_staff_id())
  ) then
    raise exception 'Not authorized';
  end if;

  delete from public.appointment_addons where id = v_row.id;

  insert into public.audit_logs (actor_profile_id, action_type, entity_type, entity_id, workspace_id, before_json, after_json)
  values (auth.uid(), 'appointment.addon_removed', 'appointment', v_appt.id, v_appt.workspace_id, to_jsonb(v_row), null);
end;
$$;

revoke all on function public.add_appointment_addon(uuid, text, numeric) from public;
revoke all on function public.add_appointment_addon(uuid, text, numeric) from anon;
grant execute on function public.add_appointment_addon(uuid, text, numeric) to authenticated;

revoke all on function public.remove_appointment_addon(uuid) from public;
revoke all on function public.remove_appointment_addon(uuid) from anon;
grant execute on function public.remove_appointment_addon(uuid) to authenticated;
