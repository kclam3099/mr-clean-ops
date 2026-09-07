import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/serverClient";

/**
 * The one place the app resolves "who is asking".
 *
 * Role, staff identity and workspace visibility all come from the trusted
 * server side — `my_role()` / `my_staff_id()` are SECURITY DEFINER RPCs on the
 * EXECUTE allowlist (migration 0002), and the workspace list is whatever Row
 * Level Security actually returns for this caller. Nothing here is derived from
 * a client-supplied value, so navigation and page guards cannot be talked into
 * showing something the database would not.
 *
 * Wrapped in React `cache` so a request that renders several server components
 * resolves the session once.
 */

export type UserRole = "super_master" | "partner_master" | "staff";

export type SessionWorkspace = {
  id: string;
  name: string;
  slug: string | null;
};

export type SessionContext = {
  userId: string;
  email: string | null;
  profileId: string;
  fullName: string;
  role: UserRole;
  isMaster: boolean;
  isSuperMaster: boolean;
  /** null for Masters who are not also staff */
  staffId: string | null;
  /**
   * Workspaces this caller can actually see, straight from RLS.
   * For a Master this is what they administer. It is never padded with
   * placeholders for workspaces they cannot see — a Shared-Team-only Master
   * must not be able to infer that another workspace exists.
   */
  workspaces: SessionWorkspace[];
};

/** Why a session could not be established. Distinguished so /login can explain. */
export type SessionProblem = "unauthenticated" | "no_profile" | "inactive_profile";

export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const result = await resolveSession();
  return result.ok ? result.session : null;
});

export const getSessionOrProblem = cache(
  async (): Promise<{ ok: true; session: SessionContext } | { ok: false; problem: SessionProblem }> =>
    resolveSession(),
);

async function resolveSession(): Promise<
  { ok: true; session: SessionContext } | { ok: false; problem: SessionProblem }
> {
  const supabase = await createClient();

  // getUser() revalidates the token against Supabase — never trust getSession()
  // alone for an authorization decision.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, problem: "unauthenticated" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  // An authenticated account with no profile row has no capability at all —
  // every RPC fails closed for it (migration 0003). Treat it as not signed in
  // rather than rendering a shell it cannot populate.
  if (!profile) return { ok: false, problem: "no_profile" };
  if (!profile.is_active) return { ok: false, problem: "inactive_profile" };

  const [{ data: staffId }, { data: workspaces }] = await Promise.all([
    supabase.rpc("my_staff_id"),
    supabase.from("workspaces").select("id, name, slug").order("name"),
  ]);

  const role = profile.role as UserRole;

  return {
    ok: true,
    session: {
      userId: user.id,
      email: user.email ?? null,
      profileId: profile.id,
      fullName: profile.full_name,
      role,
      isMaster: role === "super_master" || role === "partner_master",
      isSuperMaster: role === "super_master",
      staffId: (staffId as string | null) ?? null,
      workspaces: (workspaces ?? []) as SessionWorkspace[],
    },
  };
}

/** Where this role belongs after signing in. */
export function homePathFor(role: UserRole): string {
  return role === "staff" ? "/my/today" : "/calendar";
}
