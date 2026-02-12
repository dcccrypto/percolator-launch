"use client";

import { useState } from "react";

// L6: Code block component with copy button
export function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group">
      <pre className="rounded-sm bg-[#0D0D14] border border-[var(--border)] p-4 text-[12px] font-mono text-[var(--text-secondary)] overflow-x-auto whitespace-pre">
        {children}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded-sm bg-[var(--bg-elevated)] border border-[var(--border)] px-2 py-1 text-[10px] font-medium text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 hover:text-[var(--accent)] transition-all"
        title="Copy to clipboard"
      >
        {copied ? "✓ Copied" : "Copy"}
      </button>
    </div>
  );
}
