"use client";

const ITEMS = [
  "not real money.",
  "break things. report bugs.",
  "mainnet soon™",
  "don't trust, verify.",
  "devnet — not real money.",
  "permissionless perpetuals.",
  "fully on-chain.",
  "no governance. no gatekeepers.",
  "insurance fund on every market.",
  "burn the admin key.",
  "deploy in 60 seconds.",
];

function TickerContent() {
  return (
    <>
      {ITEMS.map((text, i) => (
        <span
          key={i}
          className="shrink-0 px-8 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--warning)]/70"
        >
          {text}
          <span className="ml-8 text-[var(--warning)]/20">·</span>
        </span>
      ))}
    </>
  );
}

export function TickerBanner() {
  return (
    <div className="ticker-banner relative z-50 overflow-hidden border-b border-[var(--warning)]/15 bg-[var(--warning)]/[0.03]">
      <div className="ticker-track inline-flex">
        <TickerContent />
        <TickerContent />
      </div>
    </div>
  );
}
