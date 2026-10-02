"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const path = href.split("?")[0] as string;
  const active = pathname === path || (path !== "/" && pathname.startsWith(`${path}/`));

  // The active item is marked by a gold underline AND a weight change, not by
  // colour alone. Someone who cannot separate gold from white — or who is
  // outside with the screen washed out — still sees which page they are on.
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative flex min-h-11 cursor-pointer items-center whitespace-nowrap rounded-lg px-3
                  text-sm transition-colors duration-200 ${
                    active
                      ? "font-semibold text-white"
                      : "font-medium text-white/70 hover:bg-white/10 hover:text-white"
                  }`}
    >
      {label}
      {active ? (
        <span
          aria-hidden
          className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gold"
        />
      ) : null}
    </Link>
  );
}
