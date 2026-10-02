"use client";

/**
 * A "+ New" that opens the shell's Quick Add sheet — paste the customer's
 * message and go — instead of navigating to the long form.
 *
 * It does not mount a sheet of its own: it raises the same `quickadd:open`
 * event the calendar cells use, so there is still exactly one Quick Add (one
 * parser, one review step, one save path), owned by QuickAddFab in the shell.
 */
export function QuickAddButton({ label, className }: { label: string; className?: string }) {
  return (
    <button
      type="button"
      data-quick-add-open
      onClick={() => window.dispatchEvent(new CustomEvent("quickadd:open", { detail: {} }))}
      className={className}
    >
      {label}
    </button>
  );
}
