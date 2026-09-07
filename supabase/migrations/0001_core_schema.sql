-- 0001_core_schema.sql
-- Matches: Blueprint v0.2 §E (Database schema) and Phase 1 Build Plan §1B.
-- NOT YET APPLIED to any project — prepared for review per the Step 1 lock
-- ("show me the exact migration before running it"). Do not run
-- `supabase db push` against mr-clean-ops until this is approved.

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists btree_gist; -- required by the exclusion constraint below

create type user_role as enum ('super_master', 'partner_master', 'staff');
create type appointment_status as enum ('booked', 'completed', 'cancelled');

-- One row per login identity, regardless of role.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role user_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Real teams only — "All Operations" is a virtual view, never a row here
-- (Blueprint v0.2 §D).
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

-- Who administers which workspace (Super Master, Partner Master).
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
  home_base_area text,               -- simple string match for V1 recommendation scoring
  home_base_lat numeric(9,6),
  home_base_lng numeric(9,6),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Many-to-many: a staff member can belong to more than one workspace.
create table staff_workspaces (
  staff_id     uuid not null references staff(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  primary key (staff_id, workspace_id)
);
create index idx_staff_workspaces_workspace on staff_workspaces (workspace_id);

-- day_of_week null = every day; staff_id null = company default row.
create table staff_working_hours (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id) on delete cascade,
  day_of_week smallint check (day_of_week between 0 and 6),
  start_time time not null,
  end_time   time not null,
  constraint chk_working_hours_order check (start_time < end_time)
);

-- start_time/end_time both null = full-day OFF.
create table staff_time_off (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  off_date date not null,
  start_time time,
  end_time time,
  reason text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);
create index idx_staff_time_off_staff_date on staff_time_off (staff_id, off_date);

create table monthly_staff_targets (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  year integer not null,
  month smallint not null check (month between 1 and 12),
  target_amount numeric(10,2) not null,
  unique (staff_id, year, month)
);

-- workspace_id null = global default slot list.
create table suggested_time_slots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  slot_time time not null,
  sort_order smallint not null default 0,
  is_active boolean not null default true
);

-- Singleton row (id is always `true`) — Super Master only, per Blueprint §C.
create table business_settings (
  id boolean primary key default true check (id),
  rm_per_hour_rate numeric(10,2) not null default 200,
  full_day_lock_threshold numeric(10,2) not null default 600,
  default_availability_job_duration_minutes integer not null default 60,
  default_buffer_minutes integer not null default 30,
  default_day_start time not null default '09:00',
  default_day_end   time not null default '19:00',
  staff_can_mark_completed boolean not null default true,
  wa_reminder_template_zh text not null default '',
  wa_reminder_template_en text not null default '',
  wa_reminder_template_ms text not null default '',
  updated_at timestamptz not null default now()
);

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
  calculated_duration_min integer not null,
  final_duration_min integer not null,
  total_amount numeric(10,2) not null default 0,
  is_large_job boolean not null default false,               -- frozen at write time, see Blueprint §E note
  large_job_lock_overridden boolean not null default false,
  large_job_override_by uuid references profiles(id),
  large_job_override_at timestamptz,
  large_job_override_reason text,
  status appointment_status not null default 'booked',
  remarks text,
  created_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Used only by the exclusion constraint below (Phase 1 Build Plan §1F).
  occupied_range tstzrange generated always as (
    tstzrange(
      (appt_date + start_time) at time zone 'Asia/Kuala_Lumpur',
      (appt_date + start_time) at time zone 'Asia/Kuala_Lumpur'
        + (final_duration_min || ' minutes')::interval,
      '[)'
    )
  ) stored
);

-- Hard backstop: makes real double-booking impossible at the database
-- level, independent of any application-level check (Phase 1 Build Plan §1F).
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
  quantity integer not null default 1,
  unit_price numeric(10,2) not null,
  line_total numeric(10,2) generated always as (quantity * unit_price) stored
);
create index idx_appointment_items_appointment on appointment_items (appointment_id);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references profiles(id),
  action_type text not null,       -- e.g. 'appointment.override_large_job_lock'
  entity_type text not null,       -- 'appointment' | 'staff' | 'workspace' | ...
  entity_id uuid not null,
  workspace_id uuid references workspaces(id),   -- denormalized for RLS filtering
  before_json jsonb,
  after_json jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index idx_audit_logs_workspace_created on audit_logs (workspace_id, created_at desc);

-- Row Level Security is enabled in migration 0002 (Phase 1 Build Plan §1C),
-- reviewed and applied separately — not part of this schema migration.
