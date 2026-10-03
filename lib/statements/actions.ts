"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";
import { logAndMap, appError, AppErrorCode, type AppError } from "@/lib/errors/appError";

/**
 * Super Master only — checked here for a clean refusal, and again by every
 * database function (0022), which is the rule.
 */

type Result<T = object> = ({ status: "success" } & T) | { status: "error"; error: AppError; fields?: Record<string, string> };

async function requireSuperMaster() {
  const session = await getSessionContext();
  return session?.isSuperMaster ? session : null;
}

function fieldsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

const profileSchema = z.object({
  staffId: z.string().uuid(),
  legalName: z.string().trim().max(200, "Keep this under 200 characters"),
  idNumber: z.string().trim().max(40, "Keep this under 40 characters"),
  phone: z.string().trim().max(40, "Keep this under 40 characters"),
  address: z.string().trim().max(300, "Keep this under 300 characters"),
});

export async function saveContractorProfileAction(input: unknown): Promise<Result> {
  if (!(await requireSuperMaster())) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: fieldsOf(parsed.error) };
  const v = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_contractor_profile", {
    p_staff_id: v.staffId, p_legal_name: v.legalName, p_id_number: v.idNumber, p_phone: v.phone, p_address: v.address,
  });
  if (error) return { status: "error", error: logAndMap("saveContractorProfile", error) };
  revalidatePath("/statements");
  return { status: "success" };
}

const isoOrEmpty = z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, "Choose a date");
const statementSchema = z.object({
  statementId: z.string().uuid().nullable(),
  staffId: z.string().uuid(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
  periodFrom: isoOrEmpty,
  periodTo: isoOrEmpty,
  contractorName: z.string().trim().min(1, "Enter the contractor's full name").max(200, "Keep this under 200 characters"),
  contractorIdNumber: z.string().trim().max(40, "Keep this under 40 characters"),
  contractorContact: z.string().trim().max(200, "Keep this under 200 characters"),
  lines: z.array(z.object({
    date: isoOrEmpty,
    description: z.string().trim().min(1, "Describe the work").max(300, "Keep this under 300 characters"),
    amount: z.coerce.number({ message: "Enter an amount" }).min(0, "Amount cannot be negative"),
  })).min(1, "Add at least one line").max(60),
  deductions: z.array(z.object({
    label: z.string().trim().min(1, "Describe the deduction").max(120, "Keep this under 120 characters"),
    amount: z.coerce.number({ message: "Enter an amount" }).min(0, "Amount cannot be negative"),
  })).max(10),
  paymentMethod: z.string().trim().max(60, "Keep this under 60 characters"),
  paymentReference: z.string().trim().max(200, "Keep this under 200 characters"),
  paymentDate: isoOrEmpty,
});

export async function saveStatementAction(input: unknown): Promise<Result<{ statementId: string; statementNo: string }>> {
  if (!(await requireSuperMaster())) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };
  const parsed = statementSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: fieldsOf(parsed.error) };
  const v = parsed.data;
  const gross = v.lines.reduce((s, l) => s + l.amount, 0);
  const deducted = v.deductions.reduce((s, d) => s + d.amount, 0);
  if (deducted > gross) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: { deductions: "Deductions are more than the gross fee" } };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_contractor_statement", {
    p_statement_id: v.statementId,
    p_staff_id: v.staffId,
    p_issue_date: v.issueDate,
    p_period_from: v.periodFrom || null,
    p_period_to: v.periodTo || null,
    p_contractor_name: v.contractorName,
    p_contractor_id: v.contractorIdNumber || null,
    p_contractor_contact: v.contractorContact || null,
    p_lines: v.lines.map((l) => ({ date: l.date || null, description: l.description, amount: l.amount })),
    p_deductions: v.deductions,
    p_payment_method: v.paymentMethod || null,
    p_payment_reference: v.paymentReference || null,
    p_payment_date: v.paymentDate || null,
  });
  if (error) return { status: "error", error: logAndMap("saveStatement", error) };
  const row = (Array.isArray(data) ? data[0] : data) as { statement_id: string; statement_no: string } | undefined;
  if (!row) return { status: "error", error: appError(AppErrorCode.UNEXPECTED) };
  revalidatePath("/statements");
  revalidatePath(`/statements/${row.statement_id}`);
  return { status: "success", statementId: row.statement_id, statementNo: row.statement_no };
}

export async function deleteStatementAction(input: unknown): Promise<Result> {
  if (!(await requireSuperMaster())) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };
  const parsed = z.object({ statementId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_contractor_statement", { p_statement_id: parsed.data.statementId });
  if (error) return { status: "error", error: logAndMap("deleteStatement", error) };
  revalidatePath("/statements");
  return { status: "success" };
}
