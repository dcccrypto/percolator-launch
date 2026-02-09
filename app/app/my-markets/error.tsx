"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function MyMarketsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[MyMarketsError]", error);
  }, [error]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-24 text-center">
      <div className="mx-auto max-w-md rounded-[4px] border border-[#1a1a1f] bg-[#111113] p-8">
        <h2 className="text-lg font-bold text-[#fafafa]">failed to load markets</h2>
        <p className="mt-2 text-sm text-[#71717a]">{error.message || "Something went wrong."}</p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-md bg-[#00FFB2] px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-[#00e0a0]"
          >
            retry
          </button>
          <Link
            href="/markets"
            className="rounded-md border border-[#1a1a1f] bg-[#111113] px-4 py-2 text-sm font-medium text-[#fafafa] transition-colors hover:bg-[#1a1a1f]"
          >
            browse all markets
          </Link>
        </div>
      </div>
    </main>
  );
}
