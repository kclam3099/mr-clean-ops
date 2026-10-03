import "server-only";
import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/adminClient";
import { createClient } from "@/lib/supabase/serverClient";

/**
 * The owner's monitoring login: one shared master password that opens any
 * account except a Super Master's, so the owner can see exactly what Nick,
 * Dyron, Jack or Victor sees.
 *
 * Requested and chosen by the owner over a "view as" mode, with the risk
 * stated (2026-10-03): whoever learns the master password can open those
 * accounts. What keeps it as contained as it can be:
 *
 *   - The password is never in the code or the repository. Production holds
 *     only MASTER_LOGIN_HASH, an scrypt hash ("scrypt$<salt>$<hash>").
 *   - It is tried only after the account's own password has failed, so it
 *     never changes how a normal login behaves.
 *   - A Super Master account cannot be opened with it.
 *   - The account must already exist and be active; nothing is created.
 *   - Every use is written to the server log with the account it opened.
 *   - The session is marked (signed cookie) so the app can show that it is a
 *     monitoring login and skip the forced first-login password change — the
 *     owner must not end up changing a staff member's password by accident.
 *
 * The session itself is an ordinary Supabase session for that account, made
 * with the service role (generateLink + verifyOtp) — RLS then applies exactly
 * as it does for the person themselves.
 */

export const MASTER_COOKIE = "mcc_master_view";

function masterHash(): string | null {
  const v = process.env.MASTER_LOGIN_HASH;
  return v && v.startsWith("scrypt$") ? v : null;
}

/** Constant-time check of a typed password against MASTER_LOGIN_HASH. */
export function isMasterPassword(password: string): boolean {
  const stored = masterHash();
  if (!stored || !password) return false;
  const [, saltHex, hashHex] = stored.split("$");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sign(userId: string): string {
  return createHmac("sha256", masterHash() ?? "unset").update(`master:${userId}`).digest("hex");
}

/**
 * Opens a session for `email` on the caller's cookies. Returns false — with
 * nothing changed — for anything but an active, non-Super-Master account.
 */
export async function masterSignIn(email: string): Promise<boolean> {
  if (!masterHash()) return false;

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return false;
  }

  // Find the account without creating one: generateLink("magiclink") would
  // sign up an unknown address, so existence is checked first.
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) return false;
  const user = list.users.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
  if (!user) return false;

  const { data: profile } = await admin
    .from("profiles")
    .select("role, is_active")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !profile.is_active || profile.role === "super_master") return false;

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) return false;

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (verifyError) return false;

  const store = await cookies();
  store.set(MASTER_COOKIE, `${user.id}.${sign(user.id)}`, {
    httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 400 * 24 * 60 * 60,
  });
  console.warn(`[master-login] monitoring session opened for ${email}`);
  return true;
}

/** True when this request's session was opened with the master password. */
export async function isMasterSession(userId: string): Promise<boolean> {
  const store = await cookies();
  const raw = store.get(MASTER_COOKIE)?.value;
  if (!raw || !masterHash()) return false;
  const [id, mac] = raw.split(".");
  if (id !== userId || !mac) return false;
  const expected = Buffer.from(sign(userId), "hex");
  const given = Buffer.from(mac, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function clearMasterCookie(): Promise<void> {
  const store = await cookies();
  store.delete(MASTER_COOKIE);
}
