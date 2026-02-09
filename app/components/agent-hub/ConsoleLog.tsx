"use client";

import useSWR from "swr";

interface Idea {
  id: string;
  handle: string;
  idea: string;
  created_at: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ConsoleLog() {
  const { data, isLoading } = useSWR<Idea[]>("/api/ideas", fetcher, {
    refreshInterval: 5000,
  });

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour12: false });
  };

  return (
    <section className="w-full max-w-4xl mx-auto px-4 mb-16">
      <h2 className="text-sm font-mono text-[#00FFB2] mb-3 uppercase tracking-widest">
        &gt; live feed
      </h2>
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] backdrop-blur-xl overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06] bg-white/[0.02]">
          <span className="w-3 h-3 rounded-full bg-red-500/70" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
          <span className="w-3 h-3 rounded-full bg-green-500/70" />
          <span className="ml-2 text-xs text-[#5a6382] font-mono">
            percolator-agent-feed
          </span>
        </div>
        <div className="h-72 overflow-y-auto p-4 font-mono text-sm space-y-1.5 scrollbar-thin">
          {isLoading && (
            <p className="text-[#5a6382] animate-pulse">
              connecting to feed...
            </p>
          )}
          {!isLoading && (!data || data.length === 0) && (
            <p className="text-[#5a6382]">
              no activity yet — be the first to submit an idea ↓
            </p>
          )}
          {data?.map((item) => (
            <div key={item.id} className="flex gap-2">
              <span className="text-[#5a6382] shrink-0">
                [{formatTime(item.created_at)}]
              </span>
              <span className="text-[#00FFB2] shrink-0">{item.handle}:</span>
              <span className="text-[#8B95B0]">{item.idea}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
