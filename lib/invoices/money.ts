/**
 * Invoice money, the owner's way: whole ringgit, no ".00" ("RM139").
 *
 * New invoices are whole numbers by construction (the editor rounds). A value
 * that still has sen — an invoice saved before rounding — keeps its decimals
 * rather than being shown as a different amount than the one stored.
 */
export function invoiceMoney(n: number): string {
  const cents = Math.round(n * 100);
  return cents % 100 === 0
    ? `RM${(cents / 100).toLocaleString("en-MY")}`
    : `RM${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Rounds a typed amount to whole ringgit; blank or invalid counts as 0. */
export function wholeRinggit(s: string | number): number {
  const n = typeof s === "number" ? s : Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
}
