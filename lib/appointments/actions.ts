"use server";

import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";
import { resolveBookingContext, assertBookable } from "@/lib/appointments/context";
import { bookAppointment } from "@/lib/appointments/booking";
import { parseFormData, fieldErrors, availabilitySchema } from "@/lib/appointments/schema";
import { logAndMap, appError, AppErrorCode, type AppError } from "@/lib/errors/appError";
import { resolveReturnPath } from "@/lib/navigation/return-to";

/**
 * Server Actions are independently callable HTTP endpoints. Nothing about the
 * page that rendered the form is a control: not the layout guard, not the
 * client "mode", not a hidden input, not which fields were displayed.
 *
 * So every action here re-resolves the session and re-derives what that caller
 * may touch, before it builds any RPC arguments. A staff caller's identity is
 * never taken from the request at all — `create_appointment` derives it from
 * the JWT.
 */

export type CreateResult =
  | { status: "success"; appointmentId: string; redirectTo: string }
  | { status: "error"; error: AppError; fields?: Record<string, string> };

export async function createAppointmentAction(
  _prev: CreateResult | null,
  formData: FormData,
): Promise<CreateResult> {
  const session = await getSessionContext();
  if (!session) {
    return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };
  }

  const parsed = parseFormData(formData);
  if (!parsed.success) {
    return {
      status: "error",
      error: appError(AppErrorCode.VALIDATION_ERROR),
      fields: fieldErrors(parsed.error),
    };
  }
  const input = parsed.data;

  // Re-derive what this caller may book. The form's own options are irrelevant.
  const context = await resolveBookingContext(session);

  // Authorization, the RPC call and cache invalidation all live in the shared
  // core, so this surface and Quick Add cannot drift apart.
  const outcome = await bookAppointment(context, {
    workspaceId: input.workspaceId,
    staffId: input.staffId ?? null,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    addressLine: input.addressLine,
    areaCity: input.areaCity,
    apptDate: input.apptDate,
    startTime: input.startTime,
    items: input.items,
    remarks: input.remarks,
    overrideReason: input.overrideReason,
    confirmPast: input.confirmPast,
  });

  if (outcome.status === "error") return outcome;

  return {
    status: "success",
    appointmentId: outcome.appointmentId,
    // Navigation is this surface's concern: the page redirects, Quick Add
    // refreshes in place, so the core does not decide it.
    redirectTo: resolveReturnPath(input.returnTo, context.mode),
  };
}

export type AvailabilityResult =
  | { status: "ok"; slots: Array<{ date: string; time: string }> }
  | { status: "error"; error: AppError };

/**
 * Availability suggestions. STANDARD-JOB ONLY.
 *
 * Note what is NOT passed: amount, duration, buffer, or candidate times. That
 * is the fix from migration 0007 — a caller-controlled probe window let a
 * Shared-only Master binary-search a hidden cross-workspace appointment's start
 * time to the minute. Do not add an amount parameter back here, and do not
 * re-run this when the item total changes.
 */
export async function findAvailabilityAction(input: {
  workspaceId: string;
  staffId: string;
  from: string;
  to: string;
}): Promise<AvailabilityResult> {
  const session = await getSessionContext();
  if (!session) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const parsed = availabilitySchema.safeParse(input);
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };

  const context = await resolveBookingContext(session);
  const allowed = assertBookable(context, parsed.data.workspaceId, parsed.data.staffId);
  if (!allowed.ok) {
    // No rows, no error detail — the same answer a genuinely empty schedule
    // gives, so this cannot be used to test whether a staff member exists.
    return { status: "ok", slots: [] };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("find_available_slots", {
    p_staff_ids: [parsed.data.staffId],
    p_from: parsed.data.from,
    p_to: parsed.data.to,
    p_workspace_id: parsed.data.workspaceId,
  });

  if (error) return { status: "error", error: logAndMap("findAvailability", error) };

  const rows = (data ?? []) as Array<{ slot_date: string; slot_time: string }>;
  return {
    status: "ok",
    slots: rows.map((r) => ({ date: r.slot_date, time: r.slot_time.slice(0, 5) })),
  };
}
