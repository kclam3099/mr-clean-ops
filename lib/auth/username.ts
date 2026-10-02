/**
 * Usernames, and the email addresses they stand for.
 *
 * Supabase Auth identifies people by email. The people using this app identify
 * themselves by a first name — "KC", "JACK" — on a phone, outdoors, often with
 * one hand. Asking them to type an address they will never read mail at is a
 * password-reset request waiting to happen.
 *
 * So the username IS the identity, and the address is derived from it. There is
 * no lookup: no table to query before authenticating, no endpoint that will
 * tell a stranger whether "VICTOR" exists, and no way for a wrong guess to
 * return anything but "invalid credentials".
 *
 * The domain is the company's own, so that if a mailbox is ever created for one
 * of these names, password reset by email starts working with no migration.
 */
export const IDENTITY_EMAIL_DOMAIN = "mrcleanclean.com";

/** Usernames are letters, digits, dot, dash and underscore — nothing that
 *  changes meaning when it reaches an address. */
const VALID = /^[a-z0-9._-]{2,32}$/;

/**
 * The address a username signs in as, or null when the input could not be one.
 *
 * Returning null rather than a best-effort address matters: a value that is not
 * a username must fail as a username, not be reshaped into an address that
 * happens to belong to someone else.
 */
export function emailForUsername(input: string): string | null {
  const name = input.trim().toLowerCase();
  if (!name) return null;

  // Someone who types their full address should not be punished for it.
  if (name.includes("@")) {
    const [local, domain] = name.split("@");
    if (domain === IDENTITY_EMAIL_DOMAIN && local && VALID.test(local)) return name;
    // Any other address is passed through untouched; Auth decides.
    return name;
  }

  if (!VALID.test(name)) return null;
  return `${name}@${IDENTITY_EMAIL_DOMAIN}`;
}

/** The username to show for an address this scheme produced. */
export function usernameForEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.toLowerCase().split("@");
  return domain === IDENTITY_EMAIL_DOMAIN && local ? local.toUpperCase() : null;
}
