/**
 * #2560: the chart's PnL badge resolves the entry of the DISPLAYED portfolio: its own scoped entry
 * when it has one, else the wallet's legacy entry (the cross/primary account).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { saveEntryPrice } from "@/lib/entry-price";

const SLAB = "Fz5JfUcbEdt5DNSNwZpBn2dZ7NpN8MnvJMiYjnqMacMh";
const OWNER = new PublicKey("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa");
const PF = new PublicKey(new Uint8Array(32).fill(0x11));
const ADL_ONE = 1_000_000_000_000_000n;

const account = { owner: OWNER, positionSize: -10_000_000_000n, adlABasis: ADL_ONE, capital: 20_000_000n, entryPrice: 0n, pnl: 1_020_000n };

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => ({ idx: 0, pubkey: PF, account }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    slabAddress: SLAB,
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    config: { collateralMint: null },
    adlFactors: { aLong: ADL_ONE, aShort: ADL_ONE },
  }),
}));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 13_330n, priceUsd: 0.01333 }) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));

const { ChartPnlBadge } = await import("@/components/trade/ChartPnlBadge");
const usd = (c: HTMLElement) => c.textContent?.match(/[+-]?\$\d+\.\d{2}/)?.[0] ?? null;

beforeEach(() => localStorage.clear());

describe("ChartPnlBadge reads the displayed portfolio's own entry", () => {
  it("scoped entry wins: 10,000 short from $0.013432 to $0.01333 = +$1.02 (the legacy $0.0130 would read -$3.30)", () => {
    saveEntryPrice(SLAB, 0, 13_000n, 5, OWNER.toBase58()); // legacy
    saveEntryPrice(SLAB, 0, 13_432n, 5, OWNER.toBase58(), PF.toBase58()); // this portfolio's own
    expect(usd(render(<ChartPnlBadge slabAddress={SLAB} />).container)).toBe("+$1.02");
  });

  it("CONTROL: with only the legacy entry the (cross primary) badge uses it", () => {
    saveEntryPrice(SLAB, 0, 13_000n, 5, OWNER.toBase58());
    expect(usd(render(<ChartPnlBadge slabAddress={SLAB} />).container)).toBe("-$3.30");
  });
});
