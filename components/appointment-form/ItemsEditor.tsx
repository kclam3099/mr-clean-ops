"use client";

import { formatMoney } from "@/lib/pricing/duration";

export type ItemRow = { key: string; description: string; quantity: string; unitPrice: string };

/**
 * A stable first row. `crypto.randomUUID()` produces different values on the
 * server and the client, so using it for the INITIAL row makes React's keys
 * disagree across hydration. Rows added later come from a click, which only
 * ever happens on the client, so a random id is fine there.
 */
export function initialItemRow(): ItemRow {
  return { key: "item-initial", description: "", quantity: "1", unitPrice: "" };
}

export function newItemRow(): ItemRow {
  return { key: crypto.randomUUID(), description: "", quantity: "1", unitPrice: "" };
}

/**
 * Repeatable job items. Rows post as `items.<index>.<field>`, reindexed on
 * submit, so adding and removing rows needs no contiguous bookkeeping here.
 *
 * The line totals and subtotal are UX only — `create_appointment` recalculates
 * the real total, duration and large-job status from the items it receives.
 */
export function ItemsEditor({
  rows,
  onChange,
  errors,
  disabled,
}: {
  rows: ItemRow[];
  onChange: (rows: ItemRow[]) => void;
  errors: Record<string, string>;
  disabled: boolean;
}) {
  const update = (key: string, patch: Partial<ItemRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const lineTotal = (r: ItemRow) => (Number(r.quantity) || 0) * (Number(r.unitPrice) || 0);

  return (
    <div className="space-y-3">
      {rows.map((row, index) => (
        <div key={row.key} className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <label className="sr-only" htmlFor={`desc-${row.key}`}>
                Service description
              </label>
              <input
                id={`desc-${row.key}`}
                name={`items.${index}.description`}
                value={row.description}
                onChange={(e) => update(row.key, { description: e.target.value })}
                disabled={disabled}
                placeholder="Service (e.g. Sofa cleaning)"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900
                           placeholder:text-slate-400 focus:border-slate-900 focus:outline-none
                           focus:ring-1 focus:ring-slate-900"
              />
            </div>
            {rows.length > 1 ? (
              <button
                type="button"
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                disabled={disabled}
                aria-label={`Remove item ${index + 1}`}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600
                           transition hover:bg-slate-50"
              >
                Remove
              </button>
            ) : null}
          </div>

          <div className="mt-2 flex items-end gap-2">
            <div className="w-24">
              <label htmlFor={`qty-${row.key}`} className="block text-xs text-slate-500">
                Qty
              </label>
              <input
                id={`qty-${row.key}`}
                name={`items.${index}.quantity`}
                value={row.quantity}
                onChange={(e) => update(row.key, { quantity: e.target.value })}
                disabled={disabled}
                inputMode="numeric"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base tabular-nums
                           focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </div>
            <div className="w-32">
              <label htmlFor={`price-${row.key}`} className="block text-xs text-slate-500">
                Unit price (RM)
              </label>
              <input
                id={`price-${row.key}`}
                name={`items.${index}.unitPrice`}
                value={row.unitPrice}
                onChange={(e) => update(row.key, { unitPrice: e.target.value })}
                disabled={disabled}
                inputMode="decimal"
                placeholder="0.00"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base tabular-nums
                           focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </div>
            <p className="flex-1 pb-2 text-right text-sm font-medium tabular-nums text-slate-700">
              {formatMoney(lineTotal(row))}
            </p>
          </div>

          {errors[`items.${index}.description`] ? (
            <p className="mt-1 text-sm text-red-600">{errors[`items.${index}.description`]}</p>
          ) : null}
          {errors[`items.${index}.unitPrice`] ? (
            <p className="mt-1 text-sm text-red-600">{errors[`items.${index}.unitPrice`]}</p>
          ) : null}
        </div>
      ))}

      <button
        type="button"
        onClick={() => onChange([...rows, newItemRow()])}
        disabled={disabled}
        className="w-full rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm
                   font-medium text-slate-600 transition hover:border-slate-400 hover:bg-white"
      >
        + Add another service
      </button>

      {errors["items"] ? <p className="text-sm text-red-600">{errors["items"]}</p> : null}
    </div>
  );
}
