-- 0015 — staff edit window: three days after the appointment, read-only
--
-- A staff member may change an appointment (customer details, services,
-- time, cancellation) up to three days after its date. From the fourth day it
-- is history to them: they can still open and read it, and still mark it
-- completed — a job done late in the week is still done — but nothing else.
-- Masters are unaffected.
--
-- WHY A TRIGGER. Staff reach appointments through several RPCs
-- (update_appointment, update_appointment_items, reschedule_appointment,
-- cancel_appointment, mark_appointment_completed). Adding the rule to each
-- would be five copies to keep in step; a BEFORE trigger on the rows they all
-- write is one, and it also covers any path added later. Hiding the buttons in
-- the UI is only a courtesy — this is the rule.
--
-- The window is measured in business-local days (Asia/Kuala_Lumpur): an
-- appointment on 2 Oct is editable through 5 Oct and locked from 6 Oct.
--
-- Calls without a session (auth.uid() null, i.e. trusted server tooling) have
-- no role and are not restricted, exactly like the other enforcement triggers.

create or replace function public.staff_edit_window_open(p_appt_date date)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_appt_date >= (now() at time zone 'Asia/Kuala_Lumpur')::date - 3
$$;

create or replace function public.enforce_staff_edit_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.my_role() is distinct from 'staff'::public.user_role then
    return new;
  end if;
  if public.staff_edit_window_open(old.appt_date) then
    return new;
  end if;

  -- Outside the window the only change allowed is booked -> completed, with
  -- every other column untouched (updated_at aside). occupied_range is left
  -- out because it is GENERATED: in a BEFORE trigger it is still NULL in NEW,
  -- so comparing it would refuse every completion. It derives from columns
  -- that ARE compared, so nothing escapes the check.
  if new.status = 'completed' and old.status = 'booked'
     and (to_jsonb(new) - 'status' - 'updated_at' - 'occupied_range')
       = (to_jsonb(old) - 'status' - 'updated_at' - 'occupied_range') then
    return new;
  end if;

  raise exception 'Appointments older than 3 days can no longer be edited';
end;
$$;

drop trigger if exists trg_enforce_staff_edit_window on public.appointments;
create trigger trg_enforce_staff_edit_window
  before update on public.appointments
  for each row
  execute function public.enforce_staff_edit_window();

-- Services are rows of their own; editing them must hit the same wall even if
-- the appointment's total happens not to change.
create or replace function public.enforce_staff_edit_window_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date;
begin
  if public.my_role() is distinct from 'staff'::public.user_role then
    return coalesce(new, old);
  end if;

  select a.appt_date into v_date
    from public.appointments a
   where a.id = coalesce(new.appointment_id, old.appointment_id);

  if v_date is not null and not public.staff_edit_window_open(v_date) then
    raise exception 'Appointments older than 3 days can no longer be edited';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_enforce_staff_edit_window_items on public.appointment_items;
create trigger trg_enforce_staff_edit_window_items
  before insert or update or delete on public.appointment_items
  for each row
  execute function public.enforce_staff_edit_window_items();

-- Trigger functions are not called directly by anyone.
revoke all on function public.enforce_staff_edit_window() from public, anon, authenticated;
revoke all on function public.enforce_staff_edit_window_items() from public, anon, authenticated;
revoke all on function public.staff_edit_window_open(date) from public, anon;
grant execute on function public.staff_edit_window_open(date) to authenticated;
