"use client";

import { FC } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavTab {
  href: string;
  label: string;
  /** Match prefix for active state (e.g. "/trade" matches "/trade/xxx") */
  matchPrefix?: string;
  icon: React.ReactNode;
}

const tabs: NavTab[] = [
  {
    href: "/",
    label: "Home",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
      </svg>
    ),
  },
  {
    href: "/markets",
    label: "Markets",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605" />
      </svg>
    ),
  },
  {
    href: "/trade",
    label: "Trade",
    matchPrefix: "/trade",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" />
      </svg>
    ),
  },
  {
    href: "/portfolio",
    label: "Portfolio",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
      </svg>
    ),
  },
  {
    href: "/earn",
    label: "Earn",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

export const MobileBottomNav: FC = () => {
  const pathname = usePathname();

  const isActive = (tab: NavTab): boolean => {
    if (tab.matchPrefix) {
      return pathname.startsWith(tab.matchPrefix);
    }
    return pathname === tab.href;
  };

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-50 border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-md md:hidden safe-area-bottom"
      aria-label="Mobile navigation"
    >
      <div className="flex items-stretch justify-around">
        {tabs.map((tab) => {
          const active = isActive(tab);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={[
                "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] transition-colors duration-150 relative",
                active
                  ? "text-[var(--accent)]"
                  : "text-[var(--text-muted)] active:text-[var(--text-secondary)]",
              ].join(" ")}
              aria-current={active ? "page" : undefined}
            >
              {/* Active indicator line */}
              {active && (
                <span className="absolute top-0 inset-x-3 h-[2px] bg-[var(--accent)] rounded-b-full" />
              )}
              <span className={active ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}>
                {tab.icon}
              </span>
              <span className="text-[10px] font-medium tracking-wide">
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
};
