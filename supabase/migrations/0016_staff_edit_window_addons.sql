-- 0016 — the 3-day staff edit window covers add-ons too
--
-- 0015 made an appointment read-only to staff from the fourth day after its
-- date. Add-ons live in their own table and are written by
-- add_appointment_addon / remove_appointment_addon, which 0015's triggers do
-- not see — so without this a staff member could still add or remove add-ons
-- (commission) on an old job. Same window, same message, same function.
-- Masters are unaffected.

create or replace function public.enforce_staff_edit_window_addons()
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

drop trigger if exists trg_enforce_staff_edit_window_addons on public.appointment_addons;
create trigger trg_enforce_staff_edit_window_addons
  before insert or update or delete on public.appointment_addons
  for each row
  execute function public.enforce_staff_edit_window_addons();

revoke all on function public.enforce_staff_edit_window_addons() from public, anon, authenticated;
