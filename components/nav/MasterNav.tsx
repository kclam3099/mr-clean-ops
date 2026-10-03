import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import type { SessionContext } from "@/lib/auth/session";
import { ALL_OPERATIONS, scopeOptions, type WorkspaceScope } from "@/lib/workspace/scope";
import { getI18n } from "@/lib/i18n/server";
import { WorkspaceScopeSelector } from "./WorkspaceScopeSelector";
import { AccountMenu } from "./AccountMenu";
import { ScopedNavLinks } from "./ScopedNavLinks";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";

/**
 * Master navigation. Every item is derived from what the caller can actually
 * see — `my_role()` for the role, RLS-visible rows for the workspaces.
 *
 * A Partner Master with one workspace gets no scope selector, no disabled
 * entries and no counts. Nothing in this component can render a hint that a
 * workspace they cannot see exists.
 *
 * Two rows rather than one wrapping row. Seven links, a workspace selector, a
 * name and a sign-out button do not fit across a phone, and letting them wrap
 * produced a header four lines deep that pushed the actual page off the first
 * screen. The identity row stays put; the links scroll sideways under it.
 */
export async function MasterNav({
  session,
  scope,
}: {
  session: SessionContext;
  scope: WorkspaceScope;
}) {
  const { t } = await getI18n();
  // Only the virtual "All Operations" entry is ours to translate — every other
  // option is a workspace name someone typed.
  const options = scopeOptions(session).map((o) =>
    o.value === ALL_OPERATIONS ? { ...o, label: t(o.label) } : o,
  );
  const hasChoice = options.length >= 2;

  const links = [
    { path: "/dashboard", label: t("Today"), scoped: true },
    { path: "/calendar", label: t("Calendar"), scoped: true },
    { path: "/appointments", label: t("Customers"), scoped: true },
    { path: "/staff", label: t("Staff"), scoped: true },
    // /availability resolves its own operational workspace server-side and
    // reads no ws parameter, so scoping its link would be misleading.
    { path: "/availability", label: t("Availability"), scoped: false },
    { path: "/reports/monthly", label: t("Reports"), scoped: true },
    ...(session.isSuperMaster ? [{ path: "/settings", label: t("Settings"), scoped: false }] : []),
  ];

  return (
    <header className="sticky top-0 z-30 bg-brand shadow-sm shadow-brand-900/20">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex min-h-14 items-center gap-3 py-2">
          <Link
            href="/dashboard"
            className="flex shrink-0 cursor-pointer items-center gap-2.5 rounded-lg py-1 pr-2"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white p-1">
              <Image
                src="/brand/mark.png"
                alt=""
                width={64}
                height={64}
                className="h-full w-full object-contain"
              />
            </span>
            {/* The wordmark is the first thing to go when space runs out — the
                mark alone still identifies the app, and the links do not. */}
            <span className="hidden text-sm font-semibold tracking-tight text-white sm:inline">
              Mr Clean &amp; Clean
            </span>
          </Link>

          {hasChoice ? (
            <Suspense fallback={null}>
              <WorkspaceScopeSelector options={options} />
            </Suspense>
          ) : (
            // One workspace: name it plainly, as a label rather than a control.
            <span className="truncate rounded-lg bg-white/15 px-2.5 py-1.5 text-sm font-medium text-white">
              {scope.kind === "all" ? t(scope.label) : scope.label}
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <LanguageToggle />
            <AccountMenu name={session.fullName} />
          </div>
        </div>

        {/* Horizontal scroll, not wrap. A row that reflows moves every target
            under the thumb when the workspace name changes length. */}
        <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Suspense fallback={null}>
            <ScopedNavLinks links={links} options={options} hasChoice={hasChoice} />
          </Suspense>
        </div>
      </div>
    </header>
  );
}
