import Image from "next/image";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata = { title: "Choose a password — Mr Clean & Clean Ops" };

export default async function ChangePasswordPage() {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  return (
    <main className="flex min-h-screen flex-col bg-surface">
      <header className="flex flex-col items-center bg-brand px-4 pt-10 pb-16 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-white p-2 shadow-lg shadow-brand-900/30">
          <Image
            src="/brand/logo.png"
            alt="Mr Clean &amp; Clean"
            width={160}
            height={160}
            priority
            className="h-full w-full object-contain"
          />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-white">
          Choose your password
        </h1>
        <p className="mt-1 max-w-xs text-sm text-white/75">
          {session.mustChangePassword
            ? "Your manager gave you a temporary one. Pick your own before you start."
            : "Set a new password for your account."}
        </p>
      </header>

      <div className="flex flex-1 flex-col items-center px-4 pb-10">
        <div className="-mt-10 w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-xl shadow-brand-900/10">
          <ChangePasswordForm />
        </div>

        <p className="mt-6 max-w-sm text-center text-xs text-ink-muted">
          Signed in as {session.fullName}.
        </p>
      </div>
    </main>
  );
}
