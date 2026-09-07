import { redirect } from "next/navigation";
import { getSessionContext, homePathFor } from "@/lib/auth/session";
import { resolveScope } from "@/lib/workspace/scope";
import { MasterNav } from "@/components/nav/MasterNav";

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

  const scope = resolveScope(session, null);

  return (
    <div className="min-h-screen bg-slate-50">
      <MasterNav session={session} scope={scope} />
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
