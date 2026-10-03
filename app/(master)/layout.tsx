import { redirect } from "next/navigation";
import { getSessionContext, homePathFor } from "@/lib/auth/session";
import { isMasterSession } from "@/lib/auth/master-login";
import { MasterViewBanner } from "@/components/nav/MasterViewBanner";
import { resolveScope } from "@/lib/workspace/scope";
import { MasterNav } from "@/components/nav/MasterNav";
import { QuickAddFab } from "@/components/quick-add/QuickAddFab";
import { businessNowLocal } from "@/lib/appointments/message-parser";

/**
 * Master shell. The role check here is a UX guard — Row Level Security is the
 * real boundary, and a staff account reaching these routes would see nothing
 * regardless. Redirecting is simply better than rendering an empty Master page.
 *
 * The nav needs a scope, and a layout cannot read its children's search params,
 * so it renders the caller's default scope. Pages resolve the requested scope
 * from their own searchParams.
 */
export default async function MasterLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  if (!session.isMaster) redirect(homePathFor(session.role));

  // An account still on the password a manager handed over goes nowhere else.
  // Enforced in BOTH shells rather than in the proxy: the proxy sees a cookie,
  // not a profile, and reading the flag there would mean a database round trip
  // on every asset request. Here it is already loaded.
  // A monitoring login (master password) must never be pushed into changing
  // this person's password on their behalf.
  const monitoring = await isMasterSession(session.userId);
  if (session.mustChangePassword && !monitoring) redirect("/change-password");


  const scope = resolveScope(session, null);

  return (
    <div className="min-h-screen bg-surface">
      {monitoring ? <MasterViewBanner name={session.fullName} /> : null}
      <MasterNav session={session} scope={scope} />
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      {/* The assignment list is NOT passed here — the sheet fetches it on open,
          so no staff array reaches this page's RSC payload. */}
      <QuickAddFab businessNow={businessNowLocal()} />
    </div>
  );
}
