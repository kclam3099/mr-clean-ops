import Image from "next/image";
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
    <main className="flex min-h-screen flex-col bg-surface">
      {/* The navy block OWNS the logo and the wordmark, rather than sitting
          behind them at a fixed height. A decorative band of a guessed height
          put the white heading on the grey below it at 375px — invisible text,
          on the first screen anyone sees. Letting the block size to its own
          contents means it cannot come apart at a width nobody measured. */}
      <header className="flex flex-col items-center bg-brand px-4 pt-10 pb-16 text-center">
        <div className="flex h-28 w-28 items-center justify-center rounded-2xl bg-white p-2.5 shadow-lg shadow-brand-900/30">
          <Image
            src="/brand/logo.png"
            alt="Mr Clean &amp; Clean"
            width={256}
            height={256}
            priority
            className="h-full w-full object-contain"
          />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-white">
          Mr Clean &amp; Clean
        </h1>
        <p className="mt-1 text-sm text-white/75">Operations</p>
      </header>

      <div className="flex flex-1 flex-col items-center px-4 pb-10">
        {/* Pulled up over the seam so the card is clearly the thing to act on,
            and the fold is not a dead horizontal line across the screen. */}
        <div className="-mt-10 w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-xl shadow-brand-900/10">
          <LoginForm />
        </div>

        {/* ink-muted, not ink-faint: at 12px the faint tone measured 4.40:1, just
            under the 4.5 floor, and small text is exactly where the margin
            should not be spent. */}
        <p className="mt-6 max-w-sm text-center text-xs text-ink-muted">
          Internal system. Accounts are created by a manager.
        </p>
      </div>
    </main>
  );
}
