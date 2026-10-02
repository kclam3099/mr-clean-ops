"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LeaveRequest, LeaveStatus } from "@/lib/leave/queries";
import { cancelLeaveAction } from "@/lib/leave/actions";
import type { ActionResult } from "@/lib/appointments/lifecycle-actions";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { useT } from "@/components/i18n/I18nProvider";
import { leaveWhen, leaveDays } from "./format";

const STATUS: Record<LeaveStatus, { label: string; cls: string }> = {
  pending: { label: "Waiting for approval", cls: "bg-amber/20 text-warn" },
  approved: { label: "Approved", cls: "bg-ok/10 text-ok" },
  rejected: { label: "Rejected", cls: "bg-danger/10 text-danger" },
  cancelled: { label: "Cancelled", cls: "bg-sunken text-ink-muted" },
};

/** This person's own requests, newest first. Only a pending one can be withdrawn. */
export function MyLeaveList({ requests }: { requests: LeaveRequest[] }) {
  const { t, locale } = useT();
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (requests.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">
        {t("No leave requests yet.")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {result?.status === "error" ? <ErrorNotice error={result.error} /> : null}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
        {requests.map((r) => {
          const s = STATUS[r.status];
          const days = leaveDays(r);
          return (
            <li key={r.id} data-leave-row={r.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{leaveWhen(r, locale)}</p>
                <p className="text-xs text-ink-muted">
                  {r.startTime ? t("Part of a day") : days === 1 ? t("1 day") : t("{count} days", { count: days })}
                  {r.reason ? ` · ${r.reason}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{t(s.label)}</span>
                {r.status === "pending" ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      if (!window.confirm(t("Withdraw this leave request?"))) return;
                      const fd = new FormData();
                      fd.set("requestId", r.id);
                      startTransition(async () => {
                        const res = await cancelLeaveAction(fd);
                        setResult(res);
                        if (res.status === "success") router.refresh();
                      });
                    }}
                    className="cursor-pointer text-xs font-medium text-ink-muted underline-offset-2 hover:text-danger hover:underline disabled:opacity-50"
                  >
                    {t("Withdraw")}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
