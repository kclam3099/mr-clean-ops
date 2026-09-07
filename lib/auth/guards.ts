import "server-only";
import { createClient } from "@/lib/supabase/serverClient";

/**
 * Server Action authorization guards (Blueprint v0.2 §F, Phase 1 Build
 * Plan §1C) — defense in depth on top of RLS, not a replacement for it.
 * A client-supplied workspaceId is never trusted on its own; both guards
 * re-derive what the caller is actually allowed to touch from the
 * database, using the caller's own session (so RLS still applies to the
 * lookup itself).
 *
 * Untestable until migration 0001 + RLS are applied and a seeded profile
 * exists — implemented now so Server Actions have a single, shared place
 * to call rather than reimplementing this check per action.
 */

export class UnauthorizedError extends Error {
  constructor(message = "Not authorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Throws unless the signed-in caller is a Master with access to workspaceId. */
export async function requireMasterFor(workspaceId: string): Promise<{ profileId: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new UnauthorizedError("Not signed in");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .single();
  if (!profile?.is_active || profile.role === "staff") {
    throw new UnauthorizedError("Not a Master");
  }

  const { data: membership } = await supabase
    .from("workspace_masters")
    .select("workspace_id")
    .eq("workspace_id", workspaceId)
    .eq("profile_id", user.id)
    .maybeSingle();
  if (!membership) throw new UnauthorizedError("No access to this workspace");

  return { profileId: user.id };
}

/** Throws unless the signed-in caller is the staff member assigned to appointmentId. */
export async function requireStaffOwns(appointmentId: string): Promise<{ profileId: string; staffId: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new UnauthorizedError("Not signed in");

  const { data: staff } = await supabase
    .from("staff")
    .select("id")
    .eq("profile_id", user.id)
    .single();
  if (!staff) throw new UnauthorizedError("No staff profile for this account");

  const { data: appointment } = await supabase
    .from("appointments")
    .select("id, staff_id")
    .eq("id", appointmentId)
    .single();
  if (!appointment || appointment.staff_id !== staff.id) {
    throw new UnauthorizedError("Not your appointment");
  }

  return { profileId: user.id, staffId: staff.id };
}
