"use client";

import { Suspense } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { CreateMarketWizard } from "@/components/create/CreateMarketWizard";
import { ScrollReveal } from "@/components/ui/ScrollReveal";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

/** Inner component that reads search params (needs Suspense boundary) */
function CreatePageInner() {
  const { connected } = useWallet();
  const searchParams = useSearchParams();
  const initialMint = searchParams.get("mint") ?? undefined;

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      {/* Grid background */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      <div className="relative mx-auto max-w-4xl px-4 py-10">
        {/* Page header */}
        <ScrollReveal>
          <div className="mb-8">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // deploy
            </div>
            <h1
              className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              <span className="font-normal text-white/50">Launch a </span>Market
            </h1>
            <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
              Deploy a perpetual futures market in ~60 seconds.
            </p>
            <div
              className="mt-2 text-[11px] text-[var(--text-dim)]"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              small: ~0.5 SOL &middot; medium: ~2 SOL &middot; large: ~7 SOL
            </div>
          </div>
        </ScrollReveal>

        {/* Wallet warning */}
        {!connected && (
          <div className="mb-6 flex items-center justify-between border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-5 w-5 items-center justify-center border border-[var(--warning)]/30">
                <span className="text-[10px] text-[var(--warning)]">!</span>
              </div>
              <p className="text-[12px] font-medium text-[var(--warning)]">
                Connect your wallet to continue.
              </p>
            </div>
            <WalletMultiButton />
          </div>
        )}

        {/* Main wizard container */}
        <ScrollReveal delay={0.1}>
          <div className="border border-[var(--border)] bg-[var(--panel-bg)]">
            <CreateMarketWizard initialMint={initialMint} />
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}

/** Page wrapper with Suspense for useSearchParams */
export default function CreatePage() {
  return (
    <Suspense>
      <CreatePageInner />
    </Suspense>
  );
}
