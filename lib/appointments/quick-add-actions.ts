"use server";

import { getSessionContext } from "@/lib/auth/session";
import { resolveBookingContext } from "@/lib/appointments/context";
import { bookAppointment } from "@/lib/appointments/booking";
import { quickAddSchema, fieldErrors } from "@/lib/appointments/schema";
import { appError, AppErrorCode, type AppError } from "@/lib/errors/appError";

/**
 * Quick Add — the fast booking path.
 *
 * Two properties matter more than anything else here.
 *
 * 1. The assignment list is fetched by an action when the sheet OPENS, not
 *    embedded in any page. So no staff array reaches the RSC payload of
 *    /calendar, /dashboard or anywhere else — there is nothing to hide with
 *    CSS because nothing was sent. It is built from `resolveBookingContext`,
 *    which enumerates RLS-visible rows first and never filters client-side.
 *
 * 2. The workspace is derived from the chosen staff member, server-side. The
 *    browser never names it, so "All Operations" — a virtual view with no id —
 *    cannot leak into `workspace_id`.
 */

export type QuickAddStaffOption = { id: string; name: string };

export type QuickAddContext =
  | { mode: "master"; staff: QuickAddStaffOption[] }
  | { mode: "staff"; staffName: string | null }
  | { mode: "unavailable" };

/**
 * The authorised assignment options for the caller.
 *
 * Nick receives exactly Jack and Dyron: his queries do not return Victor, so no
 * Victor id, name or count is ever serialised into the response. There is no
 * "hidden" entry, no disabled option and no total.
 */
export async function getQuickAddContextAction(): Promise<QuickAddContext> {
  const session = await getSessionContext();
  if (!session) return { mode: "unavailable" };

  const context = await resolveBookingContext(session);

  if (context.mode === "staff") {
    // Staff never choose a staff member; there is no list to send at all.
    return context.workspaces.length === 0
      ? { mode: "unavailable" }
      : { mode: "staff", staffName: context.selfStaffName };
  }

  // Flat list, deduplicated. Deliberately NOT grouped by workspace — grouping
  // would put workspace names into the payload, which is information about
  // team structure that the assignment step does not need.
  const byId = new Map<string, string>();
  for (const w of context.workspaces) {
    for (const s of w.staff) if (!byId.has(s.id)) byId.set(s.id, s.name);
  }
  const staff = [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return staff.length === 0 ? { mode: "unavailable" } : { mode: "master", staff };
}

export type QuickAddResult =
  | { status: "success"; appointmentId: string; staffName: string }
  /** The chosen staff member belongs to more than one workspace this caller can
   *  see, so attribution is genuinely ambiguous. Ask rather than guess. */
  | { status: "needsWorkspace"; workspaces: Array<{ id: string; name: string }> }
  | { status: "error"; error: AppError; fields?: Record<string, string> };

export async function quickAddCreateAction(raw: unknown): Promise<QuickAddResult> {
  const session = await getSessionContext();
  if (!session) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };

  const parsed = quickAddSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      error: appError(AppErrorCode.VALIDATION_ERROR),
      fields: fieldErrors(parsed.error),
    };
  }
  const input = parsed.data;

  const context = await resolveBookingContext(session);
  const isMaster = context.mode === "master";

  // ---- who ----------------------------------------------------------------
  // Staff identity is never taken from the request; the RPC derives it from the
  // JWT. Anything the client sent is discarded rather than checked.
  const staffId = isMaster ? input.staffId ?? null : null;
  if (isMaster && !staffId) {
    return {
      status: "error",
      error: appError(AppErrorCode.VALIDATION_ERROR),
      fields: { staffId: "Choose a team member." },
    };
  }

  // ---- which workspace ----------------------------------------------------
  // Eligibility comes from the caller's own RLS-visible memberships. A staff id
  // this caller cannot see matches nothing, so a forged Victor uuid and a random
  // uuid produce the identical generic refusal, by the same code path.
  const eligible = isMaster
    ? context.workspaces.filter((w) => w.staff.some((s) => s.id === staffId))
    : context.workspaces;

  if (eligible.length === 0) {
    console.warn(`[quickAdd] no eligible workspace for the requested assignment`);
    return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };
  }

  let workspaceId: string;
  if (input.workspaceId) {
    // An answer to the ambiguity question — re-checked, never trusted.
    const match = eligible.find((w) => w.id === input.workspaceId);
    if (!match) return { status: "error", error: appError(AppErrorCode.NOT_AUTHORIZED) };
    workspaceId = match.id;
  } else if (eligible.length === 1) {
    workspaceId = eligible[0]!.id;
  } else {
    return {
      status: "needsWorkspace",
      workspaces: eligible.map((w) => ({ id: w.id, name: w.name })),
    };
  }

  // ---- book ---------------------------------------------------------------
  const outcome = await bookAppointment(context, {
    workspaceId,
    staffId,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    addressLine: input.addressLine,
    areaCity: input.areaCity,
    apptDate: input.apptDate,
    startTime: input.startTime,
    items: input.items,
    remarks: input.remarks,
    overrideReason: input.overrideReason,
  });

  if (outcome.status === "error") return outcome;

  // The name comes from the server's own resolved context, never echoed back
  // from the request.
  const staffName = isMaster
    ? eligible.flatMap((w) => w.staff).find((s) => s.id === staffId)?.name ?? "the team member"
    : context.selfStaffName ?? "you";

  return { status: "success", appointmentId: outcome.appointmentId, staffName };
}
