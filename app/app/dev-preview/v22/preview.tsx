"use client";

import { useState } from "react";
import { BandMarketNotice } from "@/components/v22/BandMarketNotice";
import { HoldingFeeChip } from "@/components/v22/HoldingFeeChip";
import { EarnExitQuote } from "@/components/earn/EarnExitQuote";
import { V22LaunchOptions, type V22OptionsState } from "@/components/create/V22LaunchOptions";
import { planLaunchV22 } from "@/lib/v22/launch-plan";
import { UnsupportedLayoutNotice } from "@/components/v22/UnsupportedLayoutNotice";
import type { BandRentView } from "@/lib/v22/band-rent-state";
import type { ExitQuote } from "@/lib/v22/earn-exit-run";

const band: BandRentView = {
  assetIndex: 0,
  lotExp: 3,
  band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms: 100_000_000n, recoveryMinutes: 64 },
  price: { markE6: 60_000_000n, targetE6: 50_000_000n, lagging: true, favourableCloseSide: "long" },
  rent: { enabled: true, maxE9PerSlot: 1000n, kinkBps: 5000, rateLongE9: 10n, rateShortE9: 0n },
};

const quote: ExitQuote = { mode: "pair", quote: 104_000_000n, minPayout: 103_948_000n, staleCount: 2, refreshSelected: 2, refreshDeferred: 0, computeUnits: 1_300_000, estimate: false };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border border-[var(--border)] p-3" data-testid={`preview-${title.toLowerCase().replace(/\W+/g, "-")}`}>
      <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">{title}</p>
      {children}
    </section>
  );
}

export function V22Preview() {
  const [opts, setOpts] = useState<V22OptionsState>({});
  const [phase, setPhase] = useState<"idle" | "quoted" | "refreshing">("idle");
  const plan = planLaunchV22({ tokenPriceE6: 400n, collateralDecimals: 6, collateralSymbol: "USDC", oracleMode: "keeper", growthOn: true, ...opts });
  const exit = {
    state: { phase, quote: phase === "quoted" ? quote : null, requoted: false, message: null, signature: null },
    getQuote: async () => setPhase("quoted"),
    confirm: async () => setPhase("refreshing"),
  };
  return (
    <main className="mx-auto max-w-[420px] space-y-4 bg-[var(--bg)] p-4" data-testid="dev-preview-v22">
      <Section title="Launch wizard options (token $0.0004)">
        <V22LaunchOptions value={opts} onChange={setOpts} plan={plan} symbol="TOK" />
        {plan.issues.length > 0 && <p data-testid="preview-issue" className="text-[11px] text-[var(--text-secondary)]">{plan.issues[0].message}</p>}
      </Section>
      <Section title="Earn exit">
        <EarnExitQuote exit={exit} decimals={6} symbol="USDC" canQuote />
      </Section>
      <Section title="Band market ticket">
        <BandMarketNotice view={band} collateralDecimals={6} collateralSymbol="USDC" />
        <p className="text-[11px] text-[var(--text)]">
          Position 12 TOK <HoldingFeeChip view={band} side="long" />
        </p>
        <button disabled title="Price is catching up; closing reopens shortly." className="w-full border border-[var(--short)]/30 py-1 text-[9px] uppercase text-[var(--short)] opacity-50">Close</button>
        <p className="text-[10px] text-[var(--text-secondary)]">Price is catching up; closing reopens shortly.</p>
      </Section>
      <Section title="Unsupported layout">
        <UnsupportedLayoutNotice />
      </Section>
    </main>
  );
}
