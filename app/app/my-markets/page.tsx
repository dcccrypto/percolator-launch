"use client";

import { FC, useState } from "react";
import Link from "next/link";
import { useMyMarkets } from "@/hooks/useMyMarkets";
import { useToast } from "@/hooks/useToast";

const MyMarketsPage: FC = () => {
  const { myMarkets, loading, error, connected } = useMyMarkets();
  const { toast } = useToast();
  const [cranking, setCranking] = useState<Record<string, boolean>>({});

  async function handleCrank(slab: string) {
    setCranking((prev) => ({ ...prev, [slab]: true }));
    try {
      const res = await fetch(`/api/crank/${slab}`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast(`Cranked successfully! Sig: ${data.signature?.slice(0, 16)}…`, "success");
      } else {
        toast(data.error || "Crank failed", "error");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Crank failed", "error");
    } finally {
      setCranking((prev) => ({ ...prev, [slab]: false }));
    }
  }

  if (!connected) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-16 text-center">
        <h1 className="mb-4 text-3xl font-bold text-white">My Markets</h1>
        <p className="text-slate-400">Connect your wallet to view your markets.</p>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-16 text-center">
        <h1 className="mb-4 text-3xl font-bold text-white">My Markets</h1>
        <div className="flex items-center justify-center gap-2 text-slate-400">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          Loading markets…
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-16 text-center">
        <h1 className="mb-4 text-3xl font-bold text-white">My Markets</h1>
        <p className="text-red-400">Error: {error}</p>
      </main>
    );
  }

  if (myMarkets.length === 0) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-16 text-center">
        <h1 className="mb-4 text-3xl font-bold text-white">My Markets</h1>
        <p className="mb-6 text-slate-400">
          You haven&apos;t created any markets yet. Launch one now!
        </p>
        <Link
          href="/create"
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
        >
          ✨ Create Market
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-16">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-3xl font-bold text-white">My Markets</h1>
        <Link
          href="/create"
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
        >
          + New Market
        </Link>
      </div>

      <div className="grid gap-4">
        {myMarkets.map((m) => {
          const slab = m.slabAddress.toBase58();
          const mint = m.config.collateralMint.toBase58();
          const oi = Number(m.engine.totalOpenInterest) / 1e6;
          const vault = Number(m.engine.vault) / 1e6;
          const lastCrank = Number(m.engine.lastCrankSlot);
          const currentSlot = Number(m.engine.currentSlot);
          const staleness = currentSlot - lastCrank;
          const healthy = staleness < Number(m.engine.maxCrankStalenessSlots);

          return (
            <div
              key={slab}
              className="rounded-xl border border-white/[0.06] bg-[#0f1118] p-6"
            >
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/20 text-sm font-bold text-emerald-400">
                    P
                  </span>
                  <div>
                    <p className="font-semibold text-white">{m.label}</p>
                    <p className="text-xs text-slate-500">
                      Mint: {mint.slice(0, 8)}…
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                    healthy
                      ? "bg-emerald-500/10 text-emerald-400"
                      : "bg-red-500/10 text-red-400"
                  }`}
                >
                  {healthy ? "Healthy" : "Stale"}
                </span>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Open Interest" value={`${oi.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
                <Stat label="Vault" value={`${vault.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
                <Stat label="Last Crank Slot" value={lastCrank.toLocaleString()} />
                <Stat label="Staleness" value={`${staleness} slots`} />
              </div>

              <div className="flex items-center gap-3">
                <Link
                  href={`/trade/${slab}`}
                  className="rounded-lg border border-white/[0.06] px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-[#1e2433] hover:text-white"
                >
                  Trade →
                </Link>
                <button
                  onClick={() => handleCrank(slab)}
                  disabled={cranking[slab]}
                  className="rounded-lg bg-emerald-600/20 px-4 py-2 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-600/30 disabled:opacity-50"
                >
                  {cranking[slab] ? "Cranking…" : "⚡ Crank Now"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
};

const Stat: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <p className="text-xs text-slate-500">{label}</p>
    <p className="text-sm font-medium text-white">{value}</p>
  </div>
);

export default MyMarketsPage;
