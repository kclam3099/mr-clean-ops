"use client";

import { useTransition } from "react";
import { signOutAction } from "@/lib/auth/actions";
import { useT } from "@/components/i18n/I18nProvider";

/**
 * Signing out must destroy the document, not just the session.
 *
 * A soft navigation leaves the outgoing user's RSC flight chunks in the DOM —
 * specifically the inline `self.__next_f.push(...)` script tags written by a
 * full page load. Those tags are never removed by a later soft navigation, so
 * the next person to sign in on the same tab carries the previous user's
 * rendered data, including workspaces they are not allowed to know exist.
 * A full-document replacement drops the payload, the client router cache and
 * the history entry together.
 *
 * Regression test: tests/e2e/cross-user-privacy.test.mjs — verified to fail
 * (6 security failures) when this is reverted to a soft navigation.
 *
 * The mutation still goes through a Server Action, so it keeps Next.js's
 * built-in origin check rather than exposing a CSRF-able logout endpoint.
 */
export function SignOutButton({ className = "" }: { className?: string }) {
  const { t } = useT();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await signOutAction();
          // replace(), not assign() and not router.push():
          //   router.push()  — soft navigation. Keeps the document alive, so the
          //                    outgoing user's RSC payload survives in the DOM.
          //                    This is the exact bug this code exists to prevent.
          //   assign()       — full document load, but leaves the signed-in page
          //                    in session history, so Back can resurrect it.
          //   replace()      — full document load AND drops the history entry.
          window.location.replace("/login");
        })
      }
      className={`flex min-h-11 cursor-pointer items-center whitespace-nowrap rounded-lg px-3
                  text-sm font-medium text-white/80 transition-colors duration-200
                  hover:bg-white/15 hover:text-white disabled:opacity-60 ${className}`}
    >
      {pending ? t("Signing out…") : t("Sign out")}
    </button>
  );
}
