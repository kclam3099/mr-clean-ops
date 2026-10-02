-- 0011 — first-login password change
--
-- Staff are given an opening password by a manager (their phone number, which
-- is printed on the company's own vans). That is acceptable as a one-time
-- handover credential and unacceptable as a standing one, so this adds the
-- flag that makes the difference: an account opened this way cannot reach any
-- page until its owner has chosen a new password.
--
-- Why a SECURITY DEFINER function rather than an UPDATE policy on profiles:
-- Postgres row level security grants a row, not a column. A policy permitting
-- `profiles.id = auth.uid()` for UPDATE would let any staff member set their
-- own `role` to 'super_master' in the same statement that cleared this flag.
-- The function below can touch exactly one column and nothing else, which is
-- the property actually wanted here.
--
-- profiles still has no UPDATE policy after this migration. That is deliberate.

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

comment on column public.profiles.must_change_password is
  'Set when a manager issues an opening password. Cleared only by '
  'public.complete_password_change(), after Auth has accepted a new password.';

-- Clears the caller's OWN flag, and only the flag.
--
-- It does not change the password: that is Auth's job, and it has already
-- happened by the time this is called. This records that it happened.
--
-- Callable by any signed-in user, because it can only ever affect the row
-- belonging to the caller. An unauthenticated call updates nothing — auth.uid()
-- is null and matches no row — rather than erroring, so the function leaks
-- nothing about which ids exist.
create or replace function public.complete_password_change()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.profiles
     set must_change_password = false
   where id = auth.uid();
$$;

revoke all on function public.complete_password_change() from public;
grant execute on function public.complete_password_change() to authenticated;

-- Deliberately NOT granted to anon. A caller with no session has no row to
-- clear, and exposing the entry point to unauthenticated traffic only widens
-- what can be probed.
