"use client";
import { useEffect, useState } from "react";
import { getNetwork } from "@/lib/config";
import Link from "next/link";

/**
 * Gates pages that are not available on mainnet beta.
 * Wrap any page component with this to block access on mainnet.
 *
 * Usage: <MainnetGate>{children}</MainnetGate>
 */
export function MainnetGate({ children }: { children: React.ReactNode }) {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    setBlocked(getNetwork() === "mainnet");
  }, []);

  if (!blocked) return <>{children}</>;

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="text-center max-w-md">
        <div className="text-6xl mb-4">🔒</div>
        <h1
          className="text-2xl font-semibold text-[var(--text)] mb-3"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Not Available Yet
        </h1>
        <p className="text-sm text-[var(--text-muted)] mb-6">
          This feature is not available during the mainnet beta.
          Check back soon.
        </p>
        <Link
          href="/"
          className="inline-block rounded-lg bg-[var(--accent)] px-6 py-2.5 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}
