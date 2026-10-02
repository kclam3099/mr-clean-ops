-- 0012 — daily staff acknowledgement
--
-- Answers one question for a Master at the start of the day: has each of my
-- people actually seen what they are doing today, and did they see it before
-- the 08:00 start?
--
-- An acknowledgement is a staff member confirming, for one business date, that
-- they have looked at their own agenda. It is not a login: a login proves a
-- phone was unlocked, not that anybody read anything.
--
-- VISIBILITY. This table inherits the rule the whole app is built on — a
-- Master sees only the staff in workspaces they administer. Nick must not learn
-- that Victor exists, so he must not see a Victor row here either, green, red
-- or grey. The SELECT policy mirrors profiles_master_select_workspace_staff
-- exactly rather than inventing a second idea of who is visible, because two
-- ideas are two chances to drift apart.
--
-- The date is business-local. A row for "today" has to mean today in Kuala
-- Lumpur, not today in UTC, or every acknowledgement made between 00:00 and
-- 08:00 local would be filed against the previous day.

create table if not exists public.staff_day_acknowledgements (
  id              uuid primary key default gen_random_uuid(),
  staff_id        uuid not null references public.staff(id) on delete cascade,
  ack_date        date not null,
  acknowledged_at timestamptz not null default now(),

  -- One acknowledgement per person per day. Tapping the button twice is not an
  -- error and must not create a second row that could disagree about the time.
  constraint staff_day_acknowledgements_once unique (staff_id, ack_date)
);

comment on table public.staff_day_acknowledgements is
  'One row per staff member per business date, recorded when they confirm they '
  'have seen that day''s agenda. Written only by public.acknowledge_day().';

create index if not exists staff_day_acknowledgements_date_idx
  on public.staff_day_acknowledgements (ack_date, staff_id);

alter table public.staff_day_acknowledgements enable row level security;

-- A staff member sees their own acknowledgements.
create policy staff_day_ack_self_select
  on public.staff_day_acknowledgements for select
  using (staff_id = public.my_staff_id());

-- A Master sees acknowledgements for staff active in a workspace they
-- administer, and for nobody else. Same shape as the profiles policy.
create policy staff_day_ack_master_select
  on public.staff_day_acknowledgements for select
  using (
    exists (
      select 1
        from public.staff_workspaces sw
       where sw.staff_id = staff_day_acknowledgements.staff_id
         and sw.is_active
         and sw.workspace_id in (select public.my_workspace_ids())
    )
  );

-- No INSERT, UPDATE or DELETE policy, deliberately.
--
-- Writing is only possible through acknowledge_day() below, which derives the
-- staff id from the session. An INSERT policy — even one checking
-- `staff_id = my_staff_id()` — would also let a staff member choose ack_date
-- and backdate an acknowledgement for a morning they slept through.

create or replace function public.acknowledge_day()
returns date
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_staff_id uuid := public.my_staff_id();
  v_today    date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  if v_staff_id is null then
    -- A Master has no staff row and nothing to acknowledge. Raising here keeps
    -- the failure visible rather than silently writing nothing.
    raise exception 'no staff identity for this caller'
      using errcode = 'insufficient_privilege';
  end if;

  -- Both the staff id and the date come from the server. Nothing the caller
  -- sends can choose whose day is acknowledged, or which one.
  insert into public.staff_day_acknowledgements (staff_id, ack_date)
  values (v_staff_id, v_today)
  on conflict (staff_id, ack_date) do nothing;

  return v_today;
end;
$$;

revoke all on function public.acknowledge_day() from public;
grant execute on function public.acknowledge_day() to authenticated;
