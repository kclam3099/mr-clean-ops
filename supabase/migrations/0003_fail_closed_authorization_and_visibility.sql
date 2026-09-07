-- 0003_fail_closed_authorization_and_visibility.sql
--
-- Fixes the authorization bug class found in security QA, plus two
-- visibility gaps. 0001 and 0002 are immutable and already applied;
-- nothing here modifies them.
--
-- THE BUG CLASS: PostgreSQL NULL authorization semantics.
-- my_role() returns NULL for an authenticated user with no profiles row.
-- A guard written as `IF v_role <> 'super_master' THEN RAISE` evaluates
-- NULL <> 'super_master' => NULL, and PL/pgSQL treats IF NULL as false —
-- so the guard silently does not fire and execution continues. Same for
-- `IF v_role NOT IN (...)`.
--
-- Audited all 11 authenticated-callable mutation RPCs empirically, by
-- calling each one as an authenticated user with no profiles row inside
-- rolled-back transactions:
--
--   Already fail closed (unconditional `else raise 'Not authorized'` as
--   the PRIMARY guard, not a secondary check) — unchanged by this file:
--     create_appointment, update_appointment, update_appointment_items,
--     reschedule_appointment, cancel_appointment,
--     mark_appointment_completed
--
--   Exploitable — no secondary check at all, confirmed to SUCCEED for a
--   no-profile caller:
--     set_staff_active
--     set_staff_working_hours (company-default branch, p_staff_id IS NULL)
--
--   Broken primary guard, currently denied only because an unrelated
--   secondary check happens to also reject an empty my_workspace_ids():
--     set_staff_time_off, remove_staff_time_off,
--     set_staff_working_hours (per-staff branch), set_staff_workspace_active
--
-- All five are fixed below. Per the locked instruction, the fix does not
-- rely on the secondary checks — each function now fails closed on its
-- own primary guard. Bodies are otherwise reproduced verbatim from
-- pg_get_functiondef() of the deployed functions, so nothing but the
-- guards changes.

-- =========================================================================
-- PART 1 — FAIL-CLOSED AUTHORIZATION GUARDS
-- =========================================================================

create or replace function public.set_staff_active(p_staff_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
begin
  -- fail closed: no session, no profile, or any role other than super_master
  if auth.uid() is null
     or v_role is distinct from 'super_master'::public.user_role then
    raise exception 'Only Super Master may change staff active status';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_staff_id::text));

  if not p_is_active and exists (
    select 1 from public.appointments
    where staff_id = p_staff_id and status = 'booked' and appt_date >= current_date
  ) then
    raise exception 'Staff has upcoming booked appointments — reassign or cancel them first';
  end if;

  update public.staff set is_active = p_is_active where id = p_staff_id;
end;
$function$;

create or replace function public.set_staff_working_hours(p_staff_id uuid, p_day_of_week smallint, p_start_time time without time zone, p_end_time time without time zone)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
begin
  -- fail closed before any branch is chosen
  if auth.uid() is null or v_role is null then
    raise exception 'Not authorized';
  end if;

  if p_start_time >= p_end_time then
    raise exception 'start_time must be before end_time';
  end if;

  if p_staff_id is null then
    -- company-default row: Super Master only. This branch has no
    -- secondary check by design, which is exactly why the primary guard
    -- has to be fail closed.
    if v_role is distinct from 'super_master'::public.user_role then
      raise exception 'Only Super Master may set the company default working hours';
    end if;
    -- Company-default narrowing isn't re-validated against every staff
    -- member's existing appointments — see round-5 remaining risks.
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

    if exists (
      select 1 from public.appointments
      where staff_id = p_staff_id and status = 'booked'
        and extract(dow from appt_date)::smallint = p_day_of_week
        and (start_time < p_start_time or (start_time + make_interval(mins => final_duration_min)) > p_end_time)
    ) then
      raise exception 'An existing booked appointment falls outside the new hours — reschedule it first';
    end if;
  end if;

  delete from public.staff_working_hours
  where day_of_week = p_day_of_week
    and staff_id is not distinct from p_staff_id;

  insert into public.staff_working_hours (staff_id, day_of_week, start_time, end_time)
  values (p_staff_id, p_day_of_week, p_start_time, p_end_time);
end;
$function$;

create or replace function public.set_staff_workspace_active(p_staff_id uuid, p_workspace_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
begin
  if auth.uid() is null
     or v_role is distinct from 'super_master'::public.user_role then
    raise exception 'Only Super Master may manage staff workspace membership';
  end if;
  if p_workspace_id not in (select * from public.my_workspace_ids()) then
    raise exception 'Not authorized for this workspace';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_staff_id::text));

  if not p_is_active and exists (
    select 1 from public.appointments
    where staff_id = p_staff_id and workspace_id = p_workspace_id
      and status = 'booked' and appt_date >= current_date
  ) then
    raise exception 'Staff has upcoming booked appointments in this workspace — reassign or cancel them first';
  end if;

  if p_is_active then
    if exists (select 1 from public.staff_workspaces where staff_id = p_staff_id and workspace_id = p_workspace_id and is_active) then
      raise exception 'Already an active member';
    end if;
    insert into public.staff_workspaces (staff_id, workspace_id, is_active, joined_at)
    values (p_staff_id, p_workspace_id, true, now());
  else
    update public.staff_workspaces
    set is_active = false, ended_at = now()
    where staff_id = p_staff_id and workspace_id = p_workspace_id and is_active;
    if not found then
      raise exception 'No active membership found to end';
    end if;
  end if;
end;
$function$;

create or replace function public.set_staff_time_off(p_staff_id uuid, p_off_date date, p_start_time time without time zone default null::time without time zone, p_end_time time without time zone default null::time without time zone, p_reason text default null::text)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
  v_id uuid;
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

  if exists (
    select 1 from public.appointments
    where staff_id = p_staff_id and status = 'booked' and appt_date = p_off_date
      and (
        p_start_time is null
        or tsrange(
             (p_off_date + p_start_time),
             (p_off_date + p_end_time),
             '[)'
           ) && occupied_range
      )
  ) then
    raise exception 'Conflicts with an existing booked appointment — reschedule or cancel it first';
  end if;

  insert into public.staff_time_off (staff_id, off_date, start_time, end_time, reason, created_by)
  values (p_staff_id, p_off_date, p_start_time, p_end_time, p_reason, auth.uid())
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function public.remove_staff_time_off(p_time_off_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
  v_row public.staff_time_off%rowtype;
begin
  if auth.uid() is null
     or v_role is null
     or (v_role is distinct from 'super_master'::public.user_role
         and v_role is distinct from 'partner_master'::public.user_role) then
    raise exception 'Only a Master may remove staff time off';
  end if;
  select * into v_row from public.staff_time_off where id = p_time_off_id;
  if not found then raise exception 'Not found'; end if;
  if not exists (
    select 1 from public.staff_workspaces
    where staff_id = v_row.staff_id and is_active
      and workspace_id in (select * from public.my_workspace_ids())
  ) then
    raise exception 'Not authorized for this staff member';
  end if;

  -- Removing a restriction can't create a conflict, but the lock is
  -- still taken for a single consistent protocol across every mutation
  -- in this section, not because this specific call needs it.
  perform pg_advisory_xact_lock(hashtext(v_row.staff_id::text));
  delete from public.staff_time_off where id = p_time_off_id;
end;
$function$;

-- =========================================================================
-- PART 2 — PROFILES VISIBILITY (SELECT only; no write access widened)
--
-- Target matrix:
--   KC (super_master)      -> all 5 profiles
--   Nick (partner_master)  -> self + co-masters of workspaces he
--                             administers + staff in those workspaces
--                             (KC, Nick, Jack, Dyron) — never Victor
--   Staff                  -> own profile only
--
-- Each policy grants only when its expression is TRUE; a NULL from
-- my_role()/my_workspace_ids() grants nothing, so no-profile and anon
-- callers see zero rows.
-- =========================================================================

drop policy if exists profiles_self_select on public.profiles;
drop policy if exists profiles_master_select_staff on public.profiles;

create policy profiles_self_select on public.profiles for select using (
  id = auth.uid()
);

create policy profiles_super_master_select_all on public.profiles for select using (
  public.my_role() = 'super_master'::public.user_role
);

create policy profiles_master_select_workspace_staff on public.profiles for select using (
  exists (
    select 1 from public.staff s
    join public.staff_workspaces sw on sw.staff_id = s.id
    where s.profile_id = profiles.id
      and sw.is_active
      and sw.workspace_id in (select * from public.my_workspace_ids())
  )
);

create policy profiles_master_select_comasters on public.profiles for select using (
  exists (
    select 1 from public.workspace_masters wm
    where wm.profile_id = profiles.id
      and wm.workspace_id in (select * from public.my_workspace_ids())
  )
);

-- =========================================================================
-- PART 3 — WORKSPACE VISIBILITY FOR STAFF (SELECT only)
--
-- Masters keep exactly what they had (workspaces they administer). Staff
-- gain read access to the workspace(s) they are an ACTIVE member of, and
-- nothing else — my_staff_id() is NULL for masters/anon/no-profile, so
-- `sw.staff_id = public.my_staff_id()` never matches for them.
--
--   KC     -> Shared Team + KC Private Team
--   Nick   -> Shared Team only (KC Private Team stays invisible even if
--             its UUID is guessed)
--   Jack   -> Shared Team only
--   Dyron  -> Shared Team only
--   Victor -> KC Private Team only
-- =========================================================================

drop policy if exists workspaces_select on public.workspaces;

create policy workspaces_select on public.workspaces for select using (
  id in (select * from public.my_workspace_ids())
  or exists (
    select 1 from public.staff_workspaces sw
    where sw.workspace_id = workspaces.id
      and sw.is_active
      and sw.staff_id = public.my_staff_id()
  )
);
