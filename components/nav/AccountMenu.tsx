"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SignOutButton } from "./SignOutButton";

/**
 * The account menu: who you are, and the two things you can do about it.
 *
 * Change password lives here rather than in a settings page because only a
 * Super Master has a settings page, and everyone has a password. It was
 * previously reachable only on the forced first-login redirect, which meant a
 * staff member who later wanted to change theirs had no way to.
 */
export function AccountMenu({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg px-2.5
                   text-sm font-medium text-white/85 transition-colors duration-200
                   hover:bg-white/15 hover:text-white"
      >
        {/* The name is hidden on a narrow phone, the icon never is — the menu
            has to stay reachable when the workspace name is long. */}
        <span
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                     bg-white/20 text-[11px] font-bold text-white"
        >
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="hidden max-w-32 truncate sm:inline">{name}</span>
        <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
          <path
            fillRule="evenodd"
            d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.58l3.3-3.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.42Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-xl
                     border border-line bg-card py-1 shadow-xl shadow-brand-900/20"
        >
          <p className="truncate px-3 py-2 text-xs text-ink-faint">
            Signed in as <span className="font-semibold text-ink">{name}</span>
          </p>
          <div className="h-px bg-line" />
          <Link
            href="/change-password"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium
                       text-ink transition-colors duration-200 hover:bg-sunken"
          >
            Change password
          </Link>
          <div className="h-px bg-line" />
          <SignOutButton className="w-full justify-start !text-danger hover:!bg-danger/10" />
        </div>
      ) : null}
    </div>
  );
}
