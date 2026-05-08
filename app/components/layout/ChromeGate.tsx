"use client";

import { usePathname } from "next/navigation";

/**
 * Hides global chrome (Header, Footer, banners, mobile nav) on routes
 * that ship their own full-screen UI — currently /waitlist.
 *
 * Used by app/layout.tsx to wrap the persistent layout chrome.  The
 * waitlist page on percolator.trade renders edge-to-edge without the
 * trading-frontend nav around it.
 */
const HIDE_ON = ["/waitlist"];

export function ChromeGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname && HIDE_ON.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return null;
  }
  return <>{children}</>;
}
