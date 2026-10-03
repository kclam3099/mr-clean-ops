"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveContractorProfileAction } from "@/lib/statements/actions";
import type { AppError } from "@/lib/errors/appError";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { useT } from "@/components/i18n/I18nProvider";

type Row = { staffId: string; displayName: string; legalName: string | null; idNumber: string | null; phone: string | null; address: string | null };

/**
 * The contractors' legal details, used to prefill statements. KC only: the
 * table is unreadable to anyone else (0022), so this list is empty for them.
 */
export function ContractorProfiles({ rows }: { rows: Row[] }) {
  const { t } = useT();
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
      {rows.map((r) => <ProfileRow key={r.staffId} row={r} t={t} />)}
    </ul>
  );
}

function ProfileRow({ row, t }: { row: Row; t: ReturnType<typeof useT>["t"] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ legalName: row.legalName ?? "", idNumber: row.idNumber ?? "", phone: row.phone ?? "", address: row.address ?? "" });
  const [error, setError] = useState<AppError | null>(null);
  const [pending, startTransition] = useTransition();
  const missing = !row.legalName || !row.idNumber;

  return (
    <li className="px-4 py-3" data-contractor={row.staffId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{row.displayName}</p>
          <p className="text-xs text-ink-muted">
            {row.legalName ?? t("Full name missing")} · {row.idNumber ?? t("IC missing")}{row.phone ? ` · ${row.phone}` : ""}
          </p>
        </div>
        <button type="button" onClick={() => setOpen((o) => !o)}
          className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${missing ? "border-gold bg-amber/15 text-ink" : "border-line bg-card text-ink"} hover:bg-sunken`}>
          {open ? t("Close") : t("Edit")}
        </button>
      </div>
      {open ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {error ? <div className="sm:col-span-2"><ErrorNotice error={error} /></div> : null}
          {([
            ["legalName", t("Full name (as per IC)"), 200],
            ["idNumber", t("IC / Passport No."), 40],
            ["phone", t("Contact"), 40],
            ["address", t("Address"), 300],
          ] as const).map(([k, label, max]) => (
            <label key={k} className="text-sm font-medium text-ink">
              {label}
              <input value={v[k]} maxLength={max} onChange={(e) => setV({ ...v, [k]: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-card px-3 py-2 text-base" />
            </label>
          ))}
          <button type="button" disabled={pending}
            onClick={() => startTransition(async () => {
              const res = await saveContractorProfileAction({ staffId: row.staffId, ...v });
              if (res.status === "success") { setOpen(false); router.refresh(); } else setError(res.error);
            })}
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 sm:col-span-2">
            {pending ? t("Saving…") : t("Save")}
          </button>
        </div>
      ) : null}
    </li>
  );
}
