"use client";

import { FC, useState } from "react";
import Image from "next/image";

interface MarketLogoProps {
  logoUrl?: string | null;
  symbol?: string;
  size?: "sm" | "md" | "lg";
}

const sizes = { sm: 24, md: 32, lg: 48 };

export const MarketLogo: FC<MarketLogoProps> = ({ logoUrl, symbol, size = "md" }) => {
  const [error, setError] = useState(false);
  const px = sizes[size];

  if (!logoUrl || error) {
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
      src={logoUrl}
      alt={symbol ?? "token"}
      width={px}
      height={px}
      className="border border-[var(--border)]"
      onError={() => setError(true)}
      unoptimized
    />
  );
};
