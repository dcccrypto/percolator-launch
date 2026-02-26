"use client";

import { FC, useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
}

interface NavDropdownProps {
  label: string;
  items: NavItem[];
}

export const NavDropdown: FC<NavDropdownProps> = ({ label, items }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const hasActive = items.some((item) => pathname === item.href);

  const handleMouseEnter = useCallback(() => {
    clearTimeout(timeoutRef.current);
    setOpen(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  }, []);

  // Close on escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    if (open) {
      document.addEventListener("keydown", onKey);
      return () => document.removeEventListener("keydown", onKey);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", onClick);
      return () => document.removeEventListener("mousedown", onClick);
    }
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="true"
        className={[
          "flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-sm transition-colors duration-200",
          hasActive || open
            ? "text-white"
            : "text-[#9ca3af] hover:text-white",
        ].join(" ")}
      >
        {label}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          className={[
            "transition-transform duration-150",
            open ? "rotate-180" : "",
          ].join(" ")}
        >
          <path
            d="M2.5 3.75L5 6.25L7.5 3.75"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Dropdown panel */}
      <div
        role="menu"
        className={[
          "absolute left-0 top-full mt-1 min-w-[200px] rounded-xl border border-white/[0.08] bg-[rgba(15,15,20,0.97)] py-2 shadow-[0_8px_32px_rgba(0,0,0,0.48)] transition-all duration-[120ms] ease-out",
          open
            ? "opacity-100 translate-y-0 pointer-events-auto"
            : "opacity-0 -translate-y-1 pointer-events-none",
        ].join(" ")}
      >
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={[
                "block px-4 py-2.5 text-sm transition-colors duration-150",
                active
                  ? "text-[#22d3ee] bg-[rgba(34,211,238,0.08)]"
                  : "text-[#d1d5db] hover:text-white hover:bg-white/[0.06]",
              ].join(" ")}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
};
