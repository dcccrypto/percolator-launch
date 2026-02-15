"use client";

import { FC } from "react";

interface MarketLogoProps {
  logoUrl?: string | null;
  symbol?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
}

export const MarketLogo: FC<MarketLogoProps> = ({
  logoUrl,
  symbol,
  size = "md",
  className = "",
}) => {
  const sizeClasses = {
    xs: "h-6 w-6 text-[10px]",
    sm: "h-8 w-8 text-xs",
    md: "h-10 w-10 text-sm",
    lg: "h-12 w-12 text-base",
    xl: "h-16 w-16 text-lg",
  };

  const baseClasses = `${sizeClasses[size]} flex items-center justify-center rounded-sm overflow-hidden ${className}`;

  // If we have a logo URL, display it
  if (logoUrl) {
    return (
      <div className={baseClasses}>
        <img
          src={logoUrl}
          alt={symbol || "Market logo"}
          className="h-full w-full object-contain"
          onError={(e) => {
            // Hide broken image, show fallback
            e.currentTarget.style.display = "none";
            if (e.currentTarget.nextSibling) {
              (e.currentTarget.nextSibling as HTMLElement).style.display = "flex";
            }
          }}
        />
        {/* Fallback for broken images */}
        <div 
          className="h-full w-full items-center justify-center bg-gradient-to-br from-[var(--accent)]/20 to-[var(--accent)]/5 border border-[var(--border)]"
          style={{ display: "none" }}
        >
          <span className="font-bold text-[var(--accent)]">
            {symbol ? symbol.slice(0, 1).toUpperCase() : "?"}
          </span>
        </div>
      </div>
    );
  }

  // Fallback: Show first letter of symbol or placeholder
  return (
    <div className={`${baseClasses} bg-gradient-to-br from-[var(--accent)]/20 to-[var(--accent)]/5 border border-[var(--border)]`}>
      <span className="font-bold text-[var(--accent)]">
        {symbol ? symbol.slice(0, 1).toUpperCase() : "?"}
      </span>
    </div>
  );
};
