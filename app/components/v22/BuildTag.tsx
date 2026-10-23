"use client";

import { useEffect } from "react";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { formatV22Build, v22Build } from "@/lib/v22/build-tag";

/** v2.2 preview only: a small footer line with the commit and deployment, and `window.__v22Build` for QA. */
export function BuildTag() {
  const on = isDevnetV22Enabled();
  const b = v22Build();
  useEffect(() => {
    if (on) (window as unknown as { __v22Build?: unknown }).__v22Build = b;
  }, [on, b.sha, b.deployment]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!on) return null;
  return (
    <p data-testid="v22-build-tag" className="px-3 py-1 text-center font-mono text-[10px] text-[var(--text-secondary)]">
      {formatV22Build(b)}
    </p>
  );
}
