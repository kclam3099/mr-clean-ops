import { redirect } from "next/navigation";
import { getSessionContext, homePathFor } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in — Mr Clean & Clean Ops" };

export default async function LoginPage() {
  // An already-signed-in user with a usable session never sees this page.
  // A session that exists but has no active profile does — signInAction has
  // already signed it out, so the form is the correct destination.
  const session = await getSessionContext();
  if (session) redirect(homePathFor(session.role));

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Mr Clean &amp; Clean
          </h1>
          <p className="mt-1 text-sm text-slate-500">Operations</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <LoginForm />
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Internal system. Accounts are created by a manager.
        </p>
      </div>
    </main>
  );
}
