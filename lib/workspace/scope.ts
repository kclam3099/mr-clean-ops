import "server-only";
import type { SessionContext, SessionWorkspace } from "@/lib/auth/session";

/**
 * Workspace scoping for Master views.
 *
 * "All Operations" is a VIRTUAL merged view, not a database row. There is no
 * "All Operations" workspace and nothing here ever queries for one — it simply
 * means "every workspace this Master can see", which is exactly what Row Level
 * Security already returns when no workspace filter is applied.
 *
 * The scope is resolved from a URL search param and validated against the
 * caller's own visible workspaces, so a hand-typed workspace id belonging to
 * someone else resolves to the caller's default rather than being honoured.
 * (RLS would return nothing for it anyway; this keeps the UI honest too.)
 */

export const ALL_OPERATIONS = "all" as const;

export type WorkspaceScope =
  | { kind: "all"; workspaceIds: string[]; label: string }
  | { kind: "workspace"; workspaceId: string; workspaceIds: string[]; label: string };

/**
 * A Master with exactly one visible workspace gets no choice and no
 * "All Operations" entry — presenting a scope selector to them would imply
 * other workspaces exist.
 */
export function scopeOptions(session: SessionContext): Array<{ value: string; label: string }> {
  if (!session.isMaster || session.workspaces.length < 2) return [];
  return [
    { value: ALL_OPERATIONS, label: "All Operations" },
    ...session.workspaces.map((w) => ({ value: w.id, label: w.name })),
  ];
}

export function resolveScope(session: SessionContext, requested?: string | null): WorkspaceScope {
  const visible = session.workspaces;
  const allIds = visible.map((w) => w.id);

  // Single visible workspace: always that workspace, never a merged view.
  if (visible.length === 1) {
    const only = visible[0] as SessionWorkspace;
    return { kind: "workspace", workspaceId: only.id, workspaceIds: [only.id], label: only.name };
  }

  if (requested && requested !== ALL_OPERATIONS) {
    const match = visible.find((w) => w.id === requested);
    if (match) {
      return { kind: "workspace", workspaceId: match.id, workspaceIds: [match.id], label: match.name };
    }
    // Unknown or not-visible id — fall through to the default rather than
    // echoing it back or erroring in a way that confirms it exists.
  }

  return { kind: "all", workspaceIds: allIds, label: "All Operations" };
}

/** Adds the scope to a link only when a choice actually exists. */
export function scopedHref(path: string, scope: WorkspaceScope, hasChoice: boolean): string {
  if (!hasChoice) return path;
  const value = scope.kind === "all" ? ALL_OPERATIONS : scope.workspaceId;
  return `${path}?ws=${encodeURIComponent(value)}`;
}
