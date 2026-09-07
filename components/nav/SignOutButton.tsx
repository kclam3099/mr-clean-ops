"use client";

import { useTransition } from "react";
import { signOutAction } from "@/lib/auth/actions";

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
      className={`rounded-md px-2.5 py-1.5 text-sm text-slate-500 transition
                  hover:bg-slate-100 hover:text-slate-900 disabled:opacity-60 ${className}`}
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
