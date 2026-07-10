"use client";

import { FC, useEffect, useState } from "react";
import Image from "next/image";
import { useTokenLogo } from "@/hooks/useTokenLogo";

interface MarketLogoProps {
  logoUrl?: string | null;
  mintAddress?: string | null;
  /**
   * Mainnet contract address for this market's underlying token — used to
   * resolve a real DEX logo (GeckoTerminal → DexScreener, see
   * hooks/useTokenLogo.ts) when no explicit logoUrl is set. Distinct from
   * mintAddress: on the playground, mintAddress is often the *devnet*
   * collateral/mirror mint, which DEX APIs (mainnet-only) can't resolve.
   */
  mainnetCa?: string | null;
  symbol?: string;
  size?: "sm" | "md" | "lg";
  /** Override pixel size directly, bypassing the size preset. */
  pixelOverride?: number;
  /**
   * Mark the logo as purely decorative — used when the adjacent symbol/name
   * text already conveys the same information (e.g. a market row where the
   * logo sits next to a visible "SOL" label). Sets `alt=""` on the resolved
   * `<Image>` and `aria-hidden` on the initials-fallback tile so screen
   * readers don't announce the symbol twice for one link/row.
   */
  decorative?: boolean;
}

const sizes = { sm: 24, md: 32, lg: 48 };

/**
 * Precedence: an explicitly-uploaded `logoUrl` wins; otherwise the real DEX
 * logo resolved by `mainnetCa`; otherwise the symbol-initials placeholder.
 * `<img onError>` guards every remote URL so a broken/expired logo never
 * renders as a broken image — it just drops to the next tier.
 */
export const MarketLogo: FC<MarketLogoProps> = ({ logoUrl, mintAddress, mainnetCa, symbol, size = "md", pixelOverride, decorative = false }) => {
  const [error, setError] = useState(false);
  const px = pixelOverride ?? sizes[size];

  // Skip the DEX lookup entirely when an explicit logo is already set — no
  // need to hit /api/token-logo for a market that already has one.
  const dexLogoUrl = useTokenLogo(logoUrl ? null : mainnetCa);
  const effectiveUrl = logoUrl ?? dexLogoUrl;

  // Reset the broken-image flag when the resolved URL changes (e.g. the
  // MarketSwitcher/MarketSelector instance persists across a market switch —
  // a stale error from the previous market must not stick to the new one).
  useEffect(() => {
    setError(false);
  }, [effectiveUrl]);

  if (!effectiveUrl || error) {
    // GH#1544: Fallback label priority:
    //   1. Token symbol (up to 4 chars, e.g. "SOL", "BONK")
    //   2. Mint address prefix (first 3 chars) — better than "?" for anonymous markets
    const fallbackLabel = symbol
      ? symbol.slice(0, 4).toUpperCase()
      : mintAddress
        ? mintAddress.slice(0, 3).toUpperCase()
        : "?";
    return (
      <div
        aria-hidden={decorative || undefined}
        className="flex items-center justify-center border border-[var(--border)] bg-[var(--panel-bg)] text-[var(--text-dim)] font-mono font-bold"
        style={{ width: px, height: px, fontSize: px * (fallbackLabel.length > 2 ? 0.28 : 0.4) }}
      >
        {fallbackLabel}
      </div>
    );
  }

  return (
    <Image
      src={effectiveUrl}
      alt={decorative ? "" : (symbol ?? "token")}
      width={px}
      height={px}
      className="border border-[var(--border)]"
      onError={() => setError(true)}
      unoptimized
    />
  );
};
