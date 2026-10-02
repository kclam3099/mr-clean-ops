import Image from "next/image";
import type { SessionContext } from "@/lib/auth/session";
import { AccountMenu } from "./AccountMenu";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";
import { NavLink } from "./NavLink";
import { getI18n } from "@/lib/i18n/server";

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
export async function StaffNav({ session }: { session: SessionContext }) {
  const { t } = await getI18n();
  const links = [
    { path: "/my/today", label: t("Today") },
    { path: "/my/tomorrow", label: t("Tomorrow") },
    { path: "/my/month", label: t("Month") },
  ];

  return (
    <header className="sticky top-0 z-30 bg-brand shadow-sm shadow-brand-900/20">
      <div className="flex items-center gap-2.5 px-4 pt-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white p-0.5">
          <Image
            src="/brand/mark.png"
            alt=""
            width={64}
            height={64}
            className="h-full w-full object-contain"
          />
        </span>
        {/* Their own name, because this shell only ever shows their own work —
            it is the answer to "whose agenda am I looking at", which matters on
            a shared phone in a van. */}
        <span className="truncate text-sm font-semibold tracking-tight text-white">
          {session.fullName}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <LanguageToggle />
          <AccountMenu name={session.fullName} />
        </div>
      </div>
      <nav className="flex gap-0.5 px-3 pb-px pt-1">
        {links.map((l) => (
          <NavLink key={l.path} href={l.path} label={l.label} />
        ))}
      </nav>
    </header>
  );
}
