"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";
import { getAppointmentDetail } from "@/lib/appointments/detail";
import { fieldErrors } from "@/lib/appointments/schema";
import { logAndMap, appError, AppErrorCode } from "@/lib/errors/appError";
import type { ActionResult } from "@/lib/appointments/lifecycle-actions";

/**
 * Add-on Server Actions (migration 0013).
 *
 * Same shape as the lifecycle actions: re-resolve the session, re-read the
 * appointment through RLS, then call the trusted RPC. The RPC decides who is
 * credited — the browser never sends a staff id — and refuses anyone who is
 * neither a Master of the workspace nor the assigned staff member.
 */

const addSchema = z.object({
  appointmentId: z.string().uuid(),
  description: z.string().trim().min(1, "What was added?").max(120, "Keep this under 120 characters"),
  amount: z.coerce
    .number({ message: "Enter an amount" })
    .positive("Amount must be more than 0")
    .max(100000, "That amount looks too large"),
});

function revalidateFor(appointmentId: string) {
  for (const path of [
    `/appointments/${appointmentId}`, `/my/appointments/${appointmentId}`, "/reports/monthly",
  ]) {
    revalidatePath(path);
  }
}

export async function addAddonAction(formData: FormData): Promise<ActionResult> {
  const parsed = addSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: fieldErrors(parsed.error) };
  }
  const input = parsed.data;

  const session = await getSessionContext();
  if (!session) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };
  // Hidden and nonexistent are the same answer, on purpose.
  const detail = await getAppointmentDetail(session, input.appointmentId);
  if (!detail) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const supabase = await createClient();
  const { error } = await supabase.rpc("add_appointment_addon", {
    p_appointment_id: input.appointmentId,
    p_description: input.description,
    p_amount: input.amount,
  });
  if (error) return { status: "error", error: logAndMap("addAddon", error) };

  revalidateFor(input.appointmentId);
  return { status: "success" };
}

const removeSchema = z.object({ appointmentId: z.string().uuid(), addonId: z.string().uuid() });

export async function removeAddonAction(formData: FormData): Promise<ActionResult> {
  const parsed = removeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };

  const session = await getSessionContext();
  if (!session) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_appointment_addon", { p_addon_id: parsed.data.addonId });
  if (error) return { status: "error", error: logAndMap("removeAddon", error) };

  revalidateFor(parsed.data.appointmentId);
  return { status: "success" };
}
