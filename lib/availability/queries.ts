"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/serverClient";
import { getSessionContext } from "@/lib/auth/session";
import { resolveBookingContext } from "@/lib/appointments/context";
import { logAndMap, appError, AppErrorCode, type AppError } from "@/lib/errors/appError";
import { MAX_RANGE_DAYS, OPERATIONAL_WORKSPACE_SLUG } from "@/lib/availability/constants";

/**
 * Availability for the customer-facing message.
 *
 * It calls the SAME four-argument RPC as the booking form:
 *
 *   find_available_slots(p_staff_ids, p_from, p_to, p_workspace_id)
 *
 * No amount, no duration, no buffer, no caller-supplied probe times. Migration
 * 0007 removed the amount-taking signature because varying it let a caller
 * binary-search a hidden appointment's start time. Nothing here may reintroduce
 * that, in any shape. The RPC also skips slots that have already passed today,
 * so a time the customer could not take is never advertised.
 *
 * The response carries ONLY dates and times. No staff id and no staff name is
 * serialised at all, because the message never names anyone — collapsing the
 * staff dimension server-side means there is nothing for the browser to leak.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const searchSchema = z.object({
  from: isoDate,
  to: isoDate,
});

export type CustomerSlot = { date: string; time: string };

export type CustomerAvailabilityResult =
  | { status: "ok"; slots: CustomerSlot[] }
  | { status: "error"; error: AppError };

export async function findCustomerAvailabilityAction(raw: unknown): Promise<CustomerAvailabilityResult> {
  const session = await getSessionContext();
  if (!session) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const parsed = searchSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", error: appError(AppErrorCode.VALIDATION_ERROR) };
  const { from, to } = parsed.data;

  if (from > to) {
    return {
      status: "error",
      error: { ...appError(AppErrorCode.VALIDATION_ERROR), message: "The end date is before the start date." },
    };
  }
  if (daysBetween(from, to) >= MAX_RANGE_DAYS) {
    return {
      status: "error",
      error: {
        ...appError(AppErrorCode.VALIDATION_ERROR),
        message: `Choose a range of ${MAX_RANGE_DAYS} days or fewer.`,
      },
    };
  }

  // The operational team, resolved from the caller's own RLS-visible set. For a
  // Partner Master this is simply their only workspace, so the same code path
  // serves both and no private team can enter the customer message.
  const context = await resolveBookingContext(session);
  const workspace = await resolveOperationalWorkspace(context.workspaces.map((w) => w.id));
  if (!workspace) return { status: "ok", slots: [] };

  const staffIds = context.workspaces.find((w) => w.id === workspace)?.staff.map((s) => s.id) ?? [];
  if (staffIds.length === 0) return { status: "ok", slots: [] };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("find_available_slots", {
    p_staff_ids: staffIds,
    p_from: from,
    p_to: to,
    p_workspace_id: workspace,
  });

  if (error) return { status: "error", error: logAndMap("customerAvailability", error) };

  // Collapse the staff dimension here, on the server. The customer does not
  // care who comes, and the browser never needs to know.
  const seen = new Set<string>();
  const slots: CustomerSlot[] = [];
  for (const r of (data ?? []) as Array<{ slot_date: string; slot_time: string }>) {
    const time = r.slot_time.slice(0, 5);
    const key = `${r.slot_date}|${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ date: r.slot_date, time });
  }
  slots.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

  return { status: "ok", slots };
}

/**
 * Which workspace the customer-facing message speaks for.
 *
 * V1 convention: the workspace whose slug marks it as the operational team,
 * falling back to the caller's only workspace. There is no is_private or
 * is_customer_facing column on `workspaces` yet, so the slug is the closest
 * thing to a stable marker — a display name would be worse, since names are
 * meant to be editable.
 */
async function resolveOperationalWorkspace(visibleIds: string[]): Promise<string | null> {
  if (visibleIds.length === 0) return null;
  if (visibleIds.length === 1) return visibleIds[0] as string;

  const supabase = await createClient();
  const { data } = await supabase
    .from("workspaces")
    .select("id, slug")
    .in("id", visibleIds);

  const rows = (data ?? []) as Array<{ id: string; slug: string }>;
  return rows.find((w) => w.slug === OPERATIONAL_WORKSPACE_SLUG)?.id ?? (visibleIds[0] as string);
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
