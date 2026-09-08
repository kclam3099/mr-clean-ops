/**
 * WhatsApp appointment message parser.
 *
 * Most bookings arrive as semi-structured WhatsApp text, so this turns that
 * text into the fields the booking form needs. It is deliberately deterministic
 * and local: no model, no API, and no customer data leaving the machine.
 *
 * Three rules govern everything here:
 *
 *   1. NEVER INVENT. A value that is absent stays absent, and a value that is
 *      ambiguous is flagged rather than guessed. The owner confirms; the parser
 *      does not decide.
 *
 *   2. NO AUTHORITY. The output has no staff id, workspace id, role or
 *      membership — not "ignored", absent from the type. A pasted line reading
 *      `Staff: Victor` therefore has nowhere to land, and cannot influence who
 *      a booking is assigned to.
 *
 *   3. PURE. No clock, no database, no network. Past/future validation is a
 *      separate function that takes the reference time as an argument, so tests
 *      are not time-dependent and never turn into time bombs.
 */

export type FieldStatus = "FOUND" | "NEEDS_CONFIRMATION" | "MISSING";

export type ParsedItem = {
  description: string;
  /** Always 1 in V1 — see `extractItems`. */
  quantity: number;
  unitPrice: number;
};

export type ParsedField =
  | "customerName" | "phone" | "address" | "areaCity" | "date" | "time" | "items";

export type ParsedMessage = {
  rawText: string;
  customerName: string;
  phone: string;
  address: string;
  areaCity: string;
  /** YYYY-MM-DD, or "" when absent or unparseable. */
  date: string;
  /** HH:MM, or "" when absent or ambiguous. */
  time: string;
  remarks: string;
  items: ParsedItem[];
  status: Record<ParsedField, FieldStatus>;
  /** The appointment datetime is already behind the business clock. NOT an
   *  error: historical jobs are recordable, they just need confirming. */
  isPast: boolean;
  missingFields: ParsedField[];
  confirmationFields: ParsedField[];
  /** Summary lines deliberately kept out of the items, e.g. "Total RM379". */
  excludedLines: string[];
};

/** Every field the database requires before a booking can be attempted. */
export const REQUIRED_FIELDS: ParsedField[] = [
  "customerName", "phone", "address", "areaCity", "date", "time", "items",
];

/** Column limits from the booking schema. Exceeding one is a confirmation
 *  prompt, never a silent truncation. */
const LIMITS: Partial<Record<ParsedField, number>> = {
  customerName: 120, phone: 40, address: 300, areaCity: 120,
};

const LABELS: Record<string, "customerName" | "phone" | "date" | "time" | "address" | "remarks"> = {
  "name": "customerName", "customer": "customerName", "customer name": "customerName",
  "cust": "customerName", "cust name": "customerName",

  "contact": "phone", "contact number": "phone", "contact no": "phone", "contact no.": "phone",
  "phone": "phone", "phone number": "phone", "phone no": "phone", "tel": "phone",
  "hp": "phone", "mobile": "phone", "whatsapp": "phone", "wa": "phone",

  "date": "date", "appointment date": "date", "appt date": "date", "booking date": "date",
  "service date": "date",

  "time": "time", "appointment time": "time", "appt time": "time", "booking time": "time",
  "service time": "time",

  "address": "address", "location": "address", "addr": "address",

  "remark": "remarks", "remarks": "remarks", "note": "remarks", "notes": "remarks",
};

/** A line ending in an explicit RM amount. The literal RM is mandatory — it is
 *  the single rule that keeps postcodes, phone numbers and dates out of
 *  prices, none of which carry it. */
const ITEM_RE = /^(.*?)\s*RM\s*([\d,]+(?:\.\d{1,2})?)\s*$/i;

/** Money lines that summarise other lines. Including "Total RM379" alongside
 *  the three items it totals would double the amount — and the amount drives
 *  the duration and the large-job threshold. */
const SUMMARY_RE = /^(total|sub\s*-?\s*total|grand\s*total|balance|deposit|paid|discount|payment)\b/i;

/** Message headers that are not a place, so the area heuristic skips them. */
const HEADER_RE = /^(appointment|booking)\s*(confirmed|confirmation)?$|^confirmed$|^new\s+appointment$/i;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Guard against a pathological paste locking the tab. */
const MAX_INPUT = 32_000;

export function parseAppointmentMessage(rawText: string): ParsedMessage {
  const text = (rawText ?? "").slice(0, MAX_INPUT);
  const lines = text.split(/\r?\n/);
  const n = lines.length;

  const labelField: Array<string | null> = new Array(n).fill(null);
  const labelValue: string[] = new Array(n).fill("");
  const itemAt: boolean[] = new Array(n).fill(false);

  for (let i = 0; i < n; i++) {
    const hit = matchLabel(lines[i] as string);
    if (hit) { labelField[i] = hit.field; labelValue[i] = hit.value; }
    else if (ITEM_RE.test(lines[i] as string)) {
      const m = ITEM_RE.exec(lines[i] as string);
      itemAt[i] = !!m && (m[1] as string).trim().length > 0;
    }
  }

  const consumed: boolean[] = new Array(n).fill(false);
  const single: Record<string, string> = {};
  let address = "";
  let remarks = "";

  for (let i = 0; i < n; i++) {
    const field = labelField[i];
    if (!field) continue;
    consumed[i] = true;

    if (field === "address") {
      // Addresses are commonly multiline. Continue onto following lines until a
      // blank line, another label, or a service line.
      const parts = [labelValue[i] as string];
      let j = i + 1;
      while (j < n && (lines[j] as string).trim() !== "" && !labelField[j] && !itemAt[j]) {
        parts.push(lines[j] as string);
        consumed[j] = true;
        j++;
      }
      address = parts.map((p) => p.trim()).filter(Boolean).join("\n");
    } else if (field === "remarks") {
      // A "Remark" heading with its text a line or two below is common, so this
      // block runs through blank lines to the next label or the end. Service
      // lines are stepped over rather than swallowed: a price line after the
      // heading is an item, not a remark.
      const parts = labelValue[i] ? [labelValue[i] as string] : [];
      let j = i + 1;
      while (j < n && !labelField[j]) {
        if (!itemAt[j]) { parts.push(lines[j] as string); consumed[j] = true; }
        j++;
      }
      remarks = parts.join("\n").trim();
    } else if (!single[field]) {
      single[field] = (labelValue[i] as string).trim();
    }
  }

  // ---- items ---------------------------------------------------------------
  const items: ParsedItem[] = [];
  const excludedLines: string[] = [];
  for (let i = 0; i < n; i++) {
    if (consumed[i] || !itemAt[i]) continue;
    const m = ITEM_RE.exec(lines[i] as string);
    if (!m) continue;
    const description = (m[1] as string).trim();
    if (SUMMARY_RE.test(description)) { excludedLines.push((lines[i] as string).trim()); continue; }
    const unitPrice = Number((m[2] as string).replace(/,/g, ""));
    if (!Number.isFinite(unitPrice)) continue;
    // Quantity is ALWAYS 1 and the RM figure is the line total. "Sofa x2 RM358"
    // does not say whether 358 is per item or for both, and guessing "per item"
    // would double the amount — silently changing the computed duration and the
    // large-job classification. Quantity words stay in the description.
    items.push({ description: description.slice(0, 200), quantity: 1, unitPrice });
  }

  // ---- area / city ---------------------------------------------------------
  // No city dictionary and no geographic guessing. A location heading usually
  // sits on its own line above the labelled fields; take the last such line.
  const firstLabel = labelField.findIndex((f) => f !== null);
  const bareLimit = firstLabel === -1 ? n : firstLabel;
  let areaCandidate = "";
  for (let i = 0; i < bareLimit; i++) {
    const t = (lines[i] as string).trim();
    if (!t || t.length > 60 || itemAt[i] || HEADER_RE.test(t) || /:/.test(t)) continue;
    areaCandidate = t;
  }

  const parsed: ParsedMessage = {
    rawText: text,
    customerName: single.customerName ?? "",
    phone: single.phone ?? "",
    address,
    areaCity: areaCandidate,
    date: "",
    time: "",
    remarks,
    items,
    status: {
      customerName: "MISSING", phone: "MISSING", address: "MISSING",
      areaCity: "MISSING", date: "MISSING", time: "MISSING", items: "MISSING",
    },
    isPast: false,
    missingFields: [],
    confirmationFields: [],
    excludedLines,
  };

  // ---- date and time -------------------------------------------------------
  const rawDate = single.date ?? "";
  const rawTime = single.time ?? "";
  const isoDate = rawDate ? parseDate(rawDate) : null;
  const isoTime = rawTime ? parseTime(rawTime) : null;
  parsed.date = isoDate ?? "";
  parsed.time = isoTime ?? "";

  // ---- statuses ------------------------------------------------------------
  const textStatus = (field: ParsedField, value: string): FieldStatus => {
    if (!value.trim()) return "MISSING";
    const limit = LIMITS[field];
    // Over the column limit: show it and ask, rather than truncate behind the
    // owner's back.
    if (limit && value.trim().length > limit) return "NEEDS_CONFIRMATION";
    return "FOUND";
  };

  parsed.status.customerName = textStatus("customerName", parsed.customerName);
  parsed.status.phone = textStatus("phone", parsed.phone);
  parsed.status.address = textStatus("address", parsed.address);

  parsed.status.areaCity = !parsed.areaCity
    ? "MISSING"
    : (LIMITS.areaCity && parsed.areaCity.length > LIMITS.areaCity) ? "NEEDS_CONFIRMATION"
    // Corroboration instead of a dictionary: a heading that also appears inside
    // the address is almost certainly the area. One that does not is a guess,
    // and a guess gets confirmed.
    : parsed.address.toLowerCase().includes(parsed.areaCity.toLowerCase())
      ? "FOUND"
      : "NEEDS_CONFIRMATION";

  parsed.status.date = !rawDate ? "MISSING" : isoDate ? "FOUND" : "NEEDS_CONFIRMATION";
  parsed.status.time = !rawTime ? "MISSING" : isoTime ? "FOUND" : "NEEDS_CONFIRMATION";
  parsed.status.items = items.length === 0 ? "MISSING" : "FOUND";

  return withDerivedLists(parsed);
}

/**
 * Marks an appointment that is already in the past.
 *
 * A past datetime is VALID appointment data — the owner records jobs after the
 * fact. So this sets a flag and deliberately leaves the field statuses alone:
 * a historical message must not be pushed into the correction form merely for
 * being historical. The confirmation it needs is a single deliberate "record
 * it anyway", not a round of re-typing.
 *
 * Separate from parsing, and takes the reference time as an argument, so the
 * parser stays pure and its tests never depend on when they run.
 *
 * The comparison is on the COMBINED date and time in the business timezone:
 * 8 Sep 2:00 PM is future at 11:00 the same morning, and is not past just
 * because the date is today.
 *
 * This is early feedback only — create_appointment's own guard, and the
 * p_confirm_past flag added in 0010, remain authoritative.
 *
 * @param nowLocal business-local "YYYY-MM-DDTHH:MM" (Asia/Kuala_Lumpur)
 */
export function markPastDateTime(parsed: ParsedMessage, nowLocal: string): ParsedMessage {
  if (parsed.status.date !== "FOUND" || parsed.status.time !== "FOUND") return parsed;
  return { ...parsed, isPast: `${parsed.date}T${parsed.time}` <= nowLocal };
}

/** True when this local datetime is at or behind the business clock. */
export function isPastDateTime(date: string, time: string, nowLocal: string): boolean {
  if (!date || !time) return false;
  return `${date}T${time}` <= nowLocal;
}

/** Business-local "YYYY-MM-DDTHH:MM", for `flagPastDateTime`. */
export function businessNowLocal(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // en-CA renders midnight as 24; normalise it.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

/** True once the text looks enough like an appointment to show a review. */
export function looksLikeAppointment(parsed: ParsedMessage): boolean {
  const signals = [
    parsed.customerName !== "",
    parsed.date !== "" || parsed.status.date === "NEEDS_CONFIRMATION",
    parsed.time !== "" || parsed.status.time === "NEEDS_CONFIRMATION",
    parsed.items.length > 0,
    parsed.address !== "",
  ].filter(Boolean).length;
  return signals >= 2;
}

export function itemsTotal(items: ParsedItem[]): number {
  return items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
}

// ---------------------------------------------------------------------------

function withDerivedLists(parsed: ParsedMessage): ParsedMessage {
  return {
    ...parsed,
    missingFields: REQUIRED_FIELDS.filter((f) => parsed.status[f] === "MISSING"),
    confirmationFields: REQUIRED_FIELDS.filter((f) => parsed.status[f] === "NEEDS_CONFIRMATION"),
  };
}

function matchLabel(line: string): { field: string; value: string } | null {
  // Tolerates a space before the colon ("Name : Grace") and any run of spaces
  // after it ("Appt Time:  2pm").
  const m = /^\s*([A-Za-z][A-Za-z. ]{0,23}?)\s*:(.*)$/.exec(line);
  if (m) {
    const key = (m[1] as string).toLowerCase().replace(/\s+/g, " ").trim();
    const field = LABELS[key];
    if (field) return { field, value: (m[2] as string).trim() };
    return null;
  }
  // A bare "Remark" heading with no colon at all.
  const bare = /^\s*(remark|remarks|note|notes)\s*$/i.exec(line);
  if (bare) return { field: "remarks", value: "" };
  return null;
}

/**
 * Malaysian convention: DD/MM/YY. `8/9/26` is 8 September 2026, never 9 August.
 * Returns null for anything that does not survive a round trip, so `12/13/26`
 * and `31/2/26` are refused rather than silently coerced.
 */
function parseDate(raw: string): string | null {
  const value = raw.trim();

  const numeric = /^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/.exec(value);
  if (numeric) {
    return buildDate(Number(numeric[1]), Number(numeric[2]), Number(numeric[3]));
  }

  const textual = /^(\d{1,2})\s*[-\s]\s*([A-Za-z]{3,9})\.?\s*[-,\s]\s*(\d{2}|\d{4})$/.exec(value);
  if (textual) {
    const month = monthNumber(textual[2] as string);
    if (!month) return null;
    return buildDate(Number(textual[1]), month, Number(textual[3]));
  }

  return null;
}

function monthNumber(name: string): number | null {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex((m) => m === lower || m.slice(0, 3) === lower.slice(0, 3));
  return index === -1 ? null : index + 1;
}

function buildDate(day: number, month: number, year: number): string | null {
  const fullYear = year < 100 ? 2000 + year : year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(fullYear, month - 1, day));
  // Round trip catches 31 February and anything else that overflowed.
  if (dt.getUTCFullYear() !== fullYear || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * `2pm`, `2 pm`, `2:00pm`, `2.00pm`, `14:00`, `1400`.
 * A bare number with no meridiem is genuinely ambiguous and returns null —
 * nobody wants a 2 a.m. sofa cleaning because the parser picked one.
 */
function parseTime(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\s+/g, "");

  const meridiem = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/.exec(value);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (meridiem[3] === "am" && hour === 12) hour = 0;
    else if (meridiem[3] === "pm" && hour !== 12) hour += 12;
    return format(hour, minute);
  }

  const clock = /^(\d{1,2})[:.](\d{2})$/.exec(value);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    return hour > 23 || minute > 59 ? null : format(hour, minute);
  }

  const compact = /^(\d{3,4})$/.exec(value);
  if (compact) {
    const digits = (compact[1] as string).padStart(4, "0");
    const hour = Number(digits.slice(0, 2));
    const minute = Number(digits.slice(2));
    return hour > 23 || minute > 59 ? null : format(hour, minute);
  }

  return null;
}

function format(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
