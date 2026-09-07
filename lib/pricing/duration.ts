/**
 * DISPLAY-ONLY duration estimate.
 *
 * This exists so the form can say "≈ 2 hours" while the user types. It is not
 * the scheduling rule and must never be treated as one: the browser does not
 * send a duration, and `create_appointment` recalculates everything from the
 * items at save time using its own rate.
 *
 * Everything real — overlap, buffer, working hours, time off, the RM600 rule,
 * cross-workspace availability, concurrency — belongs to the database. Do not
 * grow this file into a second engine.
 *
 * Pure module: no React, no Supabase, no I/O.
 */

export type EstimateInput = { quantity: number; unitPrice: number };

export function subtotal(items: EstimateInput[]): number {
  return items.reduce((sum, i) => {
    const q = Number.isFinite(i.quantity) ? i.quantity : 0;
    const p = Number.isFinite(i.unitPrice) ? i.unitPrice : 0;
    return sum + q * p;
  }, 0);
}

/** Mirrors the server's formula, for display only. */
export function estimatedDurationMinutes(total: number, rmPerHourRate: number): number {
  if (!(total > 0) || !(rmPerHourRate > 0)) return 0;
  return Math.max(1, Math.ceil((total / rmPerHourRate) * 60));
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return h === 1 ? "1 hour" : `${h} hours`;
  return `${h}h ${m}m`;
}

export function formatMoney(amount: number): string {
  return `RM${amount.toFixed(2)}`;
}
