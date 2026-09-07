import "server-only";
import { createClient } from "@/lib/supabase/serverClient";
import type { SessionContext } from "@/lib/auth/session";

/**
 * What this caller may actually book, resolved entirely from RLS-visible data.
 *
 * The ordering here is the security property: we enumerate what the caller can
 * see FIRST, then match any requested prefill against that set. We never fetch
 * a requested uuid and then check whether it was allowed — that pattern leaks
 * existence through timing, error text or a momentary render.
 *
 * A hint that does not match is dropped in silence. Nick opening
 * `?staff=<Victor uuid>` gets exactly what he gets from `?staff=<random uuid>`:
 * no prefill, no error, no acknowledgement that anything was requested.
 */

export type BookableStaff = { id: string; name: string };
export type BookableWorkspace = { id: string; name: string; staff: BookableStaff[] };

export type BookingContext = {
  mode: "master" | "staff";
  /** Workspaces the caller may book into, each with its own eligible staff. */
  workspaces: BookableWorkspace[];
  /** Staff mode: the caller's own staff row. Master mode: null. */
  selfStaffId: string | null;
  selfStaffName: string | null;
  /** Resolved prefill — already validated against `workspaces`. */
  preselectedWorkspaceId: string | null;
  preselectedStaffId: string | null;
  /** True when a workspace selector should render at all. */
  needsWorkspaceChoice: boolean;
};

export async function resolveBookingContext(
  session: SessionContext,
  hints: { ws?: string | null; staff?: string | null } = {},
): Promise<BookingContext> {
  const supabase = await createClient();

  // Everything below is RLS-filtered. Nick's queries simply do not return
  // Victor or KC Private Team, so they cannot reach the UI by any path.
  const [{ data: workspaceRows }, { data: staffRows }, { data: membershipRows }] =
    await Promise.all([
      supabase.from("workspaces").select("id, name").order("name"),
      supabase.from("staff").select("id, display_name").eq("is_active", true),
      supabase.from("staff_workspaces").select("staff_id, workspace_id").eq("is_active", true),
    ]);

  const staffById = new Map((staffRows ?? []).map((s) => [s.id, s.display_name]));

  const isMaster = session.isMaster;
  const selfStaffId = session.staffId;

  const workspaces: BookableWorkspace[] = (workspaceRows ?? []).map((w) => {
    const members = (membershipRows ?? [])
      .filter((m) => m.workspace_id === w.id)
      // Staff mode books only for themselves; Master mode offers every active
      // member of the workspace.
      .filter((m) => (isMaster ? true : m.staff_id === selfStaffId))
      .map((m) => ({ id: m.staff_id, name: staffById.get(m.staff_id) ?? "" }))
      // A membership whose staff row is invisible or inactive is not bookable.
      .filter((s) => s.name !== "");
    return { id: w.id, name: w.name, staff: members };
  })
    // Never offer a workspace with nobody bookable in it.
    .filter((w) => w.staff.length > 0);

  // ---- prefill, validated against the set above ----
  const preselectedWorkspaceId =
    hints.ws && workspaces.some((w) => w.id === hints.ws) ? hints.ws : null;

  let preselectedStaffId: string | null = null;
  if (isMaster && hints.staff) {
    const pool = preselectedWorkspaceId
      ? workspaces.find((w) => w.id === preselectedWorkspaceId)?.staff ?? []
      : workspaces.flatMap((w) => w.staff);
    if (pool.some((s) => s.id === hints.staff)) preselectedStaffId = hints.staff;
  }

  // Staff never choose a staff member; their identity is the session's.
  if (!isMaster) preselectedStaffId = selfStaffId;

  // One workspace means no choice to present. Rendering a selector with a
  // single entry, or a count, would imply others exist.
  const needsWorkspaceChoice = workspaces.length > 1;

  return {
    mode: isMaster ? "master" : "staff",
    workspaces,
    selfStaffId,
    selfStaffName: selfStaffId ? staffById.get(selfStaffId) ?? null : null,
    preselectedWorkspaceId:
      preselectedWorkspaceId ?? (workspaces.length === 1 ? workspaces[0]!.id : null),
    preselectedStaffId,
    needsWorkspaceChoice,
  };
}

/**
 * Re-checks a submitted workspace/staff pair against the caller's own visible
 * set. Server Actions call this independently of anything the form rendered —
 * a Server Action is a public endpoint, and the page that produced the form is
 * not a control.
 */
export function assertBookable(
  context: BookingContext,
  workspaceId: string,
  staffId: string | null,
): { ok: true } | { ok: false; field: "workspaceId" | "staffId" } {
  const workspace = context.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return { ok: false, field: "workspaceId" };

  if (context.mode === "staff") {
    // The action does not send a staff id at all; the RPC derives it. Anything
    // present that is not the caller is a rejection, not a silent correction.
    if (staffId && staffId !== context.selfStaffId) return { ok: false, field: "staffId" };
    return { ok: true };
  }

  if (!staffId || !workspace.staff.some((s) => s.id === staffId)) {
    return { ok: false, field: "staffId" };
  }
  return { ok: true };
}
