"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionOrProblem, homePathFor } from "@/lib/auth/session";

/**
 * Sign-in / sign-out Server Actions.
 *
 * Sign-in deliberately returns ONE message for every failure mode — wrong
 * password, unknown address, or an account with no/inactive profile. Telling
 * them apart would turn the form into an account-existence oracle for a system
 * whose whole design keeps people from discovering each other.
 */

export type LoginState = { error: string | null };

const GENERIC_FAILURE = "Incorrect email or password.";
const INACTIVE = "This account is not active. Please contact your manager.";

export async function signInAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.warn("[signIn] failed for a submitted address");
    return { error: GENERIC_FAILURE };
  }

  // Authenticated — but an account still needs an active profile to have any
  // capability at all. Without one every RPC fails closed, so sign back out
  // rather than dropping the user into a shell they cannot use.
  const result = await getSessionOrProblem();
  if (!result.ok) {
    await supabase.auth.signOut();
    console.warn(`[signIn] rejected session: ${result.problem}`);
    return { error: result.problem === "inactive_profile" ? INACTIVE : GENERIC_FAILURE };
  }

  revalidatePath("/", "layout");
  redirect(homePathFor(result.session.role));
}

/**
 * Ends the session. Deliberately does NOT redirect.
 *
 * `redirect()` here would be a client-side (soft) navigation, which keeps the
 * current document alive — and with it every RSC flight chunk the previous user
 * rendered. Signing out and back in as someone else in the same tab would leave
 * the first user's payload sitting in the DOM, readable from JavaScript, even
 * though the visible page is correct. On a system whose whole design keeps
 * Masters from discovering each other's workspaces, that is a real leak.
 *
 * The caller performs a full-document navigation instead, which discards the
 * document, the flight payload and the router cache together.
 */
export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
}
