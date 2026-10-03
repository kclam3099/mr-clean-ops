import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { businessToday, monthRange, monthLabel } from "@/lib/agenda/queries";
import { getContractors, getCompletedJobLines } from "@/lib/statements/queries";
import { StatementEditor } from "@/components/statements/StatementEditor";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "New statement — Mr Clean & Clean Ops" };

/** A new statement for one contractor and month, prefilled from their completed jobs. KC only. */
export default async function NewStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ staff?: string; month?: string }>;
}) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  if (!session.isSuperMaster) notFound();
  const { t } = await getI18n();

  const params = await searchParams;
  const contractors = await getContractors();
  const contractor = contractors.find((c) => c.staffId === params.staff) ?? contractors[0];
  if (!contractor) notFound();

  const today = businessToday();
  const month = /^\d{4}-\d{2}$/.test(params.month ?? "") ? (params.month as string) : today.slice(0, 7);
  const range = monthRange(`${month}-01`);
  const jobs = await getCompletedJobLines(contractor.staffId, range.from, range.to);
  const monthName = monthLabel(`${month}-01`, "en-GB");

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink">{t("New statement")}</h1>
          <p className="text-sm text-ink-muted">
            {contractor.displayName} · {monthName} ·{" "}
            {jobs.length === 1 ? t("1 completed job") : t("{count} completed jobs", { count: jobs.length })}
          </p>
        </div>
        <Link href="/statements" className="shrink-0 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-ink hover:bg-sunken">
          {t("Back")}
        </Link>
      </div>
      <StatementEditor
        statementId={null}
        statementNo={null}
        contractors={contractors}
        initial={{
          staffId: contractor.staffId,
          issueDate: today,
          periodFrom: range.from,
          periodTo: range.to,
          contractorName: contractor.legalName ?? contractor.displayName,
          contractorIdNumber: contractor.idNumber ?? "",
          contractorContact: contractor.phone ?? "",
          // The fee is KC's to enter: what a contractor is paid is not the customer price.
          lines: jobs.length
            ? jobs.map((j) => ({ date: j.date, description: j.description, amount: "" }))
            : [{ date: "", description: `Outsourced cleaning services — ${monthName}`, amount: "" }],
          deductions: [],
          paymentMethod: "Bank Transfer",
          paymentReference: "",
          paymentDate: today,
        }}
      />
    </div>
  );
}
