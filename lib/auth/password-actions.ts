"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext, homePathFor } from "@/lib/auth/session";

/**
 * Changing your own password.
 *
 * Auth owns the password; this owns the flag that says the opening one is no
 * longer in use. The order matters: the flag is cleared only after Auth has
 * accepted the new password, so a failed change leaves the account exactly
 * where it was — still required to change, still on the old credential.
 *
 * The flag is cleared through complete_password_change(), a SECURITY DEFINER
 * function that can write one column. profiles has no UPDATE policy, and must
 * not get one: row level security grants a row rather than a column, so a
 * self-update policy would let any staff member set their own role in the same
 * statement.
 */

export type PasswordState = { error: string | null };

// Supabase's own floor is 6. Eight is not meaningfully stronger on its own, but
// it is long enough that a phone number retyped out of habit does not pass.
const MIN_LENGTH = 8;

export async function changePasswordAction(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const session = await getSessionContext();
  if (!session) redirect("/login");

  const next = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (next.length < MIN_LENGTH) {
    return { error: `Use at least ${MIN_LENGTH} characters.` };
  }
  if (next !== confirm) {
    return { error: "The two passwords do not match." };
  }

  // The opening password is the person's phone number, and it is printed on the
  // company's vans. Letting it be re-chosen here would make this whole screen
  // ceremonial.
  const digitsOnly = /^[0-9+\-\s]+$/.test(next);
  if (digitsOnly) {
    return { error: "Do not use a phone number. Choose something else." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    console.warn("[changePassword] Auth rejected the new password");
    // Auth's own messages name its rules (length, leaked-password checks), and
    // none of them disclose anything about other accounts.
    return { error: error.message };
  }

  const { error: flagError } = await supabase.rpc("complete_password_change");
  if (flagError) {
    // The password HAS changed at this point. Saying "it failed" would send
    // them back to a credential that no longer works.
    console.error("[changePassword] password changed but flag not cleared");
    return {
      error:
        "Your password was changed, but we could not finish setting up your " +
        "account. Sign in again with the new password.",
    };
  }

  redirect(homePathFor(session.role));
}
