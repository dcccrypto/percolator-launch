"use client";

import { FC, useState, useEffect } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useMyMarkets, type MyMarket } from "@/hooks/useMyMarkets";
import { useAdminActions } from "@/hooks/useAdminActions";
import { useToast } from "@/hooks/useToast";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowButton } from "@/components/ui/GlowButton";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";
import { getConfig, explorerAccountUrl } from "@/lib/config";
import { deriveInsuranceLpMint } from "@percolator/core";

/* ─── helpers ─── */

function fmt(v: bigint, decimals = 6): string {
  const n = Number(v) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtPrice(v: bigint): string {
  const n = Number(v) / 1e6;
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function timeAgo(slot: bigint, currentSlot: bigint): string {
  const diff = Number(currentSlot - slot);
  if (diff < 0) return "just now";
  const secs = Math.floor(diff * 0.4);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/* ─── stat card ─── */

const StatCard: FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <GlassCard padding="sm" hover={false}>
    <p className="text-xs text-[#8B95B0]">{label}</p>
    <p className="mt-1 text-xl font-bold text-white">{value}</p>
    {sub && <p className="mt-0.5 text-xs text-[#8B95B0]">{sub}</p>}
  </GlassCard>
);

/* ─── confirmation dialog ─── */

const ConfirmDialog: FC<{
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}> = ({ open, title, description, confirmLabel, onConfirm, onCancel, danger }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <GlassCard padding="lg" hover={false} className="mx-4 max-w-md">
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <p className="mt-2 text-sm text-[#8B95B0]">{description}</p>
        <div className="mt-6 flex gap-3">
          <GlowButton variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </GlowButton>
          <GlowButton
            variant={danger ? "secondary" : "primary"}
            size="sm"
            onClick={onConfirm}
            className={danger ? "!border-red-500/30 !text-red-400 hover:!bg-red-500/10" : ""}
          >
            {confirmLabel}
          </GlowButton>
        </div>
      </GlassCard>
    </div>
  );
};

/* ─── input dialog ─── */

const InputDialog: FC<{
  open: boolean;
  title: string;
  description: string;
  placeholder: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}> = ({ open, title, description, placeholder, confirmLabel, onConfirm, onCancel }) => {
  const [value, setValue] = useState("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <GlassCard padding="lg" hover={false} className="mx-4 max-w-md w-full">
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <p className="mt-2 text-sm text-[#8B95B0]">{description}</p>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="mt-4 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-4 py-2.5 text-sm text-white placeholder-[#8B95B0]/50 outline-none focus:border-[#00FFB2]/30"
        />
        <div className="mt-4 flex gap-3">
          <GlowButton variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </GlowButton>
          <GlowButton
            variant="primary"
            size="sm"
            disabled={!value.trim()}
            onClick={() => { onConfirm(value.trim()); setValue(""); }}
          >
            {confirmLabel}
          </GlowButton>
        </div>
      </GlassCard>
    </div>
  );
};

/* ─── market card ─── */

const MarketCard: FC<{
  market: MyMarket;
  insuranceMintExists: boolean;
}> = ({ market, insuranceMintExists }) => {
  const { toast } = useToast();
  const actions = useAdminActions();
  const cfg = getConfig();

  const slab = market.slabAddress.toBase58();
  const oi = market.engine.totalOpenInterest;
  const vault = market.engine.vault;
  const insurance = market.engine.insuranceFund.balance;
  const lastCrank = market.engine.lastCrankSlot;
  const currentSlot = market.engine.currentSlot;
  const staleness = Number(currentSlot - lastCrank);
  const healthy = staleness < Number(market.engine.maxCrankStalenessSlots);
  const oraclePrice = market.config.authorityPriceE6;
  const oracleAuthority = market.config.oracleAuthority.toBase58();
  const hasOracleAuthority = oracleAuthority !== PublicKey.default.toBase58();

  const [showBurnConfirm, setShowBurnConfirm] = useState(false);
  const [showOracleInput, setShowOracleInput] = useState(false);
  const [showPriceInput, setShowPriceInput] = useState(false);
  const [showTopUpInput, setShowTopUpInput] = useState(false);

  async function handleAction(name: string, fn: () => Promise<string>) {
    try {
      const sig = await fn();
      toast(`${name} successful! Tx: ${sig.slice(0, 16)}…`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : `${name} failed`, "error");
    }
  }

  return (
    <>
      <GlassCard padding="none" glow hover={false}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-[#00FFB2]/20 to-[#7B61FF]/20 text-sm font-bold text-[#00FFB2]">
              P
            </span>
            <div>
              <p className="font-semibold text-white">{market.label}</p>
              <a
                href={explorerAccountUrl(slab)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#8B95B0] hover:text-[#00FFB2] transition-colors"
              >
                {shortAddr(slab)} ↗
              </a>
            </div>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${
              healthy
                ? "bg-[#00FFB2]/10 text-[#00FFB2]"
                : "bg-red-500/10 text-red-400"
            }`}
          >
            {healthy ? "● Healthy" : "● Stale"}
          </span>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-px bg-white/[0.03] sm:grid-cols-4">
          {[
            { label: "Oracle Price", value: oraclePrice > 0n ? fmtPrice(oraclePrice) : "N/A" },
            { label: "Open Interest", value: fmt(oi) },
            { label: "Vault Balance", value: fmt(vault) },
            { label: "Insurance", value: fmt(insurance) },
            { label: "Last Crank", value: timeAgo(lastCrank, currentSlot) },
            { label: "Staleness", value: `${staleness} slots` },
            { label: "Oracle Authority", value: hasOracleAuthority ? shortAddr(oracleAuthority) : "None" },
            { label: "Active Accounts", value: market.engine.numUsedAccounts.toString() },
          ].map((s) => (
            <div key={s.label} className="bg-[#0a0c14] p-4">
              <p className="text-[10px] uppercase tracking-wider text-[#8B95B0]/70">{s.label}</p>
              <p className="mt-1 text-sm font-medium text-white">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 border-t border-white/[0.06] p-5">
          <GlowButton variant="secondary" size="sm" onClick={() => setShowOracleInput(true)} disabled={actions.loading === "setOracleAuthority"}>
            🔑 Set Oracle Authority
          </GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => setShowPriceInput(true)} disabled={actions.loading === "pushPrice"}>
            📊 Push Price
          </GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => setShowTopUpInput(true)} disabled={actions.loading === "topUpInsurance"}>
            🛡️ Top Up Insurance
          </GlowButton>
          {!insuranceMintExists && (
            <GlowButton
              variant="secondary"
              size="sm"
              onClick={() => handleAction("Create Insurance Mint", () => actions.createInsuranceMint(market))}
              disabled={actions.loading === "createInsuranceMint"}
            >
              {actions.loading === "createInsuranceMint" ? "Creating…" : "🏦 Create Insurance Mint"}
            </GlowButton>
          )}
          <GlowButton
            variant="ghost"
            size="sm"
            onClick={() => setShowBurnConfirm(true)}
            disabled={actions.loading === "renounceAdmin"}
            className="!text-red-400/70 hover:!text-red-400"
          >
            🔥 Burn Admin Key
          </GlowButton>
          <Link href={`/trade/${slab}`}>
            <GlowButton variant="ghost" size="sm">
              Trade →
            </GlowButton>
          </Link>
        </div>
      </GlassCard>

      {/* Dialogs */}
      <InputDialog
        open={showOracleInput}
        title="Set Oracle Authority"
        description="Enter the public key that will be authorized to push oracle price updates. Typically your crank wallet."
        placeholder={cfg.crankWallet || "Pubkey…"}
        confirmLabel="Set Authority"
        onConfirm={(v) => {
          setShowOracleInput(false);
          handleAction("Set Oracle Authority", () => actions.setOracleAuthority(market, v));
        }}
        onCancel={() => setShowOracleInput(false)}
      />

      <InputDialog
        open={showPriceInput}
        title="Push Oracle Price"
        description="Enter the price in USD (e.g. 1.50). This will be converted to E6 format internally."
        placeholder="1.00"
        confirmLabel="Push Price"
        onConfirm={(v) => {
          setShowPriceInput(false);
          const priceE6 = Math.round(parseFloat(v) * 1e6).toString();
          handleAction("Push Price", () => actions.pushPrice(market, priceE6));
        }}
        onCancel={() => setShowPriceInput(false)}
      />

      <InputDialog
        open={showTopUpInput}
        title="Top Up Insurance Fund"
        description="Enter the amount of collateral tokens to add to the insurance fund (in token units, e.g. 100)."
        placeholder="100"
        confirmLabel="Top Up"
        onConfirm={(v) => {
          setShowTopUpInput(false);
          const amount = BigInt(Math.round(parseFloat(v) * 1e6));
          handleAction("Top Up Insurance", () => actions.topUpInsurance(market, amount));
        }}
        onCancel={() => setShowTopUpInput(false)}
      />

      <ConfirmDialog
        open={showBurnConfirm}
        title="⚠️ Burn Admin Key"
        description="This action is IRREVERSIBLE. Once you renounce admin, you will never be able to update config, set oracle, or perform any admin actions on this market. The market becomes fully immutable."
        confirmLabel="I understand, burn it"
        danger
        onConfirm={() => {
          setShowBurnConfirm(false);
          handleAction("Burn Admin Key", () => actions.renounceAdmin(market));
        }}
        onCancel={() => setShowBurnConfirm(false)}
      />
    </>
  );
};

/* ─── loading skeleton ─── */

const LoadingSkeleton: FC = () => (
  <main className="mx-auto max-w-6xl px-4 py-12">
    <div className="mb-8 flex items-center justify-between">
      <ShimmerSkeleton className="h-9 w-48" />
      <ShimmerSkeleton className="h-10 w-32" rounded="xl" />
    </div>
    <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
      {[1, 2, 3].map((i) => (
        <ShimmerSkeleton key={i} className="h-24" rounded="2xl" />
      ))}
    </div>
    {[1, 2].map((i) => (
      <ShimmerSkeleton key={i} className="mb-4 h-72" rounded="2xl" />
    ))}
  </main>
);

/* ─── main page ─── */

const MyMarketsPage: FC = () => {
  const { myMarkets, loading, error, connected } = useMyMarkets();
  const { connection } = useConnection();
  const [insuranceMintMap, setInsuranceMintMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!myMarkets.length) return;
    let cancelled = false;
    async function check() {
      const map: Record<string, boolean> = {};
      for (const m of myMarkets) {
        const [mintPda] = deriveInsuranceLpMint(m.programId, m.slabAddress);
        try {
          const info = await connection.getAccountInfo(mintPda);
          map[m.slabAddress.toBase58()] = info !== null && info.data.length > 0;
        } catch {
          map[m.slabAddress.toBase58()] = false;
        }
      }
      if (!cancelled) setInsuranceMintMap(map);
    }
    check();
    return () => { cancelled = true; };
  }, [myMarkets, connection]);

  if (!connected) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-24 text-center">
        <GlassCard padding="lg" hover={false} className="mx-auto max-w-md">
          <div className="text-4xl">🔐</div>
          <h1 className="mt-4 text-2xl font-bold text-white">Admin Dashboard</h1>
          <p className="mt-2 text-sm text-[#8B95B0]">
            Connect your wallet to manage your Percolator markets.
          </p>
        </GlassCard>
      </main>
    );
  }

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-24 text-center">
        <GlassCard padding="lg" hover={false} className="mx-auto max-w-md">
          <div className="text-4xl">❌</div>
          <h1 className="mt-4 text-2xl font-bold text-white">Error</h1>
          <p className="mt-2 text-sm text-red-400">{error}</p>
        </GlassCard>
      </main>
    );
  }

  if (myMarkets.length === 0) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-24 text-center">
        <GlassCard padding="lg" hover={false} className="mx-auto max-w-md">
          <div className="text-4xl">🚀</div>
          <h1 className="mt-4 text-2xl font-bold text-white">No Markets Yet</h1>
          <p className="mt-2 mb-6 text-sm text-[#8B95B0]">
            You haven&apos;t created any markets. Launch your first one!
          </p>
          <Link href="/create">
            <GlowButton>✨ Create Market</GlowButton>
          </Link>
        </GlassCard>
      </main>
    );
  }

  const totalMarkets = myMarkets.length;
  const totalVault = myMarkets.reduce((acc, m) => acc + m.engine.vault, 0n);
  const totalInsurance = myMarkets.reduce((acc, m) => acc + m.engine.insuranceFund.balance, 0n);

  return (
    <main className="mx-auto max-w-6xl px-4 py-12">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Admin Dashboard</h1>
          <p className="mt-1 text-sm text-[#8B95B0]">Manage your Percolator markets</p>
        </div>
        <Link href="/create">
          <GlowButton size="sm">+ New Market</GlowButton>
        </Link>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Markets" value={totalMarkets.toString()} />
        <StatCard label="Total TVL (Vault)" value={fmt(totalVault)} sub="collateral tokens" />
        <StatCard label="Total Insurance" value={fmt(totalInsurance)} sub="collateral tokens" />
      </div>

      <div className="grid gap-6">
        {myMarkets.map((m) => (
          <MarketCard
            key={m.slabAddress.toBase58()}
            market={m}
            insuranceMintExists={insuranceMintMap[m.slabAddress.toBase58()] ?? false}
          />
        ))}
      </div>
    </main>
  );
};

export default MyMarketsPage;
