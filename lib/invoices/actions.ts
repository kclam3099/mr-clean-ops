"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";
import { logAndMap, appError, AppErrorCode, type AppError } from "@/lib/errors/appError";

/**
 * Saves an invoice through save_invoice (migration 0018). The database decides
 * everything that matters — who may invoice, that the job is completed, the
 * next MRC number, and the total — so the browser sends only what the person
 * typed. The first save assigns the number; later saves keep it.
 */

const itemSchema = z.object({
  description: z.string().trim().min(1, "Describe the item").max(120, "Keep this under 120 characters"),
  amount: z.coerce.number({ message: "Enter an amount" }).min(0, "Amount cannot be negative").max(100000, "That amount looks too large"),
});

const schema = z.object({
  appointmentId: z.string().uuid(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
  billToName: z.string().trim().min(1, "Enter the customer's name").max(200, "Keep this under 200 characters"),
  billToAddress: z.string().trim().max(500, "Keep this under 500 characters"),
  serviceTitle: z.string().trim().max(200, "Keep this under 200 characters"),
  items: z.array(itemSchema).min(1, "Add at least one item").max(12, "At most 12 items"),
  discountLabel: z.string().trim().max(40, "Keep this under 40 characters"),
  discountAmount: z.coerce.number().min(0, "Amount cannot be negative"),
});

const deleteSchema = z.object({ invoiceId: z.string().uuid(), appointmentId: z.string().uuid() });

/**
 * Deletes an issued invoice — a Master of the job's workspace only (0019).
 * The number is not reused; the series keeps the gap.
 */
export async function deleteInvoiceAction(input: unknown): Promise<{ status: "success" } | { status: "error"; error: AppError }> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };
  const session = await getSessionContext();
  if (!session?.isMaster) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_invoice", { p_invoice_id: parsed.data.invoiceId });
  if (error) return { status: "error", error: logAndMap("deleteInvoice", error) };

  const id = parsed.data.appointmentId;
  for (const path of ["/appointments", `/appointments/${id}`, `/my/appointments/${id}`, `/appointments/${id}/invoice`]) {
    revalidatePath(path);
  }
  return { status: "success" };
}

export type SaveInvoiceResult =
  | { status: "success"; invoiceId: string; invoiceNo: string }
  | { status: "error"; error: AppError; fields?: Record<string, string> };

export async function saveInvoiceAction(input: unknown): Promise<SaveInvoiceResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      if (key && !fields[key]) fields[key] = issue.message;
    }
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields };
  }
  const v = parsed.data;
  const subtotal = v.items.reduce((s, i) => s + i.amount, 0);
  if (v.discountAmount > subtotal) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: { discountAmount: "Discount is more than the items" } };
  }

  const session = await getSessionContext();
  if (!session) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_invoice", {
    p_appointment_id: v.appointmentId,
    p_invoice_date: v.invoiceDate,
    p_bill_to_name: v.billToName,
    p_bill_to_address: v.billToAddress || null,
    p_service_title: v.serviceTitle || null,
    p_items: v.items,
    p_discount_label: v.discountLabel || null,
    p_discount_amount: v.discountAmount,
  });
  if (error) return { status: "error", error: logAndMap("saveInvoice", error) };

  const row = (Array.isArray(data) ? data[0] : data) as { invoice_id: string; invoice_no: string } | undefined;
  if (!row) return { status: "error", error: appError(AppErrorCode.UNEXPECTED) };

  for (const path of [
    "/appointments", `/appointments/${v.appointmentId}`, `/my/appointments/${v.appointmentId}`,
    `/appointments/${v.appointmentId}/invoice`, `/my/appointments/${v.appointmentId}/invoice`,
  ]) {
    revalidatePath(path);
  }
  return { status: "success", invoiceId: row.invoice_id, invoiceNo: row.invoice_no };
}
