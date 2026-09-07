-- 0001_core_schema_and_rls.sql
-- Matches: Blueprint v0.2, Phase 1 Build Plan §1B-§1F, and the
-- Appointment Engine requirements locked across review rounds 3-5.
-- NOT YET APPLIED.
--
-- Company structure: Super Master KC (both workspaces); Partner Master
-- Nick (Shared Team only, must never see KC Private Team); Shared Team
-- staff Jack & Dyron; KC Private Team staff Victor (invisible to Nick).
--
-- Round-5 changes versus round 4, at a glance:
--   - large_job_lock_overridden/by/at/reason are REMOVED from
--     appointments. A permanent per-appointment flag was wrong: it let
--     approving one exception (e.g. a 3pm booking against a 10am large
--     job) silently authorize every later booking that day too. Replaced
--     with appointment_rule_overrides — one row PER (subject, conflicting)
--     pair, so a second exception (e.g. 5pm against the same 10am job)
--     independently requires its own reason and its own row.
--   - approve_large_job_override() is removed. Overrides are now only
--     ever granted inline, in the same transaction as the create/
--     reschedule/items-edit call that actually needs one — there's no
--     scenario left where a standalone "approve after the fact" call
--     would make sense under the per-exception model.
--   - Every schedule-affecting mutation now takes the SAME
--     pg_advisory_xact_lock(hashtext(staff_id)) before writing:
--     appointment create/reschedule/items-edit (already did), plus new
--     locked RPCs for staff time off, staff working hours, staff
--     active/inactive, and staff_workspaces membership — replacing the
--     direct RLS write policies those tables had before, so there is no
--     remaining schedule-affecting write path that skips the lock.
--   - Status transitions are locked down: cancel/edit/items-edit all now
--     require status = 'booked' (not just "not already cancelled") —
--     completed and cancelled are both terminal, no path back to booked.
--   - update_appointment_items() is new: the only way to change service
--     items, recomputes total_amount/duration/is_large_job server-side
--     and re-runs full Layer 2 validation before committing.

-- No explicit BEGIN/COMMIT here on purpose: the Supabase CLI manages the
-- migration transaction lifecycle itself, and manual transaction control
-- inside a migration file can interfere with db push and migration
-- history behaviour.
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create type user_role as enum ('super_master', 'partner_master', 'staff');
create type appointment_status as enum ('booked', 'completed', 'cancelled');

-- =========================================================================
-- PART 1 — SCHEMA
-- =========================================================================

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role user_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table workspace_masters (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  profile_id   uuid not null references profiles(id) on delete cascade,
  granted_at   timestamptz not null default now(),
  primary key (workspace_id, profile_id)
);
create index idx_workspace_masters_profile on workspace_masters (profile_id);

create table staff (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles(id) on delete cascade,
  display_name text not null,
  phone text,
  home_base_label text,
  home_base_area text,
  home_base_lat numeric(9,6) check (home_base_lat between -90 and 90),
  home_base_lng numeric(9,6) check (home_base_lng between -180 and 180),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table staff_workspaces (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  is_active boolean not null default true,
  joined_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint chk_ended_at_requires_inactive check (is_active or ended_at is not null)
);
create unique index uq_staff_workspaces_active on staff_workspaces (staff_id, workspace_id) where is_active;
create index idx_staff_workspaces_workspace on staff_workspaces (workspace_id) where is_active;
create index idx_staff_workspaces_staff on staff_workspaces (staff_id) where is_active;

create table staff_working_hours (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id) on delete cascade,  -- null = company default
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time   time not null,
  constraint chk_working_hours_order check (start_time < end_time)
);
-- V1 supports exactly one working interval per staff per weekday — no
-- split shifts. Two partial unique indexes rather than a single
-- coalesce(staff_id, sentinel) index: cleaner, and avoids relying on a
-- magic placeholder UUID that could (astronomically unlikely, but
-- needlessly) collide with a real staff.id.
create unique index uq_working_hours_staff_day on staff_working_hours (staff_id, day_of_week) where staff_id is not null;
create unique index uq_working_hours_default_day on staff_working_hours (day_of_week) where staff_id is null;

create table staff_time_off (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  off_date date not null,
  start_time time,
  end_time time,
  reason text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  constraint chk_time_off_range check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null and start_time < end_time)
  )
);
create index idx_staff_time_off_staff_date on staff_time_off (staff_id, off_date);

create table monthly_staff_targets (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  year integer not null,
  month smallint not null check (month between 1 and 12),
  target_amount numeric(10,2) not null check (target_amount >= 0),
  unique (staff_id, year, month)
);

create table suggested_time_slots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  slot_time time not null,
  sort_order smallint not null default 0,
  is_active boolean not null default true
);

create table business_settings (
  id boolean primary key default true check (id),
  rm_per_hour_rate numeric(10,2) not null default 200 check (rm_per_hour_rate > 0),
  full_day_lock_threshold numeric(10,2) not null default 600 check (full_day_lock_threshold > 0),
  default_availability_job_duration_minutes integer not null default 60 check (default_availability_job_duration_minutes > 0),
  default_buffer_minutes integer not null default 30 check (default_buffer_minutes >= 0),
  default_day_start time not null default '09:00',
  default_day_end   time not null default '19:00',
  staff_can_mark_completed boolean not null default true,
  wa_reminder_template_zh text not null default '',
  wa_reminder_template_en text not null default '',
  wa_reminder_template_ms text not null default '',
  updated_at timestamptz not null default now(),
  constraint chk_day_bounds check (default_day_start < default_day_end)
);

-- Configuration bootstrap, NOT customer/staff data — the Appointment
-- Engine reads business_settings unconditionally (create_appointment
-- etc. all do `select ... into strict ... from business_settings`,
-- which raises NO_DATA_FOUND if the table is empty), and a CREATE
-- TABLE's column DEFAULTs only apply to a row that gets inserted — they
-- never create one on their own. Without this, the engine is unusable
-- immediately after this migration applies. `on conflict do nothing`
-- makes it safe to run this file more than once (e.g. a local
-- `supabase db reset`) without erroring on the second run.
insert into business_settings (id) values (true)
on conflict (id) do nothing;

-- Same reasoning for the suggested-slot defaults (Blueprint v0.2 §14):
-- these are what the "This/Next Week" quick-availability generator
-- offers out of the box. workspace_id null = the global default list,
-- editable per-workspace later via slots_write. Guarded by a NOT EXISTS
-- rather than a unique constraint + ON CONFLICT, since slot_time has no
-- natural uniqueness of its own to conflict on — this just skips the
-- insert if a global-default list already exists at all, so a second
-- run of this file is still a no-op rather than a duplicate set.
insert into suggested_time_slots (workspace_id, slot_time, sort_order, is_active)
select null, v.slot_time, v.sort_order, true
from (values
  ('10:00'::time, 0),
  ('13:00'::time, 1),
  ('15:00'::time, 2)
) as v(slot_time, sort_order)
where not exists (select 1 from suggested_time_slots where workspace_id is null);

create table appointments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  staff_id uuid references staff(id),
  customer_name text not null,
  customer_phone text not null,
  address_line text not null,
  area_city text not null,
  appt_date date not null,
  start_time time not null,
  calculated_duration_min integer not null check (calculated_duration_min > 0),
  final_duration_min integer not null check (final_duration_min > 0),
  buffer_minutes integer not null default 30 check (buffer_minutes >= 0),
  total_amount numeric(10,2) not null default 0 check (total_amount >= 0),
  is_large_job boolean not null default false,
  status appointment_status not null default 'booked',
  remarks text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Local wall-clock range, deliberately NOT timestamptz.
  --
  -- A generated STORED column requires an IMMUTABLE expression, and
  -- Postgres rejects any AT TIME ZONE form here — verified empirically
  -- against this exact database, not assumed: `datetime_pl` (date+time),
  -- `make_interval`, and both range constructors all report IMMUTABLE in
  -- pg_proc, yet a tstzrange built via AT TIME ZONE is still refused
  -- ("generation expression is not immutable"), while the plain tsrange
  -- form below is accepted and supports the GiST exclusion constraint.
  --
  -- This is also the more coherent model: appt_date and start_time are
  -- already stored as local date/time, so deriving a local range from
  -- them keeps one consistent frame of reference instead of mixing local
  -- source columns with an absolute-instant range. Overlap detection is
  -- mathematically identical either way while the business operates in a
  -- single fixed-offset zone (Asia/Kuala_Lumpur, UTC+8, no DST) — which
  -- storing date+time rather than timestamptz already assumes. A second
  -- timezone would require revisiting this column AND those two source
  -- columns together.
  occupied_range tsrange generated always as (
    tsrange(
      (appt_date + start_time),
      (appt_date + start_time)
        + make_interval(mins => final_duration_min + buffer_minutes),
      '[)'
    )
  ) stored
);

alter table appointments
  add constraint no_overlapping_staff_bookings
  exclude using gist (
    staff_id with =,
    occupied_range with &&
  ) where (status <> 'cancelled' and staff_id is not null);

create index idx_appointments_workspace_date on appointments (workspace_id, appt_date);
create index idx_appointments_staff_date on appointments (staff_id, appt_date);

create table appointment_items (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  description text not null,
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric(10,2) not null check (unit_price >= 0),
  line_total numeric(10,2) generated always as (quantity * unit_price) stored
);
create index idx_appointment_items_appointment on appointment_items (appointment_id);

-- §1: one row per authorized EXCEPTION, not a permanent flag on the
-- large appointment. subject_appointment_id is whichever appointment
-- this specific create/reschedule/items-edit call was admitting;
-- conflicting_appointment_id is the other party in that specific pair.
-- A second, later booking against the SAME large job gets its own row,
-- with its own reason — nothing here makes future bookings automatically
-- valid.
create table appointment_rule_overrides (
  id uuid primary key default gen_random_uuid(),
  rule_type text not null default 'large_job_forward_lock',
  subject_appointment_id uuid not null references appointments(id) on delete cascade,
  conflicting_appointment_id uuid references appointments(id),
  approved_by uuid not null references profiles(id),
  approved_at timestamptz not null default now(),
  reason text not null check (btrim(reason) <> ''),
  created_at timestamptz not null default now()
);
create index idx_rule_overrides_subject on appointment_rule_overrides (subject_appointment_id);
create index idx_rule_overrides_conflicting on appointment_rule_overrides (conflicting_appointment_id);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references profiles(id),
  actor_label text,
  action_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  workspace_id uuid references workspaces(id),
  before_json jsonb,
  after_json jsonb,
  reason text,
  created_at timestamptz not null default now(),
  constraint chk_actor_identity check (
    (actor_profile_id is not null and actor_label is null)
    or (actor_profile_id is null and actor_label = 'SYSTEM')
  )
);
create index idx_audit_logs_workspace_created on audit_logs (workspace_id, created_at desc);

-- =========================================================================
-- PART 2 — SECURITY DEFINER FUNCTIONS
-- =========================================================================

-- --- identity helpers ----------------------------------------------------

create function my_workspace_ids()
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select workspace_id from public.workspace_masters where profile_id = auth.uid()
$$;

create function my_staff_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select id from public.staff where profile_id = auth.uid()
$$;

create function my_role()
returns user_role
language sql stable security definer
set search_path = ''
as $$
  select role from public.profiles where id = auth.uid()
$$;

revoke execute on function my_workspace_ids() from public;
revoke execute on function my_staff_id()      from public;
revoke execute on function my_role()          from public;
grant execute on function my_workspace_ids() to authenticated;
grant execute on function my_staff_id()      to authenticated;
grant execute on function my_role()          to authenticated;

-- --- Layer 2: full slot validation ----------------------------------------
--
-- Internal only (revoked from public, never granted to authenticated —
-- callable solely from inside the SECURITY DEFINER functions below,
-- which already execute as the elevated owner). Called while the caller
-- holds the advisory lock on this staff_id.
--
-- Returns the array of conflicting appointment ids that required
-- p_override_large_job to be true to get past (empty array = clean, no
-- override needed). §1: this NEVER reads any "already overridden" flag
-- on an existing appointment — every call re-evaluates every large-job
-- conflict fresh, so one earlier exception can never silently cover a
-- later, different booking.
create function assert_appointment_slot_available(
  p_staff_id uuid,
  p_appt_date date,
  p_start_time time,
  p_final_duration_min integer,
  p_buffer_minutes integer,
  p_total_amount numeric,
  p_exclude_appointment_id uuid default null,
  p_override_large_job boolean default false
)
returns uuid[]
language plpgsql security definer
set search_path = ''
as $$
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

  -- Local wall-clock throughout, matching appointments.occupied_range.
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

    -- direct overlap: NEVER bypassable, by any override, under any
    -- circumstance — this is what the GiST exclusion constraint also
    -- guarantees at the hard layer regardless of this check.
    if tsrange(v_appt_start, v_appt_end, '[)') && tsrange(v_candidate_start, v_candidate_end, '[)') then
      raise exception 'Conflicts with an existing appointment at %', v_appt.start_time;
    end if;

    -- forward case — always re-evaluated fresh (§1), never skipped
    -- because of anything recorded against v_appt previously
    if v_appt.is_large_job
       and v_candidate_start >= v_appt_start and v_candidate_start < v_day_end_ts
    then
      if not p_override_large_job then
        raise exception 'Blocked by a large-job lock starting % (Master override required)', v_appt.start_time;
      end if;
      v_conflicts := array_append(v_conflicts, v_appt.id);
    end if;

    -- reverse case
    if v_this_is_large and v_appt_start >= v_candidate_start and v_appt_start < v_day_end_ts then
      if not p_override_large_job then
        raise exception 'This large job would block an existing appointment at % (Master override required)', v_appt.start_time;
      end if;
      v_conflicts := array_append(v_conflicts, v_appt.id);
    end if;
  end loop;

  return v_conflicts;
end;
$$;
revoke execute on function assert_appointment_slot_available(uuid, date, time, integer, integer, numeric, uuid, boolean) from public;

-- --- the Appointment Engine ----------------------------------------------

create function create_appointment(
  p_workspace_id uuid,
  p_staff_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_address_line text,
  p_area_city text,
  p_appt_date date,
  p_start_time time,
  p_items jsonb,
  p_final_duration_override_min integer default null,
  p_remarks text default null,
  p_large_job_override_reason text default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
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
      select count(*), min(workspace_id) into v_membership_count, v_derived_workspace
        from public.staff_workspaces
        where staff_id = v_staff_id and is_active;
      if v_membership_count = 0 then
        raise exception 'No active workspace membership';
      elsif v_membership_count > 1 then
        raise exception 'Multiple active workspace memberships — workspace_id is required';
      end if;
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
$$;

-- Non-item, non-duration field edits. Only reachable while 'booked' —
-- completed and cancelled are both terminal (§3).
create function update_appointment(
  p_appointment_id uuid,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_address_line text default null,
  p_area_city text default null,
  p_remarks text default null,
  p_final_duration_override_min integer default null,
  p_large_job_override_reason text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
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

  if v_appt.status <> 'booked' then
    raise exception 'Only a booked appointment can be edited';
  end if;

  if p_final_duration_override_min is not null and p_final_duration_override_min <> v_appt.final_duration_min then
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
    final_duration_min   = coalesce(p_final_duration_override_min, final_duration_min),
    updated_at           = now()
  where id = p_appointment_id;
end;
$$;

-- §4: the only way to change service items. Recomputes total_amount,
-- calculated/final duration, and is_large_job entirely server-side —
-- none of those are parameters a caller (staff or Master) can set
-- directly, mirroring create_appointment. Only reachable while 'booked'.
create function update_appointment_items(
  p_appointment_id uuid,
  p_items jsonb,
  p_final_duration_override_min integer default null,
  p_large_job_override_reason text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
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

  if v_appt.status <> 'booked' then
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
  v_calc_duration := greatest(1, ceil(v_total / v_rate * 60)::int);
  v_final_duration := coalesce(p_final_duration_override_min, v_calc_duration);
  v_is_large := v_total >= v_threshold;

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
end;
$$;

create function reschedule_appointment(
  p_appointment_id uuid,
  p_new_date date,
  p_new_start_time time,
  p_large_job_override_reason text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
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
$$;

-- §3: only from 'booked'. No path exists anywhere in this file that
-- moves a completed or cancelled appointment back to booked.
create function cancel_appointment(
  p_appointment_id uuid,
  p_reason text default null
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.my_role();
  v_appt public.appointments%rowtype;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then raise exception 'Appointment not found'; end if;

  if v_role = 'staff' then
    if v_appt.staff_id is distinct from public.my_staff_id() then
      raise exception 'Not your appointment';
    end if;
  elsif v_role in ('super_master', 'partner_master') then
    if v_appt.workspace_id not in (select * from public.my_workspace_ids()) then
      raise exception 'Not authorized for this workspace';
    end if;
  else
    raise exception 'Not authorized';
  end if;

  if v_appt.status <> 'booked' then
    raise exception 'Only a booked appointment can be cancelled';
  end if;

  update public.appointments
  set status = 'cancelled', remarks = coalesce(p_reason, remarks), updated_at = now()
  where id = p_appointment_id;
end;
$$;

create function mark_appointment_completed(p_appointment_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.my_role();
  v_appt public.appointments%rowtype;
  v_staff_can_complete boolean;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then raise exception 'Appointment not found'; end if;

  if v_role = 'staff' then
    if v_appt.staff_id is distinct from public.my_staff_id() then
      raise exception 'Not your appointment';
    end if;
    select staff_can_mark_completed into v_staff_can_complete from public.business_settings;
    if not coalesce(v_staff_can_complete, true) then
      raise exception 'Staff completion is currently disabled in Settings';
    end if;
  elsif v_role in ('super_master', 'partner_master') then
    if v_appt.workspace_id not in (select * from public.my_workspace_ids()) then
      raise exception 'Not authorized for this workspace';
    end if;
  else
    raise exception 'Not authorized';
  end if;

  if v_appt.status <> 'booked' then
    raise exception 'Only a booked appointment can be marked completed';
  end if;

  update public.appointments set status = 'completed', updated_at = now()
  where id = p_appointment_id;
end;
$$;

-- --- staff schedule mutations — same lock protocol as appointments -------
--
-- §2: everything that can change what "available" means for a staff
-- member takes the SAME pg_advisory_xact_lock(hashtext(staff_id)) before
-- writing, and (where the change could shrink availability) checks for
-- an existing BOOKED appointment that would become inconsistent, and
-- rejects rather than silently orphaning it. Because create_appointment/
-- reschedule_appointment/update_appointment_items take the identical
-- lock, whichever transaction — a new booking or a new time-off entry
-- covering the same staff member — commits SECOND always sees the
-- FIRST's already-committed effect before deciding anything. Direct
-- client writes to staff_time_off/staff_working_hours/staff_workspaces
-- are no longer possible at all (no RLS write policy remains on any of
-- them) — these functions are the only path, exactly like appointments.

create function set_staff_time_off(
  p_staff_id uuid,
  p_off_date date,
  p_start_time time default null,
  p_end_time time default null,
  p_reason text default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.my_role();
  v_id uuid;
begin
  if v_role not in ('super_master', 'partner_master') then
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
$$;

create function remove_staff_time_off(p_time_off_id uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.my_role();
  v_row public.staff_time_off%rowtype;
begin
  if v_role not in ('super_master', 'partner_master') then
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
$$;

create function set_staff_working_hours(
  p_staff_id uuid,   -- null = company default row
  p_day_of_week smallint,
  p_start_time time,
  p_end_time time
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.my_role();
begin
  if p_start_time >= p_end_time then
    raise exception 'start_time must be before end_time';
  end if;

  if p_staff_id is null then
    if v_role <> 'super_master' then
      raise exception 'Only Super Master may set the company default working hours';
    end if;
    -- Company-default narrowing isn't re-validated against every staff
    -- member's existing appointments — see round-5 remaining risks.
  else
    if v_role not in ('super_master', 'partner_master') then
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
$$;

create function set_staff_active(p_staff_id uuid, p_is_active boolean)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.my_role();
begin
  if v_role <> 'super_master' then
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
$$;

create function set_staff_workspace_active(
  p_staff_id uuid,
  p_workspace_id uuid,
  p_is_active boolean
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_role public.user_role := public.my_role();
begin
  if v_role <> 'super_master' then
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
$$;

revoke execute on function create_appointment(uuid, uuid, text, text, text, text, date, time, jsonb, integer, text, text) from public;
revoke execute on function update_appointment(uuid, text, text, text, text, text, integer, text) from public;
revoke execute on function update_appointment_items(uuid, jsonb, integer, text) from public;
revoke execute on function reschedule_appointment(uuid, date, time, text) from public;
revoke execute on function cancel_appointment(uuid, text) from public;
revoke execute on function mark_appointment_completed(uuid) from public;
revoke execute on function set_staff_time_off(uuid, date, time, time, text) from public;
revoke execute on function remove_staff_time_off(uuid) from public;
revoke execute on function set_staff_working_hours(uuid, smallint, time, time) from public;
revoke execute on function set_staff_active(uuid, boolean) from public;
revoke execute on function set_staff_workspace_active(uuid, uuid, boolean) from public;
grant execute on function create_appointment(uuid, uuid, text, text, text, text, date, time, jsonb, integer, text, text) to authenticated;
grant execute on function update_appointment(uuid, text, text, text, text, text, integer, text) to authenticated;
grant execute on function update_appointment_items(uuid, jsonb, integer, text) to authenticated;
grant execute on function reschedule_appointment(uuid, date, time, text) to authenticated;
grant execute on function cancel_appointment(uuid, text) to authenticated;
grant execute on function mark_appointment_completed(uuid) to authenticated;
grant execute on function set_staff_time_off(uuid, date, time, time, text) to authenticated;
grant execute on function remove_staff_time_off(uuid) to authenticated;
grant execute on function set_staff_working_hours(uuid, smallint, time, time) to authenticated;
grant execute on function set_staff_active(uuid, boolean) to authenticated;
grant execute on function set_staff_workspace_active(uuid, uuid, boolean) to authenticated;

-- =========================================================================
-- PART 3 — ROW LEVEL SECURITY
-- =========================================================================

alter table profiles enable row level security;
create policy profiles_self_select on profiles for select using (id = auth.uid());
create policy profiles_master_select_staff on profiles for select using (
  exists (
    select 1 from staff s
    join staff_workspaces sw on sw.staff_id = s.id
    where s.profile_id = profiles.id and sw.is_active
      and sw.workspace_id in (select * from my_workspace_ids())
  )
);

alter table workspaces enable row level security;
create policy workspaces_select on workspaces for select using (
  id in (select * from my_workspace_ids())
);

alter table workspace_masters enable row level security;
create policy workspace_masters_select on workspace_masters for select using (
  profile_id = auth.uid() or workspace_id in (select * from my_workspace_ids())
);

-- staff: Nick keeps read-only SELECT scoped to workspaces he
-- administers; INSERT/UPDATE are super_master only.
alter table staff enable row level security;
create policy staff_master_select on staff for select using (
  exists (
    select 1 from staff_workspaces sw
    where sw.staff_id = staff.id and sw.is_active
      and sw.workspace_id in (select * from my_workspace_ids())
  )
);
create policy staff_self_select on staff for select using (profile_id = auth.uid());
create policy staff_super_master_insert on staff for insert with check (my_role() = 'super_master');
create policy staff_super_master_update on staff for update using (my_role() = 'super_master');

-- staff_workspaces: SELECT only. All writes — new membership, ending a
-- membership — go through set_staff_workspace_active() (§2), never a
-- direct table write, so membership changes always take the advisory
-- lock and check for conflicting booked appointments first.
alter table staff_workspaces enable row level security;
create policy staff_workspaces_select on staff_workspaces for select using (
  workspace_id in (select * from my_workspace_ids())
  or staff_id = my_staff_id()
);

-- staff_working_hours: SELECT only. Writes go through
-- set_staff_working_hours() (§2).
alter table staff_working_hours enable row level security;
create policy working_hours_select on staff_working_hours for select using (
  auth.uid() is not null and (
    staff_id is null
    or exists (
      select 1 from staff_workspaces sw
      where sw.staff_id = staff_working_hours.staff_id and sw.is_active
        and sw.workspace_id in (select * from my_workspace_ids())
    )
    or staff_id = my_staff_id()
  )
);

-- staff_time_off: SELECT only. Writes go through set_staff_time_off() /
-- remove_staff_time_off() (§2).
alter table staff_time_off enable row level security;
create policy time_off_select on staff_time_off for select using (
  exists (
    select 1 from staff_workspaces sw
    where sw.staff_id = staff_time_off.staff_id and sw.is_active
      and sw.workspace_id in (select * from my_workspace_ids())
  )
  or staff_id = my_staff_id()
);

alter table monthly_staff_targets enable row level security;
create policy targets_master_all on monthly_staff_targets for all using (
  exists (
    select 1 from staff_workspaces sw
    where sw.staff_id = monthly_staff_targets.staff_id and sw.is_active
      and sw.workspace_id in (select * from my_workspace_ids())
  )
) with check (
  exists (
    select 1 from staff_workspaces sw
    where sw.staff_id = monthly_staff_targets.staff_id and sw.is_active
      and sw.workspace_id in (select * from my_workspace_ids())
  )
);

alter table suggested_time_slots enable row level security;
create policy slots_select on suggested_time_slots for select using (
  auth.uid() is not null and (workspace_id is null or workspace_id in (select * from my_workspace_ids()))
);
create policy slots_write on suggested_time_slots for all using (
  (workspace_id is null and my_role() = 'super_master')
  or (workspace_id is not null and workspace_id in (select * from my_workspace_ids()))
) with check (
  (workspace_id is null and my_role() = 'super_master')
  or (workspace_id is not null and workspace_id in (select * from my_workspace_ids()))
);

alter table business_settings enable row level security;
create policy settings_select on business_settings for select using (
  my_role() in ('super_master', 'partner_master')
);
create policy settings_super_master_write on business_settings for all using (
  my_role() = 'super_master'
) with check (
  my_role() = 'super_master'
);

-- appointments: no insert/update policy — see PART 2.
alter table appointments enable row level security;
create policy appointments_master_select on appointments for select using (
  workspace_id in (select * from my_workspace_ids())
);
create policy appointments_staff_select on appointments for select using (
  staff_id = my_staff_id()
);

create function enforce_appointment_workspace_move()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    if public.my_role() is distinct from 'super_master'::public.user_role then
      raise exception 'Moving an appointment to a different workspace requires Super Master (D4)';
    end if;
  end if;
  return new;
end;
$$;
create trigger trg_enforce_appointment_workspace_move
  before update on appointments
  for each row
  execute function enforce_appointment_workspace_move();

create function log_appointment_audit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_action text;
  v_actor uuid := auth.uid();
  v_actor_label text := case when auth.uid() is null then 'SYSTEM' else null end;
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs (actor_profile_id, actor_label, action_type, entity_type, entity_id, workspace_id, before_json, after_json, created_at)
    values (v_actor, v_actor_label, 'appointment.created', 'appointment', new.id, new.workspace_id, null, to_jsonb(new), now());
    return new;
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    v_action := 'appointment.cancelled';
  elsif new.status = 'completed' and old.status is distinct from 'completed' then
    v_action := 'appointment.completed';
  elsif new.staff_id is distinct from old.staff_id then
    v_action := 'appointment.reassigned';
  elsif new.workspace_id is distinct from old.workspace_id then
    v_action := 'appointment.workspace_moved';
  elsif new.appt_date is distinct from old.appt_date or new.start_time is distinct from old.start_time then
    v_action := 'appointment.rescheduled';
  elsif new.total_amount is distinct from old.total_amount then
    v_action := 'appointment.items_updated';
  else
    v_action := 'appointment.updated';
  end if;

  insert into public.audit_logs (actor_profile_id, actor_label, action_type, entity_type, entity_id, workspace_id, before_json, after_json, created_at)
  values (v_actor, v_actor_label, v_action, 'appointment', new.id, new.workspace_id, to_jsonb(old), to_jsonb(new), now());
  return new;
end;
$$;
create trigger trg_log_appointment_audit
  after insert or update on appointments
  for each row
  execute function log_appointment_audit();

alter table appointment_items enable row level security;
create policy appointment_items_select on appointment_items for select using (
  exists (
    select 1 from appointments a
    where a.id = appointment_items.appointment_id
      and (a.workspace_id in (select * from my_workspace_ids()) or a.staff_id = my_staff_id())
  )
);

-- appointment_rule_overrides: SELECT only, scoped via the subject
-- appointment's own access rules. Written only by the Appointment
-- Engine functions above (SECURITY DEFINER); no client write policy.
alter table appointment_rule_overrides enable row level security;
create policy rule_overrides_select on appointment_rule_overrides for select using (
  exists (
    select 1 from appointments a where a.id = subject_appointment_id
      and (a.workspace_id in (select * from my_workspace_ids()) or a.staff_id = my_staff_id())
  )
);

create function log_rule_override_audit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (actor_profile_id, actor_label, action_type, entity_type, entity_id, workspace_id, before_json, after_json, reason, created_at)
  select
    case when auth.uid() is null then null else auth.uid() end,
    case when auth.uid() is null then 'SYSTEM' else null end,
    'appointment.large_job_override_granted', 'appointment', new.subject_appointment_id,
    a.workspace_id, null, to_jsonb(new), new.reason, now()
  from public.appointments a where a.id = new.subject_appointment_id;
  return new;
end;
$$;
create trigger trg_log_rule_override_audit
  after insert on appointment_rule_overrides
  for each row
  execute function log_rule_override_audit();

alter table audit_logs enable row level security;
create policy audit_select on audit_logs for select using (
  my_role() in ('super_master', 'partner_master')
  and (workspace_id is null or workspace_id in (select * from my_workspace_ids()))
);

-- =========================================================================
-- PART 4 — anon lockdown
-- =========================================================================
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
