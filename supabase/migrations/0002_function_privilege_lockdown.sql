-- 0002_function_privilege_lockdown.sql
-- Fixes the two defects found in post-migration verification of 0001:
--   1. assert_appointment_slot_available (the internal Layer 2 validator)
--      was callable directly by both `authenticated` and `anon` —
--      REVOKE ... FROM public in 0001 does not remove Supabase's direct
--      grants to anon/authenticated, since those roles are not members
--      of the PUBLIC pseudo-role in the way that revoke assumed.
--   2. `anon` held EXECUTE on every function in public, including every
--      Appointment/Staff Engine RPC — 0001's anon lockdown (PART 4)
--      only revoked TABLE privileges, never touched FUNCTION privileges.
--
-- Verified empirically before writing this file (not assumed):
--   - Migrations run as role `postgres` (current_user = session_user =
--     'postgres' during db push) — this is the creating role ALTER
--     DEFAULT PRIVILEGES targets below.
--   - All 18 functions from 0001 are owned by `postgres`; zero overloads
--     exist (pg_proc grouped by proname, all counts = 1) — the argument
--     lists below are the actual pg_get_function_identity_arguments()
--     output for this database, not assumed from the migration source.
--   - Revoking EXECUTE from `authenticated` on every function in public
--     — including btree_gist's internal gbt_*/gbtreekey*_in/out support
--     functions — does NOT break appointment writes: create_appointment()
--     is SECURITY DEFINER, so for its entire execution (including the
--     INSERT that exercises the GiST exclusion constraint) the effective
--     role is its owner, postgres, never the original caller. Tested via
--     a real create_appointment() call as `authenticated` with every
--     public function's EXECUTE revoked except the 4 it needs, inside a
--     transaction that was rolled back.
--
-- No table, RLS policy, or data change of any kind — function/schema
-- privileges only.

-- =========================================================================
-- 1. Reset: nothing is callable merely because Postgres/Supabase granted
--    it by default. Applies to every function currently in public,
--    including 0001's own and the btree_gist extension's internals.
-- =========================================================================
revoke execute on all functions in schema public from public, anon, authenticated;

-- =========================================================================
-- 2. Explicit allowlist — `authenticated` only, nothing to `anon`.
--    Exact signatures per pg_get_function_identity_arguments(), verified
--    against this database above.
-- =========================================================================

-- Identity / RLS helpers — required by authenticated RLS evaluation,
-- identity-bound (each reads exactly auth.uid()'s own rows).
grant execute on function public.my_workspace_ids() to authenticated;
grant execute on function public.my_staff_id() to authenticated;
grant execute on function public.my_role() to authenticated;

-- Appointment / Staff Engine RPCs — the only intended client API surface.
grant execute on function public.create_appointment(
  uuid, uuid, text, text, text, text, date, time, jsonb, integer, text, text
) to authenticated;
grant execute on function public.update_appointment(
  uuid, text, text, text, text, text, integer, text
) to authenticated;
grant execute on function public.update_appointment_items(
  uuid, jsonb, integer, text
) to authenticated;
grant execute on function public.reschedule_appointment(
  uuid, date, time, text
) to authenticated;
grant execute on function public.cancel_appointment(
  uuid, text
) to authenticated;
grant execute on function public.mark_appointment_completed(
  uuid
) to authenticated;
grant execute on function public.set_staff_time_off(
  uuid, date, time, time, text
) to authenticated;
grant execute on function public.remove_staff_time_off(
  uuid
) to authenticated;
grant execute on function public.set_staff_working_hours(
  uuid, smallint, time, time
) to authenticated;
grant execute on function public.set_staff_active(
  uuid, boolean
) to authenticated;
grant execute on function public.set_staff_workspace_active(
  uuid, uuid, boolean
) to authenticated;

-- =========================================================================
-- 3. Deliberately NOT granted to anyone — stay revoked from both anon
--    and authenticated after the blanket reset above:
--      - assert_appointment_slot_available(...)  — internal Layer 2
--        validator; called only from inside the SECURITY DEFINER engine
--        functions above, which reach it as their owner (postgres),
--        never needing a direct grant of their own.
--      - enforce_appointment_workspace_move()     — D4 trigger function
--      - log_appointment_audit()                  — audit trigger function
--      - log_rule_override_audit()                — audit trigger function
--    The three trigger functions return `trigger`, which Postgres
--    refuses to let any role call directly regardless of grants — but
--    they're covered by the blanket revoke too now, for a consistent,
--    defense-in-depth story rather than relying on that return-type
--    restriction alone.
-- =========================================================================

-- =========================================================================
-- 4. Future functions: the creating role for every migration is
--    `postgres` (verified above) — this is the role ALTER DEFAULT
--    PRIVILEGES must target for it to apply to what future migrations
--    create. A future migration that intentionally adds a new public RPC
--    must explicitly GRANT EXECUTE TO authenticated for it; nothing is
--    reachable by default anymore.
-- =========================================================================
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
