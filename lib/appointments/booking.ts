import "server-only";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/serverClient";
import { assertBookable, type BookingContext } from "@/lib/appointments/context";
import { logAndMap, appError, AppErrorCode, type AppError } from "@/lib/errors/appError";

/**
 * The single path from an authorised request to `create_appointment`.
 *
 * Both booking surfaces go through here — the full Add Appointment page and
 * Quick Add — so there is exactly one place that talks to the RPC and exactly
 * one set of rules about what the browser may influence. A second engine is
 * how two surfaces quietly drift apart until one of them is wrong.
 *
 * What this deliberately does NOT do: navigation. The page redirects, Quick Add
 * refreshes in place. Callers own that.
 */

export type BookingInput = {
  workspaceId: string;
  /** Master only. Ignored for staff — the RPC derives identity from the JWT. */
  staffId: string | null;
  customerName: string;
  customerPhone: string;
  addressLine: string;
  areaCity: string;
  apptDate: string;
  startTime: string;
  items: Array<{ description: string; quantity: number; unitPrice: number }>;
  remarks: string | null;
  overrideReason: string | null;
};

export type BookingOutcome =
  | { status: "success"; appointmentId: string }
  | { status: "error"; error: AppError; fields?: Record<string, string> };

export async function bookAppointment(
  context: BookingContext,
  input: BookingInput,
): Promise<BookingOutcome> {
  // Re-derive what this caller may book. The form's own options are irrelevant,
  // and so is anything Quick Add rendered — a Server Action is a public
  // endpoint reachable without either.
  const allowed = assertBookable(context, input.workspaceId, input.staffId);
  if (!allowed.ok) {
    // Deliberately the same generic response for "workspace you cannot see",
    // "staff you cannot see" and "staff not in that workspace". Distinguishing
    // them would confirm which entities exist.
    console.warn(`[bookAppointment] rejected ${allowed.field}`);
    return {
      status: "error",
      error: appError(AppErrorCode.NOT_AUTHORIZED),
      fields: { [allowed.field]: "Choose a valid option." },
    };
  }

  // Staff may not override, and their identity is server-derived.
  const isMaster = context.mode === "master";

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_appointment", {
    p_workspace_id: input.workspaceId,
    // null for staff: the RPC resolves the caller's own staff row from the JWT.
    p_staff_id: isMaster ? input.staffId : null,
    p_customer_name: input.customerName,
    p_customer_phone: input.customerPhone,
    p_address_line: input.addressLine,
    p_area_city: input.areaCity,
    p_appt_date: input.apptDate,
    p_start_time: input.startTime,
    p_items: input.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit_price: i.unitPrice,
    })),
    // The browser never supplies duration, buffer, totals or large-job status.
    p_final_duration_override_min: null,
    p_remarks: input.remarks,
    p_large_job_override_reason: isMaster ? input.overrideReason : null,
  });

  if (error) {
    return { status: "error", error: logAndMap("createAppointment", error) };
  }

  // Refresh every surface that could show the new row. Cheap, and avoids a
  // stale agenda after redirect or an in-place refresh.
  for (const path of ["/dashboard", "/calendar", "/appointments", "/my/today", "/my/tomorrow", "/my/month"]) {
    revalidatePath(path);
  }

  return { status: "success", appointmentId: data as string };
}
