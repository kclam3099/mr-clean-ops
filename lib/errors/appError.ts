/**
 * The single boundary between database/RPC errors and anything a user sees.
 *
 * Raw PostgreSQL / PostgREST / RPC text must never reach the browser. Two
 * reasons, and the second is the important one:
 *
 *  1. It is unreadable.
 *  2. It can disclose information the caller is not authorised to have.
 *
 * The appointment engine already strips detail from conflicts the caller cannot
 * see — a hidden cross-workspace conflict comes back as the bare string
 * `STAFF_UNAVAILABLE`, with no time, amount band, reason, customer or
 * appointment id (migration 0004). This module is the second half of that
 * contract: it maps known messages onto a closed set of application states and
 * **drops everything it does not recognise**, so a future message that leaks
 * detail cannot reach the UI by accident.
 *
 * Pure module — no React, no Supabase imports — so it is unit-testable and
 * usable from both Server Actions and Server Components.
 */

export const AppErrorCode = {
  STAFF_UNAVAILABLE: "STAFF_UNAVAILABLE",
  LARGE_JOB_OVERRIDE_REQUIRED: "LARGE_JOB_OVERRIDE_REQUIRED",
  PHYSICAL_OVERLAP: "PHYSICAL_OVERLAP",
  OUTSIDE_WORKING_HOURS: "OUTSIDE_WORKING_HOURS",
  TIME_OFF: "TIME_OFF",
  PAST_DATETIME: "PAST_DATETIME",
  BLOCKING_APPOINTMENTS: "BLOCKING_APPOINTMENTS",
  NOT_AUTHORIZED: "NOT_AUTHORIZED",
  INVALID_APPOINTMENT_STATE: "INVALID_APPOINTMENT_STATE",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNEXPECTED: "UNEXPECTED",
} as const;

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode];

/**
 * Structured, non-sensitive detail. Only ever populated for codes the engine
 * itself decided this caller may see — it replaces them with STAFF_UNAVAILABLE
 * otherwise, so anything reaching here is already authorised.
 */
export type AppErrorDetail = {
  /** e.g. "10:00" — the blocking appointment's start, for overlap/lock states */
  blockingTime?: string;
  /** e.g. "12:00" / "16:00" — the applicable working-hours window */
  windowStart?: string;
  windowEnd?: string;
};

export type AppError = {
  code: AppErrorCode;
  /** Safe to render. Never contains server text. */
  message: string;
  detail: AppErrorDetail;
  /** True when the user can resolve this by supplying a Master override reason. */
  overridable: boolean;
};

/** User-facing copy. Deliberately says less than the server knows. */
const MESSAGES: Record<AppErrorCode, string> = {
  STAFF_UNAVAILABLE:
    "This team member is not available at that time. Please choose another time or another person.",
  LARGE_JOB_OVERRIDE_REQUIRED:
    "A large job is holding the rest of that day. A Master can approve an exception with a reason.",
  PHYSICAL_OVERLAP:
    "That time overlaps an existing appointment. Overlapping bookings are never allowed.",
  OUTSIDE_WORKING_HOURS: "That time is outside working hours.",
  TIME_OFF: "This team member is on time off then.",
  PAST_DATETIME: "That time has already passed. Please choose a future date and time.",
  BLOCKING_APPOINTMENTS:
    "There are upcoming appointments that need to be moved or cancelled first.",
  NOT_AUTHORIZED: "You do not have permission to do that.",
  INVALID_APPOINTMENT_STATE:
    "This appointment can no longer be changed because it is completed or cancelled.",
  VALIDATION_ERROR: "Please check the details and try again.",
  UNEXPECTED: "Something went wrong. Please try again.",
};

const TIME = "(\\d{2}:\\d{2})(?::\\d{2})?";

/**
 * Ordered, most specific first. Each rule owns the ONLY way its code can be
 * produced, and may pull structured detail out of the message — never the
 * message itself.
 */
const RULES: Array<{
  code: AppErrorCode;
  test: RegExp;
  detail?: (m: string) => AppErrorDetail;
}> = [
  // Exact sentinel. Must stay first and must stay an exact match: this is the
  // string the engine uses precisely because it carries nothing.
  { code: AppErrorCode.STAFF_UNAVAILABLE, test: /^STAFF_UNAVAILABLE$/ },

  {
    code: AppErrorCode.PHYSICAL_OVERLAP,
    test: /^PHYSICAL_OVERLAP\b/,
    detail: (m) => pick(m, new RegExp(`at\\s+${TIME}`), "blockingTime"),
  },
  {
    code: AppErrorCode.LARGE_JOB_OVERRIDE_REQUIRED,
    test: /^LARGE_JOB_OVERRIDE_REQUIRED\b/,
    detail: (m) => pick(m, new RegExp(`(?:starting|at)\\s+${TIME}`), "blockingTime"),
  },
  {
    code: AppErrorCode.OUTSIDE_WORKING_HOURS,
    test: /^Outside working hours\b/,
    detail: (m) => {
      const hit = m.match(new RegExp(`\\(${TIME}\\s+to\\s+${TIME}\\)`));
      return hit ? { windowStart: hit[1], windowEnd: hit[2] } : {};
    },
  },
  // Authorization is tested BEFORE time-off. "Only a Master may set staff time
  // off" is an authorization failure, but it contains the words "time off", so
  // the looser rule below would otherwise claim it and tell the user the staff
  // member is unavailable — misleading, and wrong.
  {
    code: AppErrorCode.NOT_AUTHORIZED,
    test: /^Not authorized\b|^Only (a )?(Super Master|Master)\b|may not (override|perform)\b|^Not an active member\b|^No staff profile\b|^Not your appointment\b|^Appointment not found\b|^Staff completion is currently disabled\b|^Moving an appointment to a different workspace\b/i,
  },

  { code: AppErrorCode.TIME_OFF, test: /\btime off\b|\bfull day off\b/i },

  // The past-datetime guard from 0007. Worth its own code: "please check the
  // details" is useless when the real problem is that the time has gone.
  { code: AppErrorCode.PAST_DATETIME, test: /^Appointment must be in the future\b/i },

  // Staff/workspace administration is blocked by real upcoming work. Actionable
  // and non-disclosing: it names no appointment, customer or time.
  {
    code: AppErrorCode.BLOCKING_APPOINTMENTS,
    test: /^Staff has upcoming booked appointments\b|^Conflicts with an existing booked appointment\b/i,
  },

  {
    code: AppErrorCode.INVALID_APPOINTMENT_STATE,
    test: /^Only a booked appointment can be\b/i,
  },
  {
    code: AppErrorCode.VALIDATION_ERROR,
    test: /^At least one service item\b|^Item total must be positive\b|^Multiple active workspace memberships\b|^No active workspace membership\b|^workspace_id and staff_id are required\b|^Staff is not active\b|^Staff is not an active member\b|^An existing booked appointment falls outside\b|^A reason is required\b|^Invalid range\b|^Range too large\b|^Invalid amount\b|^start_time must be before end_time\b|^start_time and end_time must both be\b|^Already an active member\b|^No active membership found to end\b|^Not found\b/i,
  },
];

function pick(message: string, re: RegExp, key: keyof AppErrorDetail): AppErrorDetail {
  const hit = message.match(re);
  return hit?.[1] ? { [key]: hit[1] } : {};
}

/** Shape of a PostgREST/supabase-js error, without importing its types. */
type MaybeSupabaseError = { message?: unknown; code?: unknown } | null | undefined;

function rawMessageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const e = error as MaybeSupabaseError;
  if (e && typeof e.message === "string") return e.message;
  return "";
}

/**
 * Map any thrown/returned error into a safe AppError.
 *
 * Anything unrecognised becomes UNEXPECTED with generic copy — failing closed,
 * so an unrecognised server message cannot be shown verbatim.
 */
export function toAppError(error: unknown): AppError {
  const raw = rawMessageOf(error).trim();

  for (const rule of RULES) {
    if (rule.test.test(raw)) {
      return build(rule.code, rule.detail ? rule.detail(raw) : {});
    }
  }
  return build(AppErrorCode.UNEXPECTED, {});
}

function build(code: AppErrorCode, detail: AppErrorDetail): AppError {
  return {
    code,
    message: MESSAGES[code],
    detail,
    overridable: code === AppErrorCode.LARGE_JOB_OVERRIDE_REQUIRED,
  };
}

export function appError(code: AppErrorCode, detail: AppErrorDetail = {}): AppError {
  return build(code, detail);
}

/**
 * Log the raw server error where operators can see it, while the caller
 * receives only the mapped AppError. Server-side only — never send the return
 * of `rawMessageOf` to a client.
 */
export function logAndMap(context: string, error: unknown): AppError {
  const mapped = toAppError(error);
  if (mapped.code === AppErrorCode.UNEXPECTED) {
    console.error(`[${context}] unmapped error:`, rawMessageOf(error));
  } else {
    console.warn(`[${context}] ${mapped.code}`);
  }
  return mapped;
}
