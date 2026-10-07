/**
 * #2560: useLiqPrice resolves the entry of the DISPLAYED portfolio. A portfolio that has its own
 * scoped entry uses it; one without falls back to the wallet's legacy entry (the cross/primary
 * account, whose entry is still written under the legacy key).
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { saveEntryPrice } from "@/lib/entry-price";
import { computeLiqPrice } from "@/lib/trading";

const SLAB = "Eacc111111111111111111111111111111111111111";
const WALLET = new PublicKey(new Uint8Array(32).fill(0x42));
const PF = new PublicKey(new Uint8Array(32).fill(0x11));
const ADL_ONE = 1_000_000_000_000_000n;
const h = vi.hoisted(() => ({ ua: null as unknown }));

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.ua }));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    slabAddress: SLAB,
    config: { lastEffectivePriceE6: 81_170_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: { aLong: ADL_ONE, aShort: ADL_ONE },
    wrapperConfigV17: {},
  }),
}));

import { useLiqPrice } from "@/hooks/useLiqPrice";

const SIZE = -10_000_000n;
const CAPITAL = 500_000_000n;

beforeEach(() => {
  localStorage.clear();
  h.ua = {
    idx: 0,
    pubkey: PF,
    account: { owner: WALLET, positionSize: SIZE, capital: CAPITAL, entryPrice: 0n, adlABasis: ADL_ONE, pnl: 0n, reservedPnl: 0n, feeCredits: 0n },
  };
});

describe("useLiqPrice reads the displayed portfolio's own entry", () => {
  it("a portfolio-scoped entry wins over the wallet's legacy one", () => {
    saveEntryPrice(SLAB, 0, 70_000_000n, 5, WALLET.toBase58()); // legacy (cross)
    saveEntryPrice(SLAB, 0, 80_000_000n, 5, WALLET.toBase58(), PF.toBase58()); // this portfolio's own
    const { result } = renderHook(() => useLiqPrice());
    expect(result.current).toBe(computeLiqPrice(80_000_000n, CAPITAL, SIZE, 500n));
    expect(result.current).not.toBe(computeLiqPrice(70_000_000n, CAPITAL, SIZE, 500n));
  });

  it("CONTROL: with no scoped entry the legacy (cross primary) entry still resolves", () => {
    saveEntryPrice(SLAB, 0, 70_000_000n, 5, WALLET.toBase58());
    const { result } = renderHook(() => useLiqPrice());
    expect(result.current).toBe(computeLiqPrice(70_000_000n, CAPITAL, SIZE, 500n));
  });
});
