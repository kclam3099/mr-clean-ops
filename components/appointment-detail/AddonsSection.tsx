"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AppointmentDetail } from "@/lib/appointments/detail";
import { addAddonAction, removeAddonAction } from "@/lib/appointments/addon-actions";
import type { ActionResult } from "@/lib/appointments/lifecycle-actions";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { formatMoney } from "@/lib/pricing/duration";
import { useT } from "@/components/i18n/I18nProvider";
import type { TFunc } from "@/lib/i18n/core";

/**
 * Add-ons: extra work sold on site, credited to the assigned staff member.
 *
 * Kept visibly apart from Services. Services are what was booked — they set
 * the total, the duration and the large-job lock. An add-on is recorded once
 * the slot is already fixed and moves none of those, so it gets its own list,
 * its own subtotal, and the booked Total above stays what was booked.
 *
 * The staff member doing the job is the main user: one button, two fields,
 * done — standing in a customer's kitchen, not at a desk.
 */
export function AddonsSection({
  detail,
  canAdd,
}: {
  detail: AppointmentDetail;
  canAdd: boolean;
}) {
  const router = useRouter();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  // Nothing recorded and nothing the caller can do: no empty box.
  if (!detail.addonsAvailable || (detail.addons.length === 0 && !canAdd)) return null;

  const total = detail.addons.reduce((sum, a) => sum + a.amount, 0);
  /** Server messages stay English in the action; they are translated only for display. */
  const fieldError = (n: string) => {
    const msg = result?.status === "error" ? result.fields?.[n] : undefined;
    return msg === undefined ? undefined : translateFieldError(t, msg);
  };

  function submit(action: (fd: FormData) => Promise<ActionResult>, fd: FormData, closeOnSuccess: boolean) {
    if (pending) return;
    startTransition(async () => {
      const res = await action(fd);
      setResult(res);
      if (res.status === "success") {
        if (closeOnSuccess) setOpen(false);
        router.refresh();
      }
    });
  }

  return (
    <section data-addons className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex items-center justify-between gap-2 bg-brand px-4 py-2 text-white">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span aria-hidden className="h-4 w-1 rounded-full bg-gold" />
          {t("Add-ons")}
          {detail.staffName ? (
            <span className="hidden truncate font-normal text-white/70 sm:inline">
              {t("· credited to {name}", { name: detail.staffName })}
            </span>
          ) : null}
        </h2>
        {canAdd && !open ? (
          <button
            type="button"
            data-add-addon
            onClick={() => { setOpen(true); setResult(null); }}
            className="flex min-h-8 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-lg bg-gold px-3
                       text-xs font-bold text-brand-900 transition hover:brightness-95"
          >
            {t("+ Add-on")}
          </button>
        ) : null}
      </div>

      {result?.status === "error" && !result.fields ? (
        <div className="px-4 pt-3"><ErrorNotice error={result.error} /></div>
      ) : null}

      {detail.addons.length > 0 ? (
        <ul className="divide-y divide-line">
          {detail.addons.map((a) => (
            <li key={a.id} data-addon-row={a.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 text-ink">{a.description}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="tabular-nums font-medium text-ink">{formatMoney(a.amount)}</span>
                {a.canRemove ? (
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={t("Remove add-on {description}", { description: a.description })}
                    onClick={() => {
                      if (!window.confirm(t("Remove \"{description}\" ({amount})?", {
                        description: a.description, amount: formatMoney(a.amount),
                      }))) return;
                      const fd = new FormData();
                      fd.set("appointmentId", detail.id);
                      fd.set("addonId", a.id);
                      submit(removeAddonAction, fd, false);
                    }}
                    className="cursor-pointer rounded px-1.5 text-xs text-ink-faint transition
                               hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                  >
                    ✕
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : !open ? (
        <p className="px-4 py-3 text-sm text-ink-faint">
          {t("No add-ons yet. Sold something extra on site? Record it here.")}
        </p>
      ) : null}

      {open ? (
        <form
          data-addon-form
          className="space-y-3 border-t border-line bg-sunken/50 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            fd.set("appointmentId", detail.id);
            submit(addAddonAction, fd, true);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
            <div className="space-y-1">
              <label htmlFor="addon-description" className="block text-sm font-medium text-ink">{t("Item")}</label>
              <input id="addon-description" name="description" required maxLength={120} autoFocus
                placeholder={t("e.g. Mattress cleaning")} disabled={pending} className={inputClass} />
              {fieldError("description") ? <p className="text-sm text-red-600">{fieldError("description")}</p> : null}
            </div>
            <div className="space-y-1">
              <label htmlFor="addon-amount" className="block text-sm font-medium text-ink">{t("Amount (RM)")}</label>
              <input id="addon-amount" name="amount" required type="number" inputMode="decimal"
                min="0.01" max="100000" step="0.01" placeholder="0.00" disabled={pending} className={inputClass} />
              {fieldError("amount") ? <p className="text-sm text-red-600">{fieldError("amount")}</p> : null}
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setOpen(false); setResult(null); }} disabled={pending}
              className="rounded-lg border border-line bg-card px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-sunken">
              {t("Cancel")}
            </button>
            <button type="submit" disabled={pending}
              className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50">
              {pending ? t("Saving…") : t("Save add-on")}
            </button>
          </div>
        </form>
      ) : null}

      {detail.addons.length > 0 ? (
        <div className="flex justify-between border-t-2 border-gold bg-sunken px-4 py-3 text-sm font-bold">
          <span className="text-ink">{t("Add-on total")}</span>
          <span data-addon-total className="tabular-nums text-brand">{formatMoney(total)}</span>
        </div>
      ) : null}
    </section>
  );
}

/** Field errors arrive in English from the server action; translated for display only. */
function translateFieldError(t: TFunc, msg: string): string {
  const max = /^Keep this under (\d+) characters$/.exec(msg);
  return max ? t("Keep this under {max} characters", { max: max[1] as string }) : t(msg);
}

const inputClass =
  "w-full rounded-lg border border-line bg-card px-3 py-2.5 text-base text-ink " +
  "focus:border-brand-blue focus:outline-none focus:ring-1 focus:ring-brand-blue";
