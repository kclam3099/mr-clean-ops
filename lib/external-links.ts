/**
 * External deep links — WhatsApp and Google Maps.
 *
 * V1 is deep links only: no WhatsApp API, no Maps API key, no automated
 * sending, no background jobs. Every link is opened by the user clicking it.
 *
 * The inputs are customer-controlled free text, so the rules here are strict:
 *
 *   - a link is only produced from data that passes validation; otherwise the
 *     caller renders no button at all, rather than a broken or unsafe one
 *   - the scheme is always a literal in this file, never taken from input, so
 *     `javascript:`, `data:` and friends cannot be introduced
 *   - every interpolated value is percent-encoded
 *
 * Pure module: no React, no I/O, so it is unit-testable in isolation.
 */

/**
 * WhatsApp needs a bare international number: digits only, no `+`, spaces,
 * dashes or parentheses. Returns null when the input cannot be trusted.
 */
export function normalisePhoneForWhatsApp(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const trimmed = phone.trim();
  // Reject anything containing characters a phone number has no business
  // holding, rather than silently stripping them — a value like
  // "012 javascript:alert(1)" should produce no link at all.
  if (!/^\+?[\d\s()\-.]+$/.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, "");
  // Loosely international: long enough to be a real number, short enough to be
  // one. Malaysian mobiles land at 11-12 digits with the 60 country code.
  if (digits.length < 8 || digits.length > 15) return null;

  // A local Malaysian number written as 01x… becomes 601x…
  if (digits.startsWith("0")) return `60${digits.slice(1)}`;
  return digits;
}

/** `https://wa.me/<number>?text=<message>`, or null when the phone is unusable. */
export function whatsappHref(
  phone: string | null | undefined,
  message: string,
): string | null {
  const number = normalisePhoneForWhatsApp(phone);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

/** Google Maps search link for a free-text address, or null when empty. */
export function mapsHref(
  addressLine: string | null | undefined,
  areaCity: string | null | undefined,
): string | null {
  const query = [addressLine, areaCity]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Default reminder text.
 *
 * business_settings carries wa_reminder_template_en / _zh / _ms, but they are
 * empty and are deliberately not exposed through get_booking_config yet. When
 * they are populated, this becomes the fallback rather than the only option —
 * the shape here is what a template would need to fill.
 */
export function buildReminderMessage(input: {
  customerName: string;
  date: string;          // YYYY-MM-DD
  startTime: string;     // HH:MM
}): string {
  const [y, m, d] = input.date.split("-").map(Number);
  const readable = Number.isFinite(y)
    ? new Intl.DateTimeFormat("en-GB", {
        weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
      }).format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)))
    : input.date;

  return (
    `Hi ${input.customerName.trim()}, this is a reminder from Mr Clean & Clean. ` +
    `Your cleaning appointment is on ${readable} at ${input.startTime}. ` +
    `Please reply if you need to change it. Thank you!`
  );
}
