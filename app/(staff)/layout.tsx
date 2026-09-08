import { redirect } from "next/navigation";
import { getSessionContext, homePathFor } from "@/lib/auth/session";
import { StaffNav } from "@/components/nav/StaffNav";
import { QuickAddFab } from "@/components/quick-add/QuickAddFab";
import { businessNowLocal } from "@/lib/appointments/message-parser";

/**
 * Staff shell — mobile-first, identity-scoped, no workspace navigation.
 *
 * Masters are redirected to their own home rather than being shown a staff
 * agenda, since a Master without a staff row has no appointments of their own.
 */
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  if (!session.staffId) redirect(homePathFor(session.role));

  return (
    <div className="min-h-screen bg-slate-50">
      <StaffNav session={session} />
      <main className="mx-auto max-w-2xl px-4 py-5">{children}</main>
      {/* Staff Quick Add is one step — no assignment list is ever fetched. */}
      <QuickAddFab businessNow={businessNowLocal()} />
    </div>
  );
}
