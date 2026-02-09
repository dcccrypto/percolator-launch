"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#FF4466]/10">
            <svg className="h-8 w-8 text-[#FF4466]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
        </div>
        <h2 className="mb-2 text-lg font-bold text-[#fafafa]" style={{ fontFamily: "var(--font-space-grotesk)" }}>
          something went wrong
        </h2>
        <p className="mb-1 text-sm text-[#71717a]">
          {error.message || "An unexpected error occurred."}
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
            try again
          </button>
          <a
            href="/"
            className="rounded-md border border-[#1a1a1f] bg-[#111113] px-4 py-2 text-sm font-medium text-[#fafafa] transition-colors hover:bg-[#1a1a1f]"
          >
            go home
          </a>
        </div>
      </div>
    </div>
  );
}
