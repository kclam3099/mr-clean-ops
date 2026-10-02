"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionOrProblem, homePathFor } from "@/lib/auth/session";
import { emailForUsername } from "@/lib/auth/username";

/**
 * Sign-in / sign-out Server Actions.
 *
 * Sign-in deliberately returns ONE message for every failure mode — wrong
 * password, unknown username, or an account with no/inactive profile. Telling
 * them apart would turn the form into an account-existence oracle for a system
 * whose whole design keeps people from discovering each other.
 *
 * A username that cannot be one at all is answered with the same message and
 * the same work, rather than returning early: a faster "no" for malformed input
 * is still a signal about what the valid shape is.
 */

export type LoginState = { error: string | null };

const GENERIC_FAILURE = "Incorrect username or password.";
const INACTIVE = "This account is not active. Please contact your manager.";

export async function signInAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!username || !password) {
    return { error: "Enter your username and password." };
  }

  // A username that could not be one is sent to Auth as an address that cannot
  // exist, so the failure takes the same path and the same time as a wrong
  // password rather than returning early.
  const email = emailForUsername(username) ?? `${crypto.randomUUID()}@invalid.invalid`;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.warn("[signIn] failed for a submitted username");
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
