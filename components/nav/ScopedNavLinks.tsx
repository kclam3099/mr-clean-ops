"use client";

import { useSearchParams } from "next/navigation";
import { NavLink } from "./NavLink";

/**
 * Nav links that carry the CURRENTLY SELECTED scope.
 *
 * Same reason the selector reads the URL: a layout cannot see its children's
 * search params, so server-rendered links carried the caller's default scope
 * and moving from a Shared-Team dashboard to the calendar silently dropped you
 * back to All Operations. Reading `?ws=` here keeps the scope while navigating.
 *
 * A value that is not one of this caller's options is ignored rather than
 * propagated, mirroring `resolveScope` — a rejected workspace must not survive
 * into the next page's URL.
 */
export function ScopedNavLinks({
  links,
  options,
  hasChoice,
}: {
  links: Array<{ path: string; label: string; scoped: boolean }>;
  options: Array<{ value: string; label: string }>;
  hasChoice: boolean;
}) {
  const searchParams = useSearchParams();
  const requested = searchParams.get("ws");
  const current = options.some((o) => o.value === requested) ? (requested as string) : "all";

  return (
    <nav className="flex flex-wrap items-center gap-1">
      {links.map((l) => (
        <NavLink
          key={l.path}
          href={l.scoped && hasChoice ? `${l.path}?ws=${encodeURIComponent(current)}` : l.path}
          label={l.label}
        />
      ))}
    </nav>
  );
}
