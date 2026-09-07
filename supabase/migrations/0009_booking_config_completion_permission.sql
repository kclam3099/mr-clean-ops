-- 0009_booking_config_completion_permission.sql
--
-- Narrow gap found while auditing the appointment lifecycle for F3.
--
-- mark_appointment_completed enforces a company setting for staff callers:
--
--     if v_role = 'staff' then
--       ...
--       select staff_can_mark_completed into v_staff_can_complete
--         from public.business_settings;
--       if not coalesce(v_staff_can_complete, false) then
--         raise exception 'Staff completion is currently disabled in Settings';
--
-- But staff cannot read business_settings (verified: TEST_JACK sees 0 rows),
-- and get_booking_config() did not return the flag. So the staff UI had no
-- honest way to decide whether to render a Complete action — it could only
-- render the button unconditionally and let the RPC refuse, which is exactly
-- the "hard-code permission because the button exists" pattern we want to avoid.
--
-- Fix: return the flag from the existing narrow config RPC. business_settings
-- table RLS is NOT widened; this exposes one boolean that the caller's own
-- capability already depends on, and nothing else.
--
-- Still deliberately excluded from this RPC:
--   full_day_lock_threshold  the UI must not pre-judge whether an override is
--                            needed; the server decides from real conflicts
--   default_day_start/end    staff-specific hours override them, so company
--                            defaults would mislead
--   wa_reminder_template_*   unrelated to booking or completion
--
-- The return type changes, so the function is dropped and recreated rather than
-- replaced. Does not modify 0001-0008 and changes no business rule: the
-- authority for completion remains mark_appointment_completed itself.

drop function if exists public.get_booking_config();

create function public.get_booking_config()
returns table (
  rm_per_hour_rate                          numeric,
  default_buffer_minutes                    integer,
  default_availability_job_duration_minutes integer,
  staff_can_mark_completed                  boolean
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_role public.user_role := public.my_role();
begin
  -- An authenticated account without a profile has no capability anywhere else
  -- either; it does not get configuration.
  if auth.uid() is null or v_role is null then
    raise exception 'Not authorized';
  end if;

  return query
    select bs.rm_per_hour_rate,
           bs.default_buffer_minutes,
           bs.default_availability_job_duration_minutes,
           bs.staff_can_mark_completed
      from public.business_settings bs;
end;
$function$;

revoke execute on function public.get_booking_config() from public;
revoke execute on function public.get_booking_config() from anon;
grant  execute on function public.get_booking_config() to authenticated;
