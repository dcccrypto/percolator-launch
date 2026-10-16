"use client";

/**
 * Calm fallback for a market whose on-chain VERSION this build does not decode (v2.2 flag on). Replaces the
 * numbers; never shows a version number, byte offset or error code. Uses the one site notice component.
 */
import type { FC } from "react";
import { StatusLine } from "@/components/ui/StatusLine";
import { unsupportedLayoutMessage } from "@/lib/v22/layout";

export const UnsupportedLayoutNotice: FC<{ className?: string }> = ({ className = "" }) => {
  const m = unsupportedLayoutMessage();
  return (
    <div data-testid="unsupported-layout" className={className}>
      <StatusLine message={{ kind: "unsupported-layout", variant: "paused", title: m.title, body: m.body }} />
    </div>
  );
};
