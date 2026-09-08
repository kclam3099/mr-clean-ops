"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Master workspace scope selector.
 *
 * Rendered ONLY when the caller can actually see more than one workspace — the
 * options are built server-side from RLS-visible rows, so a Master with a single
 * workspace gets no selector at all. There is no disabled entry, no
 * "1 more workspace" hint, and no placeholder: the absence of a control is the
 * point, because any of those would disclose that another workspace exists.
 *
 * "All Operations" is a virtual merged view, not a workspace id.
 *
 * THE DISPLAYED VALUE COMES FROM THE URL, not from a prop. A layout cannot read
 * its children's search params, so the server had to render this selector from
 * the caller's DEFAULT scope — which meant it kept saying "All Operations"
 * while the page below it was correctly scoped to one workspace and said so in
 * its heading. Reading the same `?ws=` the page reads makes the two agree by
 * construction.
 *
 * An unrecognised value falls back to "all", mirroring `resolveScope` on the
 * server: a rejected workspace must not stay selected in the control either.
 */
export function WorkspaceScopeSelector({
  options,
}: {
  options: Array<{ value: string; label: string }>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (options.length < 2) return null;

  const requested = searchParams.get("ws");
  const value = options.some((o) => o.value === requested) ? (requested as string) : "all";

  function onChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("ws", next);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Workspace</span>
      <select
        data-scope-selector
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm
                   font-medium text-slate-900 focus:border-slate-900 focus:outline-none
                   focus:ring-1 focus:ring-slate-900"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
