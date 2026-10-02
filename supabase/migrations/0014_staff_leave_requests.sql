-- 0014 — staff leave requests
--
-- A staff member asks for leave; a Master approves or rejects it. Approval
-- writes the actual staff_time_off rows, so an approved day blocks bookings
-- through the engine exactly as a Master-entered day off always has.
--
-- WHO APPROVES. Any Master who administers a workspace the staff member is an
-- active member of — the same rule set_staff_time_off already enforces. Nothing
-- names a person: Victor, whose only workspace is KC Private Team, can be
-- approved by KC alone; Dyron and Jack, in Shared Team, by KC or Nick.
-- Membership decides, and changes with it.
--
-- VISIBILITY. A request is visible to the staff member and to those same
-- Masters, using the predicate of time_off_select. Nick does not learn that
-- Victor asked for leave — or that Victor exists.
--
-- NO audit_logs ROWS. audit_logs is scoped by one workspace_id, and a leave
-- request belongs to a person, not a workspace; a NULL workspace_id would show
-- the row to every Master. The request row keeps its own trail instead
-- (requested_at, decided_by, decided_at).
--
-- WRITES go only through the functions below. There is no INSERT/UPDATE/DELETE
-- policy: a policy would let a staff member set their own status to approved.

create table if not exists public.staff_leave_requests (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references public.staff(id) on delete cascade,
  start_date    date not null,
  end_date      date not null,
  -- Both null = full day(s). Both set = part of a single day.
  start_time    time,
  end_time      time,
  reason        text check (reason is null or char_length(reason) <= 300),
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by  uuid not null references public.profiles(id),
  requested_at  timestamptz not null default now(),
  decided_by    uuid references public.profiles(id),
  decided_at    timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 300),
  constraint staff_leave_dates_order check (end_date >= start_date),
  constraint staff_leave_span check (end_date - start_date <= 31),
  constraint staff_leave_times check (
    (start_time is null and end_time is null)
    or (start_time is not null and end_time is not null
        and start_time < end_time and start_date = end_date)
  )
);

comment on table public.staff_leave_requests is
  'Leave asked for by a staff member, decided by a Master of one of their '
  'workspaces. Approval writes staff_time_off. Written only by '
  'request_leave / cancel_leave_request / decide_leave_request.';

create index if not exists staff_leave_requests_staff_idx
  on public.staff_leave_requests (staff_id, start_date);
create index if not exists staff_leave_requests_pending_idx
  on public.staff_leave_requests (status) where status = 'pending';

alter table public.staff_leave_requests enable row level security;

create policy staff_leave_requests_select
  on public.staff_leave_requests for select
  using (
    staff_id = public.my_staff_id()
    or exists (
      select 1 from public.staff_workspaces sw
       where sw.staff_id = staff_leave_requests.staff_id
         and sw.is_active
         and sw.workspace_id in (select public.my_workspace_ids())
    )
  );

revoke all on public.staff_leave_requests from anon;

-- ---------------------------------------------------------------------------
-- request_leave — the caller asks for their own leave. The staff id comes from
-- the session; nothing the caller sends can file a request for someone else.
-- ---------------------------------------------------------------------------
create or replace function public.request_leave(
  p_start_date date,
  p_end_date   date,
  p_start_time time default null,
  p_end_time   time default null,
  p_reason     text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff_id uuid := public.my_staff_id();
  v_today    date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id       uuid;
begin
  if auth.uid() is null or v_staff_id is null then
    raise exception 'Not authorized';
  end if;

  if p_start_date is null or p_end_date is null or p_end_date < p_start_date
     or p_end_date - p_start_date > 31 then
    raise exception 'Leave dates are invalid';
  end if;

  if p_start_date < v_today then
    raise exception 'Leave must start today or later';
  end if;

  if (p_start_time is null) <> (p_end_time is null)
     or (p_start_time is not null and (p_start_time >= p_end_time or p_start_date <> p_end_date)) then
    raise exception 'Leave times are invalid';
  end if;

  if v_reason is not null and char_length(v_reason) > 300 then
    raise exception 'Leave dates are invalid';
  end if;

  -- One live request per day. A second request for the same dates is almost
  -- always a double tap, and two approvals would write two time-off rows.
  if exists (
    select 1 from public.staff_leave_requests r
     where r.staff_id = v_staff_id
       and r.status in ('pending', 'approved')
       and daterange(r.start_date, r.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) then
    raise exception 'A leave request already covers those dates';
  end if;

  insert into public.staff_leave_requests
    (staff_id, start_date, end_date, start_time, end_time, reason, requested_by)
  values
    (v_staff_id, p_start_date, p_end_date, p_start_time, p_end_time, v_reason, auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_leave_request — the staff member withdraws their own pending request.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_leave_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.staff_leave_requests%rowtype;
begin
  if auth.uid() is null or public.my_staff_id() is null then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.staff_leave_requests
   where id = p_request_id
   for update;

  if not found or v_row.staff_id <> public.my_staff_id() then
    raise exception 'Not authorized';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'This leave request has already been decided';
  end if;

  update public.staff_leave_requests
     set status = 'cancelled', decided_at = now(), decided_by = auth.uid()
   where id = v_row.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- decide_leave_request — a Master of one of the staff member's workspaces
-- approves or rejects. Approval writes one staff_time_off row per day through
-- set_staff_time_off, so the existing rules apply unchanged: a day with a
-- booked appointment refuses the whole approval (nothing is written), and an
-- appointment the Master cannot see is reported only as STAFF_UNAVAILABLE.
-- ---------------------------------------------------------------------------
create or replace function public.decide_leave_request(
  p_request_id uuid,
  p_approve    boolean,
  p_note       text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  public.staff_leave_requests%rowtype;
  v_role public.user_role := public.my_role();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_day  date;
begin
  if auth.uid() is null
     or v_role is null
     or (v_role is distinct from 'super_master'::public.user_role
         and v_role is distinct from 'partner_master'::public.user_role) then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.staff_leave_requests
   where id = p_request_id
   for update;

  -- Missing and not-yours are the same answer, so the id cannot be used to
  -- probe for staff in a workspace this Master does not administer.
  if not found or not exists (
    select 1 from public.staff_workspaces sw
     where sw.staff_id = v_row.staff_id
       and sw.is_active
       and sw.workspace_id in (select public.my_workspace_ids())
  ) then
    raise exception 'Not authorized';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'This leave request has already been decided';
  end if;

  if v_note is not null and char_length(v_note) > 300 then
    raise exception 'Leave dates are invalid';
  end if;

  if p_approve then
    for v_day in
      select d::date from generate_series(v_row.start_date, v_row.end_date, interval '1 day') d
    loop
      -- A full day already off needs no second row.
      continue when v_row.start_time is null and exists (
        select 1 from public.staff_time_off t
         where t.staff_id = v_row.staff_id and t.off_date = v_day and t.start_time is null
      );
      perform public.set_staff_time_off(
        v_row.staff_id, v_day, v_row.start_time, v_row.end_time,
        coalesce('Leave: ' || v_row.reason, 'Leave')
      );
    end loop;
  end if;

  update public.staff_leave_requests
     set status        = case when p_approve then 'approved' else 'rejected' end,
         decided_by    = auth.uid(),
         decided_at    = now(),
         decision_note = v_note
   where id = v_row.id;
end;
$$;

revoke all on function public.request_leave(date, date, time, time, text) from public;
revoke all on function public.request_leave(date, date, time, time, text) from anon;
grant execute on function public.request_leave(date, date, time, time, text) to authenticated;

revoke all on function public.cancel_leave_request(uuid) from public;
revoke all on function public.cancel_leave_request(uuid) from anon;
grant execute on function public.cancel_leave_request(uuid) to authenticated;

revoke all on function public.decide_leave_request(uuid, boolean, text) from public;
revoke all on function public.decide_leave_request(uuid, boolean, text) from anon;
grant execute on function public.decide_leave_request(uuid, boolean, text) to authenticated;
