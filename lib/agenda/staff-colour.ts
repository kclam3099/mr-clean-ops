/**
 * A stable colour per staff member.
 *
 * This is the thing that makes a schedule readable at a glance rather than
 * read line by line. Once someone has learnt that Jack is teal, a week grid
 * stops being forty boxes of text and becomes a picture of who is where.
 *
 * Assigned by RANK over every staff id the caller can see, computed once in
 * the read layer and carried on the data. The same person is therefore the
 * same colour on the dashboard, the calendar and the appointment, and no two
 * people can collide while there are fewer staff than colours.
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
  { bg: "bg-orange-50", text: "text-orange-700", border: "border-orange-500", solid: "bg-orange-500" },
  { bg: "bg-sky-50", text: "text-sky-700", border: "border-sky-500", solid: "bg-sky-500" },
  { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-500", solid: "bg-rose-500" },
  { bg: "bg-lime-50", text: "text-lime-700", border: "border-lime-600", solid: "bg-lime-600" },
  { bg: "bg-fuchsia-50", text: "text-fuchsia-700", border: "border-fuchsia-500", solid: "bg-fuchsia-500" },
  { bg: "bg-cyan-50", text: "text-cyan-700", border: "border-cyan-500", solid: "bg-cyan-500" },
];

export const STAFF_COLOUR_COUNT = PALETTE.length;

const NEUTRAL: StaffColour = {
  bg: "bg-sunken",
  text: "text-ink-muted",
  border: "border-line",
  solid: "bg-ink-faint",
};

/**
 * The colour at a rank. -1, or no index at all, is the neutral chip.
 *
 * Ranks come from the read layer, which sorts every staff id it can see and
 * numbers them. Distinct by construction, which a hash was not: hashing the id
 * into eight slots put Jack and Dyron on the same violet in a company of
 * three, and two people sharing a colour is worse than no colour, because it
 * teaches something false and is noticed only when someone drives to the wrong
 * address.
 */
export function colourAt(index: number | null | undefined): StaffColour {
  if (index === null || index === undefined || index < 0) return NEUTRAL;
  return PALETTE[index % PALETTE.length] as StaffColour;
}

/**
 * Ranks staff ids into colour indexes.
 *
 * Sorted, so the result depends only on WHICH ids exist and never on the order
 * a query returned them in — an ordering change would otherwise repaint the
 * whole schedule.
 */
export function staffColourIndexes(staffIds: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  [...new Set(staffIds)].sort().forEach((id, i) => map.set(id, i));
  return map;
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

/**
 * The single letter for a round badge.
 *
 * An underscore marks a PREFIX rather than a given name — TEST_JACK is Jack
 * with a label on the front — so the identifying letter is in the last
 * segment. A space marks a personal name, where the first word identifies.
 * Taking the first letter either way turned three different people into three
 * badges that all read "T".
 */
export function staffBadgeLetter(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const segment = trimmed.includes("_")
    ? (trimmed.split("_").filter(Boolean).pop() as string)
    : trimmed;
  return (segment[0] ?? "?").toUpperCase();
}
