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
 */
export function WorkspaceScopeSelector({
  options,
  value,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (options.length < 2) return null;

  function onChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("ws", next);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Workspace</span>
      <select
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
