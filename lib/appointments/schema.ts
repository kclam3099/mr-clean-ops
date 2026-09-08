import { z } from "zod";
import { isReturnKey } from "@/lib/navigation/return-to";

/**
 * Shape validation at the Server Action boundary.
 *
 * This is NOT authorization. It answers "is this a well-formed booking
 * request", never "may this caller book it". Workspace and staff access is
 * re-derived from the session in the action itself, and the database has the
 * final say on availability, duration, the RM600 rule, buffers and privacy.
 *
 * Its real job is to stop malformed or oversized input reaching the RPC, and
 * to give the form field-level errors.
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time as HH:MM");

const trimmed = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, `Keep this under ${max} characters`);

export const itemSchema = z.object({
  description: trimmed(1, 200, "Describe the service"),
  quantity: z.coerce.number().int().min(1, "At least 1").max(999, "Too many"),
  unitPrice: z.coerce
    .number()
    .min(0, "Price cannot be negative")
    .max(1_000_000, "Price looks too large"),
});

export const createAppointmentSchema = z.object({
  workspaceId: uuid,
  // Master only. Absent for staff — the RPC derives identity from the session,
  // and the staff form never renders this field.
  staffId: uuid.nullable().optional(),

  // customer_name, customer_phone, address_line and area_city are all NOT NULL
  // in the database. Treating area_city as optional sent a null and produced an
  // unmapped constraint violation — the user lost the booking to a generic
  // "something went wrong". Only `remarks` is genuinely nullable.
  customerName: trimmed(1, 120, "Customer name is required"),
  customerPhone: trimmed(1, 40, "Phone number is required"),
  addressLine: trimmed(1, 300, "Address is required"),
  areaCity: trimmed(1, 120, "Area or city is required"),
  remarks: z.string().trim().max(2000).optional().transform((v) => (v ? v : null)),

  apptDate: isoDate,
  startTime: time,

  items: z.array(itemSchema).min(1, "Add at least one service item").max(50),

  // Present only when the user has explicitly confirmed a historical record.
  // Anything other than the literal true is false, so a stray or malformed
  // value cannot become consent.
  confirmPast: z.coerce.boolean().optional().transform((v) => v === true),

  // Present only on the override retry. A non-empty reason is required there;
  // whether the caller MAY override is decided by the database.
  overrideReason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : null)),

  // An unrecognised destination is DROPPED, not rejected. Failing the parse
  // would let a stray or hostile query parameter block an otherwise valid
  // booking. The real control is the enum lookup in resolveReturnPath, which
  // cannot produce a destination it does not have.
  returnTo: z
    .string()
    .optional()
    .transform((v) => (isReturnKey(v) ? v : undefined)),
});

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

/**
 * Quick Add sends the same booking, minus the workspace.
 *
 * The workspace is DERIVED server-side from the staff member chosen at the end
 * of the flow, so the browser never picks it. `workspaceId` is optional here
 * only for the multi-workspace exception, where the server asked the question
 * and the answer comes back — and even then it is re-checked against the
 * caller's own eligible set before it is used.
 *
 * `returnTo` is absent by design: Quick Add is an overlay and refreshes in
 * place rather than navigating, so there is no destination to be tricked into.
 */
export const quickAddSchema = createAppointmentSchema
  .omit({ workspaceId: true, returnTo: true })
  .extend({ workspaceId: uuid.optional() });

export type QuickAddInput = z.infer<typeof quickAddSchema>;

export const availabilitySchema = z.object({
  workspaceId: uuid,
  staffId: uuid,
  from: isoDate,
  to: isoDate,
});

/**
 * Items arrive as parallel indexed fields (`items.0.description`, ...). Parsing
 * them here keeps the client free to add and remove rows without maintaining a
 * contiguous index.
 */
export function parseFormData(formData: FormData) {
  const items: Array<Record<string, unknown>> = [];
  for (const [key, value] of formData.entries()) {
    const match = key.match(/^items\.(\d+)\.(description|quantity|unitPrice)$/);
    if (!match) continue;
    const [, index, field] = match;
    const i = Number(index);
    (items[i] ??= {})[field as string] = value;
  }

  const str = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  return createAppointmentSchema.safeParse({
    workspaceId: str("workspaceId"),
    staffId: str("staffId") ?? null,
    customerName: str("customerName"),
    customerPhone: str("customerPhone"),
    addressLine: str("addressLine"),
    areaCity: str("areaCity"),
    remarks: str("remarks"),
    apptDate: str("apptDate"),
    startTime: str("startTime"),
    items: items.filter(Boolean),
    overrideReason: str("overrideReason"),
    confirmPast: str("confirmPast") === "true",
    returnTo: str("returnTo"),
  });
}

/** Flatten zod issues into `{ fieldName: message }` for inline display. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}
