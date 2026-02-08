"use client";

import { FC, useState } from "react";

export const CopyableAddress: FC<{ address: string; chars?: number; className?: string }> = ({
  address,
  chars = 4,
  className = "",
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 font-mono transition-colors hover:text-blue-400 ${className}`}
      title="Click to copy"
    >
      <span>{address.slice(0, chars)}...{address.slice(-chars)}</span>
      <span className="text-[10px]">{copied ? "✓" : ""}</span>
    </button>
  );
};
