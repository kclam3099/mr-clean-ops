import { Suspense } from "react";
import type { SessionContext } from "@/lib/auth/session";
import { scopeOptions, type WorkspaceScope } from "@/lib/workspace/scope";
import { WorkspaceScopeSelector } from "./WorkspaceScopeSelector";
import { SignOutButton } from "./SignOutButton";
import { ScopedNavLinks } from "./ScopedNavLinks";

/**
 * Master navigation. Every item is derived from what the caller can actually
 * see — `my_role()` for the role, RLS-visible rows for the workspaces.
 *
 * A Partner Master with one workspace gets no scope selector, no disabled
 * entries and no counts. Nothing in this component can render a hint that a
 * workspace they cannot see exists.
 */
export function MasterNav({
  session,
  scope,
}: {
  session: SessionContext;
  scope: WorkspaceScope;
}) {
  const options = scopeOptions(session);
  const hasChoice = options.length >= 2;

  const links = [
    { path: "/dashboard", label: "Today", scoped: true },
    { path: "/calendar", label: "Calendar", scoped: true },
    { path: "/appointments", label: "Appointments", scoped: true },
    { path: "/staff", label: "Staff", scoped: true },
    // /availability resolves its own operational workspace server-side and
    // reads no ws parameter, so scoping its link would be misleading.
    { path: "/availability", label: "Availability", scoped: false },
    { path: "/reports/monthly", label: "Reports", scoped: true },
    ...(session.isSuperMaster ? [{ path: "/settings", label: "Settings", scoped: false }] : []),
  ];

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <span className="text-sm font-semibold tracking-tight text-slate-900">
          Mr Clean &amp; Clean
        </span>

        {hasChoice ? (
          <Suspense fallback={null}>
            <WorkspaceScopeSelector options={options} />
          </Suspense>
        ) : (
          // One workspace: name it plainly, as a label rather than a control.
          <span className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-sm font-medium text-slate-700">
            {scope.label}
          </span>
        )}

        <Suspense fallback={null}>
          <ScopedNavLinks links={links} options={options} hasChoice={hasChoice} />
        </Suspense>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-sm text-slate-500 sm:inline">{session.fullName}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
