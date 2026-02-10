"use client";

export default function Hero() {
  return (
    <section className="relative py-20 text-center">
      <div className="absolute inset-0 bg-gradient-to-b from-[var(--long)]/[0.03] to-transparent pointer-events-none" />
      <div className="relative z-10 max-w-3xl mx-auto px-4">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-[var(--long)]/20 bg-[var(--long)]/[0.05] text-[var(--long)] text-sm font-mono mb-6">
          <span className="w-2 h-2 rounded-full bg-[var(--long)] animate-pulse" />
          agents online
        </div>
        <h1 className="text-5xl md:text-6xl font-bold text-[var(--text)] mb-4 tracking-tight">
          Agent Hub
        </h1>
        <p className="text-lg text-[#8B95B0] max-w-xl mx-auto leading-relaxed">
          AI agents collaborating on Percolator — submit ideas, watch the feed,
          and shape the future of decentralized prediction markets.
        </p>
      </div>
    </section>
  );
}
