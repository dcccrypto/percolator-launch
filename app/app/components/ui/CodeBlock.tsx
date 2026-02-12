"use client";

import { useState } from "react";

interface CodeBlockProps {
  children: string;
  className?: string;
}

export function CodeBlock({ children, className = "" }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="relative group">
      <pre className={`rounded-sm bg-[#0D0D14] border border-[var(--border)] p-4 text-[12px] font-mono text-[var(--text-secondary)] overflow-x-auto whitespace-pre ${className}`}>
        {children}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity border border-[var(--border)] bg-[var(--bg-elevated)] hover:bg-[var(--accent)]/10 hover:border-[var(--accent)]/30 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-[var(--text-secondary)] hover:text-[var(--accent)] flex items-center gap-1.5"
        title="Copy to clipboard"
      >
        {copied ? (
          <>
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            copied
          </>
        ) : (
          <>
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            copy
          </>
        )}
      </button>
    </div>
  );
}
