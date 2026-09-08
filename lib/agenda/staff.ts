import "server-only";
import type { SessionContext } from "@/lib/auth/session";
import type { WorkspaceScope } from "@/lib/workspace/scope";
import { resolveBookingContext } from "@/lib/appointments/context";
import type { CalendarStaff } from "@/components/agenda/StaffWeekGrid";

/**
 * The staff rows a calendar should show for a scope.
 *
 * Deliberately built on `resolveBookingContext` rather than a fresh query, so
 * the calendar roster and the Quick Add assignment list are the same
 * RLS-visible set. Two separate queries would be two chances to drift, and the
 * calendar is the surface where an extra row would be most visible: a Victor
 * row appearing for Nick discloses Victor even with no appointment in it.
 *
 * Scope only narrows. It can never widen beyond what RLS already returned.
 */
export async function getCalendarStaff(
  session: SessionContext,
  scope: WorkspaceScope,
): Promise<CalendarStaff[]> {
  const context = await resolveBookingContext(session);

  const workspaces =
    scope.kind === "workspace"
      ? context.workspaces.filter((w) => w.id === scope.workspaceId)
      : context.workspaces;

  const byId = new Map<string, string>();
  for (const w of workspaces) {
    for (const s of w.staff) if (!byId.has(s.id)) byId.set(s.id, s.name);
  }

  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
