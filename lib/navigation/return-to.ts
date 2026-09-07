/**
 * Return destinations are a closed enum, never a URL.
 *
 * Accepting a caller-supplied path — even a relative one — is how open
 * redirects happen. `//evil.example` and `javascript:` both survive naive
 * "starts with /" checks. There is no validation here at all: an unknown value
 * simply is not in the map, so it cannot produce a destination.
 */

export const RETURN_DESTINATIONS = {
  calendar: "/calendar",
  appointments: "/appointments",
  today: "/my/today",
  tomorrow: "/my/tomorrow",
  month: "/my/month",
} as const;

export type ReturnKey = keyof typeof RETURN_DESTINATIONS;

export function isReturnKey(value: unknown): value is ReturnKey {
  return typeof value === "string" && Object.hasOwn(RETURN_DESTINATIONS, value);
}

/** Unknown, absent or hostile input resolves to the role's default. */
export function resolveReturnPath(value: unknown, mode: "master" | "staff"): string {
  const fallback = mode === "staff" ? RETURN_DESTINATIONS.today : RETURN_DESTINATIONS.calendar;
  if (!isReturnKey(value)) return fallback;

  // A staff member cannot be returned to a Master route, and vice versa —
  // otherwise a valid key from the wrong role bounces them through a redirect.
  const staffKeys: ReturnKey[] = ["today", "tomorrow", "month"];
  const isStaffKey = staffKeys.includes(value);
  if (mode === "staff" && !isStaffKey) return fallback;
  if (mode === "master" && isStaffKey) return fallback;

  return RETURN_DESTINATIONS[value];
}
