"use client";

import { FC, useState } from "react";
import Link from "next/link";
import { useMyMarkets } from "@/hooks/useMyMarkets";
import { useToast } from "@/hooks/useToast";
import { SLAB_TIERS } from "@percolator/core";
import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

function getSlabTierFromAccounts(maxAccounts: number): { label: string; color: string } {
  const small = SLAB_TIERS.small.maxAccounts;
  const medium = SLAB_TIERS.medium.maxAccounts;
  if (maxAccounts <= small) return { label: "Small", color: "text-[#b0b7c8] bg-[#b0b7c8]/10" };
  if (maxAccounts <= medium) return { label: "Medium", color: "text-[#00d4aa] bg-[#00d4aa]/10" };
  return { label: "Large", color: "text-[#f0b232] bg-[#f0b232]/10" };
}

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
      <div className="terminal-grid min-h-[calc(100vh-48px)]">
        <div className="mx-auto max-w-5xl px-3 py-6 lg:px-4">
          <h1 className="mb-1 text-2xl font-bold text-white">My Markets</h1>
          <p className="mb-6 text-sm text-[#4a5068]">Manage markets you&apos;ve deployed</p>
          <div className="rounded-xl bg-[#0c0e14] p-16 text-center ring-1 ring-[#1e2433]">
            <div className="mb-3 text-3xl text-[#1e2433]">🔒</div>
            <h3 className="mb-1 text-lg font-semibold text-white">Connect your wallet</h3>
            <p className="mb-4 text-sm text-[#4a5068]">Connect your wallet to view markets you&apos;ve created.</p>
            <WalletMultiButton />
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="terminal-grid min-h-[calc(100vh-48px)]">
        <div className="mx-auto max-w-5xl px-3 py-6 lg:px-4">
          <h1 className="mb-1 text-2xl font-bold text-white">My Markets</h1>
          <p className="mb-6 text-sm text-[#4a5068]">Manage markets you&apos;ve deployed</p>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl bg-[#0c0e14] ring-1 ring-[#1e2433]" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="terminal-grid min-h-[calc(100vh-48px)]">
        <div className="mx-auto max-w-5xl px-3 py-6 lg:px-4">
          <h1 className="mb-1 text-2xl font-bold text-white">My Markets</h1>
          <p className="mb-6 text-sm text-[#4a5068]">Manage markets you&apos;ve deployed</p>
          <div className="rounded-xl bg-[#0c0e14] p-16 text-center ring-1 ring-[#1e2433]">
            <div className="mb-3 text-3xl text-[#1e2433]">⚠️</div>
            <p className="text-sm text-red-400">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (myMarkets.length === 0) {
    return (
      <div className="terminal-grid min-h-[calc(100vh-48px)]">
        <div className="mx-auto max-w-5xl px-3 py-6 lg:px-4">
          <h1 className="mb-1 text-2xl font-bold text-white">My Markets</h1>
          <p className="mb-6 text-sm text-[#4a5068]">Manage markets you&apos;ve deployed</p>
          <div className="rounded-xl bg-[#0c0e14] p-16 text-center ring-1 ring-[#1e2433]">
            <div className="mb-3 text-3xl text-[#1e2433]">🚀</div>
            <h3 className="mb-1 text-lg font-semibold text-white">No markets yet</h3>
            <p className="mb-4 text-sm text-[#4a5068]">You haven&apos;t created any markets yet. Launch your first one!</p>
            <Link href="/create" className="inline-block rounded-lg bg-[#00d4aa] px-6 py-2.5 text-sm font-bold text-[#080a0f]">
              Launch Market
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-grid min-h-[calc(100vh-48px)]">
      <div className="mx-auto max-w-5xl px-3 py-6 lg:px-4">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">My Markets</h1>
            <p className="mt-0.5 text-sm text-[#4a5068]">Manage markets you&apos;ve deployed</p>
          </div>
          <Link
            href="/create"
            className="rounded-lg bg-[#00d4aa] px-5 py-2 text-center text-sm font-bold text-[#080a0f] transition-all hover:bg-[#00e8bb] hover:shadow-[0_0_20px_rgba(0,212,170,0.15)]"
          >
            + New Market
          </Link>
        </div>

        <div className="space-y-3">
          {myMarkets.map((m) => {
            const slab = m.slabAddress.toBase58();
            const mint = m.config.collateralMint.toBase58();
            const oi = Number(m.engine.totalOpenInterest) / 1e6;
            const vault = Number(m.engine.vault) / 1e6;
            const lastCrank = Number(m.engine.lastCrankSlot);
            const currentSlot = Number(m.engine.currentSlot);
            const staleness = currentSlot - lastCrank;
            const healthy = staleness < Number(m.engine.maxCrankStalenessSlots);
            const tier = getSlabTierFromAccounts(Number(m.params.maxAccounts));

            return (
              <div
                key={slab}
                className="rounded-xl bg-[#0c0e14] p-6 ring-1 ring-[#1e2433] transition-colors hover:bg-[#0f1118]"
              >
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#00d4aa]/10 text-sm font-bold text-[#00d4aa]">
                      P
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-white">{m.label}</p>
                        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${tier.color}`}>
                          {tier.label}
                        </span>
                      </div>
                      <p className="data-cell text-[11px] text-[#4a5068]">
                        {mint.slice(0, 8)}…{mint.slice(-4)}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                      healthy
                        ? "bg-[#00d4aa]/10 text-[#00d4aa]"
                        : "bg-red-500/10 text-red-400"
                    }`}
                  >
                    {healthy ? "Healthy" : "Stale"}
                  </span>
                </div>

                <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat label="Open Interest" value={oi.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
                  <Stat label="Vault" value={vault.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
                  <Stat label="Last Crank" value={lastCrank.toLocaleString()} />
                  <Stat label="Staleness" value={`${staleness} slots`} />
                </div>

                <div className="flex items-center gap-3">
                  <Link
                    href={`/trade/${slab}`}
                    className="rounded-lg border border-[#1e2433] px-4 py-2 text-sm font-medium text-[#b0b7c8] transition-colors hover:bg-[#1e2433] hover:text-white"
                  >
                    Trade →
                  </Link>
                  <button
                    onClick={() => handleCrank(slab)}
                    disabled={cranking[slab]}
                    className="rounded-lg bg-[#00d4aa]/10 px-4 py-2 text-sm font-medium text-[#00d4aa] transition-colors hover:bg-[#00d4aa]/20 disabled:opacity-50"
                  >
                    {cranking[slab] ? "Cranking…" : "⚡ Crank Now"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const Stat: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <p className="text-[10px] font-medium uppercase tracking-wider text-[#2a2f40]">{label}</p>
    <p className="data-cell mt-0.5 text-sm font-medium text-white">{value}</p>
  </div>
);

export default MyMarketsPage;
