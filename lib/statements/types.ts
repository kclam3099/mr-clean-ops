/** A Statement of Services Rendered (migration 0022), as the document draws it. */
export type StatementLine = { date: string | null; description: string; amount: number };
export type StatementDeduction = { label: string; amount: number };

export type StatementDoc = {
  statementNo: string;
  /** YYYY-MM-DD */
  issueDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  contractorName: string;
  contractorIdNumber: string | null;
  contractorContact: string | null;
  lines: StatementLine[];
  grossTotal: number;
  deductions: StatementDeduction[];
  deductionTotal: number;
  netAmount: number;
  paymentMethod: string | null;
  paymentReference: string | null;
  paymentDate: string | null;
};

export type Statement = StatementDoc & { id: string; staffId: string };

/** The fixed acknowledgement wording the contractor signs. */
export const RECEIPT_ACKNOWLEDGEMENT =
  "I hereby acknowledge receipt of the payment stated above for services rendered as an independent contractor.";

/** "2026-10-03" -> "3/10/2026", the same way the invoices write dates. */
export function dmy(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}/${m}/${y}`;
}
