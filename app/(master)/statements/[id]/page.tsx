import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { getContractors, getStatement } from "@/lib/statements/queries";
import { StatementEditor } from "@/components/statements/StatementEditor";
import { getI18n } from "@/lib/i18n/server";

export const metadata = { title: "Statement — Mr Clean & Clean Ops" };

/** View / edit one statement. KC only. */
export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionContext();
  if (!session) redirect("/login");
  if (!session.isSuperMaster) notFound();
  const { t } = await getI18n();

  const [statement, contractors] = await Promise.all([getStatement((await params).id), getContractors()]);
  if (!statement) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-24">
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-ink">{t("Statement {no}", { no: statement.statementNo })}</h1>
        <Link href="/statements" className="shrink-0 rounded-lg border border-line bg-card px-3 py-2 text-sm font-medium text-ink hover:bg-sunken">
          {t("Back")}
        </Link>
      </div>
      <StatementEditor
        statementId={statement.id}
        statementNo={statement.statementNo}
        contractors={contractors}
        initial={{
          staffId: statement.staffId,
          issueDate: statement.issueDate,
          periodFrom: statement.periodFrom ?? "",
          periodTo: statement.periodTo ?? "",
          contractorName: statement.contractorName,
          contractorIdNumber: statement.contractorIdNumber ?? "",
          contractorContact: statement.contractorContact ?? "",
          lines: statement.lines.map((l) => ({ date: l.date ?? "", description: l.description, amount: String(l.amount) })),
          deductions: statement.deductions.map((x) => ({ label: x.label, amount: String(x.amount) })),
          paymentMethod: statement.paymentMethod ?? "",
          paymentReference: statement.paymentReference ?? "",
          paymentDate: statement.paymentDate ?? "",
        }}
      />
    </div>
  );
}
