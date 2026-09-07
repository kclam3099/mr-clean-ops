import type { SessionContext } from "@/lib/auth/session";
import { SignOutButton } from "./SignOutButton";
import { NavLink } from "./NavLink";

/**
 * Staff navigation — mobile-first, and deliberately WITHOUT a workspace
 * switcher.
 *
 * The staff dashboard is always identity-scoped: one merged agenda of this
 * person's own appointments across every workspace they belong to. Even a staff
 * member who belongs to several workspaces sees a single unified agenda here.
 *
 * Workspace only becomes a choice when an operation needs attribution — and
 * that choice lives inside the Add Appointment form, not in navigation.
 */
export function StaffNav({ session }: { session: SessionContext }) {
  const links = [
    { path: "/my/today", label: "Today" },
    { path: "/my/tomorrow", label: "Tomorrow" },
    { path: "/my/month", label: "Month" },
  ];

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="text-sm font-semibold tracking-tight text-slate-900">
          {session.fullName}
        </span>
        <SignOutButton />
      </div>
      <nav className="flex gap-1 px-3 pb-2 pt-1">
        {links.map((l) => (
          <NavLink key={l.path} href={l.path} label={l.label} />
        ))}
      </nav>
    </header>
  );
}
