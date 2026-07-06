"use client";

import { FC, useState } from "react";

/**
 * Copy-the-market-link button for the trade page header.
 *
 * Was a dropdown card (Copy Link / Share on X), but the header utility row is
 * an `overflow-x-auto` scroll container, which clips absolutely-positioned
 * children — the dropdown opened invisibly, so the button read as dead. It
 * also copied a hardcoded percolatorlaunch.com URL that no longer matches
 * where the playground is deployed. A one-click copy of the current origin's
 * market URL fixes both; a share-on-X affordance can return later as a modal
 * (not a dropdown) if wanted.
 */
export const ShareButton: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/trade/${slabAddress}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard permission denied — leave the label unchanged */
    }
  };

  return (
    <button
      onClick={copyLink}
      title="Copy market link"
      className="rounded-sm border border-[var(--border)] bg-[var(--bg-surface)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] transition-all duration-150 hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
    >
      {copied ? "Copied ✓" : "Share"}
    </button>
  );
};
