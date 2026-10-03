import { shell } from "./zh/shell";
import { schedule } from "./zh/schedule";
import { appointment } from "./zh/appointment";
import { forms } from "./zh/forms";
import { leave } from "./zh/leave";
import { records } from "./zh/records";
import { invoices } from "./zh/invoices";
import { statements } from "./zh/statements";

/**
 * English source text -> Simplified Chinese, one file per area of the app so
 * the dictionaries can be edited independently. A key present in two files
 * should carry the same translation; the later file wins.
 */
export const ZH: Record<string, string> = { ...shell, ...schedule, ...appointment, ...forms, ...leave, ...records, ...invoices, ...statements };
