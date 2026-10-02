"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";
import { fieldErrors } from "@/lib/appointments/schema";
import { logAndMap, appError, AppErrorCode } from "@/lib/errors/appError";
import type { ActionResult } from "@/lib/appointments/lifecycle-actions";

/**
 * Leave Server Actions. Every decision is the database's: request_leave takes
 * the staff id from the session, decide_leave_request checks the Master
 * administers one of that person's workspaces, and approval writes time off
 * through set_staff_time_off with all its conflict rules. Nothing here sends a
 * staff id or a status.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Choose a time");

const requestSchema = z
  .object({
    startDate: isoDate,
    endDate: isoDate,
    partDay: z.enum(["full", "part"]),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    reason: z.string().trim().max(300, "Keep this under 300 characters").optional(),
  })
  .superRefine((v, ctx) => {
    if (v.endDate < v.startDate) {
      ctx.addIssue({ code: "custom", path: ["endDate"], message: "End date must be on or after the start date" });
    }
    if (v.partDay === "part") {
      if (v.startDate !== v.endDate) {
        ctx.addIssue({ code: "custom", path: ["endDate"], message: "Part of a day must be a single date" });
      }
      if (!hhmm.safeParse(v.startTime).success) ctx.addIssue({ code: "custom", path: ["startTime"], message: "Choose a time" });
      if (!hhmm.safeParse(v.endTime).success) ctx.addIssue({ code: "custom", path: ["endTime"], message: "Choose a time" });
      else if ((v.startTime ?? "") >= (v.endTime ?? "")) {
        ctx.addIssue({ code: "custom", path: ["endTime"], message: "End time must be after the start time" });
      }
    }
  });

function revalidateLeave() {
  for (const path of ["/my/leave", "/my/calendar", "/dashboard", "/calendar", "/availability"]) {
    revalidatePath(path);
  }
}

export async function requestLeaveAction(formData: FormData): Promise<ActionResult> {
  const parsed = requestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR), fields: fieldErrors(parsed.error) };
  }
  const v = parsed.data;
  const session = await getSessionContext();
  if (!session?.staffId) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const supabase = await createClient();
  const { error } = await supabase.rpc("request_leave", {
    p_start_date: v.startDate,
    p_end_date: v.endDate,
    p_start_time: v.partDay === "part" ? v.startTime : null,
    p_end_time: v.partDay === "part" ? v.endTime : null,
    p_reason: v.reason ? v.reason : null,
  });
  if (error) return { status: "error", error: logAndMap("requestLeave", error) };

  revalidateLeave();
  return { status: "success" };
}

const idSchema = z.object({ requestId: z.string().uuid() });

export async function cancelLeaveAction(formData: FormData): Promise<ActionResult> {
  const parsed = idSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_leave_request", { p_request_id: parsed.data.requestId });
  if (error) return { status: "error", error: logAndMap("cancelLeave", error) };
  revalidateLeave();
  return { status: "success" };
}

const decideSchema = z.object({
  requestId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

export async function decideLeaveAction(formData: FormData): Promise<ActionResult> {
  const parsed = decideSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };
  const session = await getSessionContext();
  if (!session?.isMaster) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_leave_request", {
    p_request_id: parsed.data.requestId,
    p_approve: parsed.data.decision === "approve",
    p_note: null,
  });
  if (error) return { status: "error", error: logAndMap("decideLeave", error) };
  revalidateLeave();
  return { status: "success" };
}
