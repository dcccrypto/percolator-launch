import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slab: "Eacc111111111111111111111111111111111111111",
  wallet: "DYvC111111111111111111111111111111111111111",

  markE6: 81_170_000n,
  positionSize: -10_000_000n,
  capital: 500_000_000n,
  maintenanceMarginBps: 500n,

  userAccount: {
    idx: 0,
    account: {
      // Mirror the reported market: an OPEN SHORT still exists.
      positionSize: -10_000_000n,
      capital: 500_000_000n,

      // v17/v18 does not persist the held entry here.
      entryPrice: 0n,
      adlABasis: 1_000_000_000_000_000n,

      // Explicit unknown-entry state: no recoverable entry information
      // remains in on-chain PnL.
      pnl: 0n,

      owner: {
        toBase58: () =>
          "DYvC111111111111111111111111111111111111111",
      },
    },
  },
}));

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => h.userAccount,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    slabAddress: h.slab,
    config: {
      lastEffectivePriceE6: h.markE6,
      invert: 0,
    },
    params: {
      maintenanceMarginBps: h.maintenanceMarginBps,
    },
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
  }),
}));

import { useLiqPrice } from "@/hooks/useLiqPrice";
import {
  getEntryPrice,
  saveEntryPrice,
} from "@/lib/entry-price";
import {
  computeLiqPrice,
  resolveEntryPrice,
} from "@/lib/trading";

const ENTRY_E6 = 100_000_000n;

function fallbackLiq(): bigint {
  const resolved = resolveEntryPrice(
    h.positionSize,
    0n,
    0n,
    h.markE6,
  );

  expect(resolved.source).toBe("unknown");

  return computeLiqPrice(
    resolved.entry,
    h.capital,
    h.positionSize,
    h.maintenanceMarginBps,
  );
}

function cachedLiq(): bigint {
  return computeLiqPrice(
    ENTRY_E6,
    h.capital,
    h.positionSize,
    h.maintenanceMarginBps,
  );
}

describe("chart liquidation risk survives browser-local entry-cache loss", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("CASE B: an open SHORT with no perc:entry key still has a liquidation price", () => {
    expect(h.userAccount.account.positionSize).toBeLessThan(0n);

    expect(
      getEntryPrice(
        h.slab,
        h.userAccount.idx,
        h.wallet,
      ),
    ).toBe(0n);

    const expected = fallbackLiq();
    expect(expected).toBeGreaterThan(0n);

    const { result } = renderHook(() => useLiqPrice());

    expect(result.current).toBe(expected);
  });

  it("CONTROL: an entry cached for another market is ignored and current-market risk uses fallback", () => {
    saveEntryPrice(
      "DifferentMarket111111111111111111111111111111111",
      h.userAccount.idx,
      ENTRY_E6,
      2,
      h.wallet,
    );

    expect(
      getEntryPrice(
        h.slab,
        h.userAccount.idx,
        h.wallet,
      ),
    ).toBe(0n);

    const expected = fallbackLiq();

    const { result } = renderHook(() => useLiqPrice());

    expect(result.current).toBe(expected);
  });

  it("CASE A: exact slab + idx + wallet cache uses the cached entry for liquidation risk", () => {
    saveEntryPrice(
      h.slab,
      h.userAccount.idx,
      ENTRY_E6,
      2,
      h.wallet,
    );

    expect(
      getEntryPrice(
        h.slab,
        h.userAccount.idx,
        h.wallet,
      ),
    ).toBe(ENTRY_E6);

    const expected = cachedLiq();
    const fallback = fallbackLiq();

    expect(expected).toBeGreaterThan(0n);
    expect(expected).not.toBe(fallback);

    const { result } = renderHook(() => useLiqPrice());

    expect(result.current).toBe(expected);
  });

  it("CROSS-DEVICE CONTROL: losing localStorage does not erase liquidation risk", () => {
    saveEntryPrice(
      h.slab,
      h.userAccount.idx,
      ENTRY_E6,
      2,
      h.wallet,
    );

    expect(
      getEntryPrice(
        h.slab,
        h.userAccount.idx,
        h.wallet,
      ),
    ).toBe(ENTRY_E6);

    // Same on-chain position viewed from another browser/device:
    // the local entry record is gone, but risk information must survive.
    localStorage.clear();

    expect(h.userAccount.account.positionSize).not.toBe(0n);

    expect(
      getEntryPrice(
        h.slab,
        h.userAccount.idx,
        h.wallet,
      ),
    ).toBe(0n);

    const expected = fallbackLiq();

    const { result } = renderHook(() => useLiqPrice());

    expect(result.current).toBe(expected);
  });
});