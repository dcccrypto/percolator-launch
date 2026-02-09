"use client";

const phases = [
  {
    phase: 1,
    title: "Devnet Launch",
    status: "Live now",
    statusColor: "text-[#00FFB2]",
    dot: "bg-[#00FFB2]",
    description: "Market creation, trading, insurance LP.",
  },
  {
    phase: 2,
    title: "vAMM + Smart Router",
    status: "In progress",
    statusColor: "text-yellow-400",
    dot: "bg-yellow-400",
    description: "Automatic liquidity, best oracle detection.",
  },
  {
    phase: 3,
    title: "Mainnet",
    status: "Upcoming",
    statusColor: "text-[#8B95B0]",
    dot: "bg-[#8B95B0]",
    description: "Real deployment, admin key burns, security hardening.",
  },
  {
    phase: 4,
    title: "Agent Marketplace",
    status: "Planned",
    statusColor: "text-[#5a6382]",
    dot: "bg-[#5a6382]",
    description:
      "AI agents can create and manage markets autonomously.",
  },
];

export default function RoadmapBoard() {
  return (
    <section className="w-full max-w-4xl mx-auto px-4 mb-20">
      <h2 className="text-sm font-mono text-[#00FFB2] mb-3 uppercase tracking-widest">
        &gt; roadmap
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {phases.map((p) => (
          <div
            key={p.phase}
            className="rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl p-5 hover:border-white/[0.12] transition-colors"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-mono text-[#5a6382]">
                PHASE {p.phase}
              </span>
              <span
                className={`flex items-center gap-1.5 text-xs font-mono ${p.statusColor}`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${p.dot} ${p.phase === 1 ? "animate-pulse" : ""}`}
                />
                {p.status}
              </span>
            </div>
            <h3 className="text-lg font-bold text-[#F0F4FF] mb-1">
              {p.title}
            </h3>
            <p className="text-sm text-[#8B95B0]">{p.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
