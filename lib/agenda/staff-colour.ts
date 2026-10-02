/**
 * A stable colour per staff member.
 *
 * This is the thing that makes a schedule readable at a glance rather than
 * read line by line. Once someone has learnt that Jack is teal, a week grid
 * stops being forty boxes of text and becomes a picture of who is where.
 *
 * Derived from the staff id, not from position in a list, so the same person
 * is the same colour on the dashboard, the calendar and the appointment — a
 * colour that changes between screens is worse than no colour, because it
 * teaches something false.
 *
 * Colour is never the only carrier anywhere it is used: every chip that gets
 * one also carries the name. These are an accelerator for people who can see
 * them and nothing at all for people who cannot, which is the correct ordering.
 *
 * The palette avoids brand navy and brand gold on purpose. Those two mean
 * "this app" and "today"; reusing them for a person would make three different
 * things speak with the same voice. Every pair below is a 600-weight ink on a
 * tinted ground, which clears 4.5:1 for the name as text.
 */

export type StaffColour = {
  /** Tinted chip background. */
  bg: string;
  /** Ink that clears 4.5:1 on that background. */
  text: string;
  /** Saturated edge, for the left rule on a card. */
  border: string;
  /** Solid fill, for a dot or a bar where there is no text on top. */
  solid: string;
};

const PALETTE: StaffColour[] = [
  { bg: "bg-teal-50", text: "text-teal-700", border: "border-teal-500", solid: "bg-teal-500" },
  { bg: "bg-violet-50", text: "text-violet-700", border: "border-violet-500", solid: "bg-violet-500" },
  { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-500", solid: "bg-rose-500" },
  { bg: "bg-cyan-50", text: "text-cyan-700", border: "border-cyan-500", solid: "bg-cyan-500" },
  { bg: "bg-lime-50", text: "text-lime-700", border: "border-lime-600", solid: "bg-lime-600" },
  { bg: "bg-fuchsia-50", text: "text-fuchsia-700", border: "border-fuchsia-500", solid: "bg-fuchsia-500" },
  { bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-500", solid: "bg-sky-500" },
  { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-500", solid: "bg-orange-500" },
];

const NEUTRAL: StaffColour = {
  bg: "bg-sunken",
  text: "text-ink-muted",
  border: "border-line",
  solid: "bg-ink-faint",
};

/**
 * Stable across processes and deploys, because it is a function of the id and
 * nothing else — not of insertion order, not of a Map's iteration order, not of
 * how many staff happen to be visible to this particular viewer. Nick and KC
 * see Jack in the same colour even though their rosters differ in length.
 */
export function staffColour(staffId: string | null | undefined): StaffColour {
  if (!staffId) return NEUTRAL;
  let h = 0;
  for (let i = 0; i < staffId.length; i++) {
    h = (h * 31 + staffId.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length] as StaffColour;
}

/** Initials for a compact chip. Two letters at most; one for a single word. */
export function staffInitials(name: string): string {
  const parts = name.trim().split(/[\s_]+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  const last = parts[parts.length - 1];
  if (parts.length === 1 || !last) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}
