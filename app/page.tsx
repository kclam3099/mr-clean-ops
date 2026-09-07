import { redirect } from "next/navigation";
import { getSessionContext, homePathFor } from "@/lib/auth/session";

/**
 * Role-aware entry point.
 *
 * The role lookup lives here rather than in middleware so that middleware stays
 * a cheap cookie check — putting a profile query on every request, including
 * static assets, would cost a round trip per navigation for a decision that
 * only matters at the root.
 */
export default async function RootPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  redirect(homePathFor(session.role));
}
