"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";
import { getAppointmentDetail } from "@/lib/appointments/detail";
import { itemSchema, fieldErrors } from "@/lib/appointments/schema";
import { logAndMap, appError, AppErrorCode, type AppError } from "@/lib/errors/appError";

/**
 * Appointment lifecycle Server Actions.
 *
 * Each is an independently callable endpoint, so each re-resolves the session
 * and re-reads the appointment through RLS before touching anything. An
 * appointment the caller cannot see reads back as null and is refused with the
 * same generic result as one that does not exist.
 *
 * All mutation goes through the trusted RPCs. There is no direct table write
 * anywhere in this file — the database owns overlap, buffers, working hours,
 * the RM600 rule, override permission, status transitions and concurrency.
 *
 * Override support is NOT uniform across the RPCs, which the O1 audit
 * confirmed against the deployed definitions:
 *
 *   update_appointment          takes p_large_job_override_reason
 *   update_appointment_items    takes p_large_job_override_reason
 *   reschedule_appointment      takes p_large_job_override_reason
 *   cancel_appointment          does NOT
 *   mark_appointment_completed  does NOT
 *
 * So the override retry exists only on the first three.
 */

export type ActionResult =
  | { status: "success" }
  | { status: "error"; error: AppError; fields?: Record<string, string> };

const uuid = z.string().uuid();
const trimmed = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, `Keep this under ${max} characters`);

/** Refuses early when the caller cannot see the appointment at all. */
async function requireVisible(appointmentId: string) {
  const session = await getSessionContext();
  if (!session) return { ok: false as const, error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const detail = await getAppointmentDetail(session, appointmentId);
  // Hidden and nonexistent are the same answer, on purpose.
  if (!detail) return { ok: false as const, error: appError(AppErrorCode.NOT_AUTHORIZED) };

  return { ok: true as const, session, detail };
}

function revalidateAll(appointmentId: string) {
  for (const path of [
    "/calendar", "/appointments", `/appointments/${appointmentId}`,
    "/my/today", "/my/tomorrow", "/my/month", `/my/appointments/${appointmentId}`,
  ]) {
    revalidatePath(path);
  }
}

// ---------------------------------------------------------------------------
// Customer details
// ---------------------------------------------------------------------------
const customerSchema = z.object({
  appointmentId: uuid,
  customerName: trimmed(1, 120, "Customer name is required"),
  customerPhone: trimmed(1, 40, "Phone number is required"),
  addressLine: trimmed(1, 300, "Address is required"),
  // NOT NULL in the database, as F2 discovered the hard way.
  areaCity: trimmed(1, 120, "Area or city is required"),
  remarks: z.string().trim().max(2000).optional().transform((v) => (v ? v : null)),
  overrideReason: z.string().trim().max(500).optional().transform((v) => (v ? v : null)),
});

export async function updateCustomerAction(formData: FormData): Promise<ActionResult> {
  const parsed = customerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: fieldErrors(parsed.error) };
  }
  const input = parsed.data;

  const visible = await requireVisible(input.appointmentId);
  if (!visible.ok) return { status: "error", error: visible.error };

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_appointment", {
    p_appointment_id: input.appointmentId,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    p_address_line: input.addressLine,
    p_area_city: input.areaCity,
    p_remarks: input.remarks,
    // The browser never sets duration; the server recalculates from items.
    p_final_duration_override_min: null,
    // Masters only. A staff caller sending one is refused by the RPC anyway.
    p_large_job_override_reason: visible.session.isMaster ? input.overrideReason : null,
  });
  if (error) return { status: "error", error: logAndMap("updateCustomer", error) };

  revalidateAll(input.appointmentId);
  return { status: "success" };
}

// ---------------------------------------------------------------------------
// Job items
// ---------------------------------------------------------------------------
export async function updateItemsAction(formData: FormData): Promise<ActionResult> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [key, value] of formData.entries()) {
    const m = key.match(/^items\.(\d+)\.(description|quantity|unitPrice)$/);
    if (!m) continue;
    (rows[Number(m[1])] ??= {})[m[2] as string] = value;
  }

  const parsed = z.object({
    appointmentId: uuid,
    items: z.array(itemSchema).min(1, "Add at least one service item").max(50),
    overrideReason: z.string().trim().max(500).optional().transform((v) => (v ? v : null)),
  }).safeParse({
    appointmentId: formData.get("appointmentId"),
    items: rows.filter(Boolean),
    overrideReason: formData.get("overrideReason") || undefined,
  });
  if (!parsed.success) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: fieldErrors(parsed.error) };
  }
  const input = parsed.data;

  const visible = await requireVisible(input.appointmentId);
  if (!visible.ok) return { status: "error", error: visible.error };

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_appointment_items", {
    p_appointment_id: input.appointmentId,
    p_items: input.items.map((i) => ({
      description: i.description, quantity: i.quantity, unit_price: i.unitPrice,
    })),
    // Expanding the items can push the appointment past working hours or into
    // another booking; the RPC revalidates the whole slot and refuses.
    p_final_duration_override_min: null,
    p_large_job_override_reason: visible.session.isMaster ? input.overrideReason : null,
  });
  if (error) return { status: "error", error: logAndMap("updateItems", error) };

  revalidateAll(input.appointmentId);
  return { status: "success" };
}

// ---------------------------------------------------------------------------
// Reschedule
// ---------------------------------------------------------------------------
const rescheduleSchema = z.object({
  appointmentId: uuid,
  apptDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date"),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time as HH:MM"),
  overrideReason: z.string().trim().max(500).optional().transform((v) => (v ? v : null)),
});

export async function rescheduleAction(formData: FormData): Promise<ActionResult> {
  const parsed = rescheduleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: fieldErrors(parsed.error) };
  }
  const input = parsed.data;

  const visible = await requireVisible(input.appointmentId);
  if (!visible.ok) return { status: "error", error: visible.error };

  const supabase = await createClient();
  const { error } = await supabase.rpc("reschedule_appointment", {
    p_appointment_id: input.appointmentId,
    p_new_date: input.apptDate,
    p_new_start_time: input.startTime,
    p_large_job_override_reason: visible.session.isMaster ? input.overrideReason : null,
  });
  if (error) return { status: "error", error: logAndMap("reschedule", error) };

  revalidateAll(input.appointmentId);
  return { status: "success" };
}

// ---------------------------------------------------------------------------
// Cancel — no override parameter exists on this RPC
// ---------------------------------------------------------------------------
export async function cancelAction(formData: FormData): Promise<ActionResult> {
  const parsed = z.object({
    appointmentId: uuid,
    reason: z.string().trim().max(500).optional().transform((v) => (v ? v : null)),
  }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: fieldErrors(parsed.error) };
  }

  const visible = await requireVisible(parsed.data.appointmentId);
  if (!visible.ok) return { status: "error", error: visible.error };

  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_appointment", {
    p_appointment_id: parsed.data.appointmentId,
    p_reason: parsed.data.reason,
  });
  if (error) return { status: "error", error: logAndMap("cancel", error) };

  revalidateAll(parsed.data.appointmentId);
  return { status: "success" };
}

// ---------------------------------------------------------------------------
// Complete — no override parameter; staff permission is a company setting the
// RPC reads for itself
// ---------------------------------------------------------------------------
export async function completeAction(formData: FormData): Promise<ActionResult> {
  const parsed = z.object({ appointmentId: uuid }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };
  }

  const visible = await requireVisible(parsed.data.appointmentId);
  if (!visible.ok) return { status: "error", error: visible.error };

  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_appointment_completed", {
    p_appointment_id: parsed.data.appointmentId,
  });
  if (error) return { status: "error", error: logAndMap("complete", error) };

  revalidateAll(parsed.data.appointmentId);
  return { status: "success" };
}

// ---------------------------------------------------------------------------
// Availability for the reschedule panel — standard-job only, exactly as F2
// ---------------------------------------------------------------------------
export async function rescheduleAvailabilityAction(input: {
  appointmentId: string; from: string; to: string;
}): Promise<{ slots: string[] }> {
  const parsed = z.object({
    appointmentId: uuid,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).safeParse(input);
  if (!parsed.success) return { slots: [] };

  const visible = await requireVisible(parsed.data.appointmentId);
  if (!visible.ok || !visible.detail.staffId) return { slots: [] };

  const supabase = await createClient();
  // No amount, duration or buffer — see migration 0007. Suggestions are
  // standard-job only and must never become amount-aware again.
  const { data, error } = await supabase.rpc("find_available_slots", {
    p_staff_ids: [visible.detail.staffId],
    p_from: parsed.data.from,
    p_to: parsed.data.to,
    p_workspace_id: visible.detail.workspaceId,
  });
  if (error) return { slots: [] };

  const rows = (data ?? []) as Array<{ slot_time: string }>;
  return { slots: rows.map((r) => r.slot_time.slice(0, 5)) };
}
