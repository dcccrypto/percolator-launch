"use client";

import { useEffect } from "react";

export default function TradeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[TradeError]", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-12">
      <div className="mx-auto max-w-md text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#FF4466]/10">
            <svg className="h-7 w-7 text-[#FF4466]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
        </div>
        <h2 className="mb-2 text-lg font-bold text-[#fafafa]" style={{ fontFamily: "var(--font-space-grotesk)" }}>
          trade page crashed
        </h2>
        <p className="mb-1 text-sm text-[#71717a]">
          {error.message || "Something went wrong loading the trade view."}
        </p>
        {error.digest && (
          <p className="mb-4 font-mono text-xs text-[#3f3f46]">
            digest: {error.digest}
          </p>
        )}
        <div className="flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-md bg-[#00FFB2] px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-[#00e0a0]"
          >
            retry
          </button>
          <a
            href="/markets"
            className="rounded-md border border-[#1a1a1f] bg-[#111113] px-4 py-2 text-sm font-medium text-[#fafafa] transition-colors hover:bg-[#1a1a1f]"
          >
            back to markets
          </a>
        </div>
      </div>
    </div>
  );
}
