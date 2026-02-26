"use client";

import { FC, useState } from "react";
import Image from "next/image";

interface MarketLogoProps {
  logoUrl?: string | null;
  mintAddress?: string | null;
  symbol?: string;
  size?: "sm" | "md" | "lg";
}

const sizes = { sm: 24, md: 32, lg: 48 };

export const MarketLogo: FC<MarketLogoProps> = ({ logoUrl, mintAddress, symbol, size = "md" }) => {
  const [error, setError] = useState(false);
  const [cdnError, setCdnError] = useState(false);
  const px = sizes[size];

  // Try CDN logo when DB logoUrl is unavailable
  const cdnUrl = mintAddress ? `https://img.fotofolio.xyz/?url=https%3A%2F%2Fraw.githubusercontent.com%2Fsolana-labs%2Ftoken-list%2Fmain%2Fassets%2Fmainnet%2F${mintAddress}%2Flogo.png&w=${px * 2}&h=${px * 2}` : null;
  const effectiveUrl = logoUrl ?? (cdnError ? null : cdnUrl);

  if (!effectiveUrl || error) {
    // Fallback: first letter of symbol in a colored circle
    const letter = (symbol ?? "?")[0].toUpperCase();
    return (
      <div
        className="flex items-center justify-center border border-[var(--border)] bg-[var(--panel-bg)] text-[var(--text-dim)] font-mono font-bold"
        style={{ width: px, height: px, fontSize: px * 0.4 }}
      >
        {letter}
      </div>
    );
  }

  return (
    <Image
      src={effectiveUrl}
      alt={symbol ?? "token"}
      width={px}
      height={px}
      className="border border-[var(--border)]"
      onError={() => {
        if (logoUrl) setError(true);
        else setCdnError(true);
      }}
      unoptimized
    />
  );
};
