"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { LeaveRequest } from "@/lib/leave/queries";
import { decideLeaveAction } from "@/lib/leave/actions";
import type { ActionResult } from "@/lib/appointments/lifecycle-actions";
import { ErrorNotice } from "@/components/ui/ErrorNotice";
import { useT } from "@/components/i18n/I18nProvider";
import { leaveWhen, leaveDays } from "./format";

/**
 * Pending leave this Master may decide. The list is whatever RLS returned, so
 * each Master sees only the people they manage: KC sees Victor, Dyron and
 * Jack; Nick sees Dyron and Jack. Whichever of them decides first settles it —
 * the other gets "already decided".
 *
 * Approving writes time off. If the person already has a booked appointment on
 * one of those days, nothing is approved and the Master is told to move the
 * appointment first — the same rule as entering time off by hand.
 */
export function LeaveApprovalsPanel({ requests }: { requests: LeaveRequest[] }) {
  const { t, locale } = useT();
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (requests.length === 0) return null;

  const decide = (id: string, decision: "approve" | "reject") => {
    if (pending) return;
    if (decision === "reject" && !window.confirm(t("Reject this leave request?"))) return;
    const fd = new FormData();
    fd.set("requestId", id);
    fd.set("decision", decision);
    setBusy(id);
    startTransition(async () => {
      const res = await decideLeaveAction(fd);
      setResult(res);
      setBusy(null);
      if (res.status === "success") router.refresh();
    });
  };

  return (
    <section data-leave-approvals className="overflow-hidden rounded-xl border-2 border-gold bg-card">
      <h2 className="flex items-center justify-between gap-2 bg-amber/20 px-4 py-2.5 text-sm font-semibold text-ink">
        <span>{t("Leave requests to approve")}</span>
        <span className="rounded-full bg-gold px-2 py-0.5 text-xs font-bold text-brand-900">{requests.length}</span>
      </h2>
      {result?.status === "error" ? <div className="px-4 pt-3"><ErrorNotice error={result.error} /></div> : null}
      <ul className="divide-y divide-line">
        {requests.map((r) => {
          const days = leaveDays(r);
          return (
            <li key={r.id} data-leave-request={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">
                  {r.staffName ?? t("Staff")} · {leaveWhen(r, locale)}
                </p>
                <p className="text-xs text-ink-muted">
                  {r.startTime ? t("Part of a day") : days === 1 ? t("1 day") : t("{count} days", { count: days })}
                  {r.reason ? ` · ${r.reason}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" disabled={pending} onClick={() => decide(r.id, "reject")}
                  className="min-h-9 cursor-pointer rounded-lg border border-line bg-card px-3 text-sm font-medium text-ink
                             transition hover:bg-sunken disabled:opacity-50">
                  {t("Reject")}
                </button>
                <button type="button" disabled={pending} onClick={() => decide(r.id, "approve")}
                  className="min-h-9 cursor-pointer rounded-lg bg-ok px-3 text-sm font-semibold text-white
                             transition hover:brightness-95 disabled:opacity-50">
                  {busy === r.id ? t("Saving…") : t("Approve")}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
