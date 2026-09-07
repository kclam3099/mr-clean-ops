-- 0005_cross_workspace_override_privacy.sql
--
-- Closes a cross-workspace information leak in the large-job override audit
-- trail, found by the Stage 3B suite.
--
-- BACKGROUND
-- A large-job override row describes a RELATIONSHIP between two appointments:
--   subject_appointment_id      — the booking being granted an exception
--   conflicting_appointment_id  — the locking job the exception is granted against
-- Those two appointments may live in DIFFERENT workspaces, because physical
-- staff availability is global while information visibility is workspace-scoped.
--
-- Both surfaces authorised on the SUBJECT side only:
--   1. appointment_rule_overrides.rule_overrides_select
--   2. audit_logs.audit_select, for rows written by log_rule_override_audit(),
--      which stamps workspace_id from the SUBJECT appointment and stores the
--      whole override row (including conflicting_appointment_id and the reason
--      free text) in after_json.
--
-- Effect: a Shared-Team-only Master could learn that a hidden appointment
-- exists, its id, that it is classified >= the large-job threshold, and read
-- the override reason text written about it. Migration 0004 closed the same
-- disclosure in the engine's error messages; these two read paths remained.
--
-- PRINCIPLE APPLIED
-- Visibility of an event describing multiple protected objects is bounded by
-- the MOST RESTRICTIVE object involved. Applied narrowly to override rows and
-- override audit events; the general audit boundary is left unchanged.
--
-- NOT DONE ON PURPOSE
-- The audit payload is not redacted at write time. Redacting would damage the
-- audit record for the Masters who are authorised to see both endpoints. The
-- correction belongs in the read path.
--
-- Does not modify 0001-0004. Does not change scheduling semantics.

-- ---------------------------------------------------------------------------
-- 1. appointment_rule_overrides — both endpoints must be visible, Masters only
-- ---------------------------------------------------------------------------
-- V1: this is an internal Master/audit surface. Staff do not read override
-- reasons or override history from the normal appointment UI, so the staff
-- branch (staff_id = my_staff_id()) is removed rather than extended.
--
-- Fail-closed by construction: my_role() null -> coalesce false; a null
-- conflicting_appointment_id matches no row -> exists false -> hidden.

drop policy if exists rule_overrides_select on public.appointment_rule_overrides;

create policy rule_overrides_select on public.appointment_rule_overrides
for select using (
  coalesce(
    public.my_role() = any (array['super_master'::public.user_role,
                                  'partner_master'::public.user_role]),
    false
  )
  and exists (
    select 1 from public.appointments a
    where a.id = appointment_rule_overrides.subject_appointment_id
      and a.workspace_id in (select * from public.my_workspace_ids())
  )
  and exists (
    select 1 from public.appointments c
    where c.id = appointment_rule_overrides.conflicting_appointment_id
      and c.workspace_id in (select * from public.my_workspace_ids())
  )
);

-- ---------------------------------------------------------------------------
-- 2. audit_logs — bound override events by the conflicting appointment too
-- ---------------------------------------------------------------------------
-- Every clause of the previous policy is preserved verbatim; one additional
-- conjunct applies ONLY to 'appointment.large_job_override_granted' rows, so no
-- other audit event's visibility changes.
--
-- The conflicting id is read out of after_json. The uuid cast is wrapped in a
-- CASE guard so a malformed value can never raise inside a policy: CASE has
-- defined evaluation order, unlike a bare AND, and yields NULL (matching no
-- row, therefore hidden) instead of erroring.

drop policy if exists audit_select on public.audit_logs;

create policy audit_select on public.audit_logs
for select using (
  coalesce(
    public.my_role() = any (array['super_master'::public.user_role,
                                  'partner_master'::public.user_role]),
    false
  )
  and (
    workspace_id is null
    or workspace_id in (select * from public.my_workspace_ids())
  )
  and (
    action_type <> 'appointment.large_job_override_granted'
    or exists (
      select 1 from public.appointments c
      where c.id = case
              when audit_logs.after_json->>'conflicting_appointment_id'
                   ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then (audit_logs.after_json->>'conflicting_appointment_id')::uuid
            end
        and c.workspace_id in (select * from public.my_workspace_ids())
    )
  )
);

-- ---------------------------------------------------------------------------
-- 3. Integrity — a forward-lock override must name its conflicting appointment
-- ---------------------------------------------------------------------------
-- The two-endpoint visibility model above is only meaningful if the second
-- endpoint is always present. Verified before writing this migration: all 11
-- existing rows are rule_type = 'large_job_forward_lock' with a non-null
-- conflicting_appointment_id, so this constraint validates against current data.
--
-- A row that violated it would be invisible to everyone under the new policy
-- (fail-closed), so this constraint prevents silently unreadable audit rows
-- rather than granting anything.

alter table public.appointment_rule_overrides
  add constraint rule_overrides_conflicting_required
  check (
    rule_type <> 'large_job_forward_lock'
    or conflicting_appointment_id is not null
  );
