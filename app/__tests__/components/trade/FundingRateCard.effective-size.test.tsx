/**
 * #3077 follow-up: the funding estimate runs on the leg's EFFECTIVE size, and an
 * unknown ADL state skips the line instead of falling back to raw basis.
 */
import "@testing-library/jest-dom";
import { render, waitFor, cleanup } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ONE = 1_000_000_000_000_000n;
const OWNER = new PublicKey("11111111111111111111111111111111");
const h = vi.hoisted(() => ({
  factors: null as { aLong: bigint; aShort: bigint } | null,
  v17: true,
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    params: null,
    config: { collateralMint: OWNER },
    raw: null,
    adlFactors: h.factors,
    wrapperConfigV17: h.v17 ? {} : null,
  }),
}));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, fundingRate: null, isV17: false }) }));
vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: () => ({
    idx: 0,
    account: { owner: OWNER, positionSize: 80_000_000n, adlABasis: ONE, adlEpochSnap: 0n, capital: 1_000_000_000n, pnl: 0n },
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));
vi.mock("@/components/trade/FundingExplainerModal", () => ({ FundingExplainerModal: () => null }));

import { FundingRateCard } from "@/components/trade/FundingRateCard";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ currentRateBpsPerSlot: 1, hourlyRatePercent: 0.01, annualizedPercent: 1, netLpPosition: 0 }),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const est = async (container: HTMLElement) => {
  await waitFor(() => expect(container.textContent).toMatch(/\/8h/));
  return container.textContent?.match(/[+-]\d+\.\d{4} tokens/)?.[0] ?? null;
};

describe("FundingRateCard estimate", () => {
  it("deleveraged to 50%: funding is over 40 effective tokens (0.0960), not 80 raw (0.1920)", async () => {
    h.v17 = true;
    h.factors = { aLong: ONE / 2n, aShort: ONE };
    const { container } = render(<FundingRateCard slabAddress="S" />);
    expect(await est(container)).toBe("-0.0960 tokens");
  });

  it("NEGATIVE CONTROL: legacy v12 (no ADL) legitimately uses raw size: 0.1920", async () => {
    h.v17 = false;
    h.factors = null;
    const { container } = render(<FundingRateCard slabAddress="S" />);
    expect(await est(container)).toBe("-0.1920 tokens");
  });

  it("unknown ADL state on v17: the line is skipped, no raw-size figure", async () => {
    h.v17 = true;
    h.factors = null;
    const { container } = render(<FundingRateCard slabAddress="S" />);
    await waitFor(() => expect(container.textContent).toMatch(/\/8h/));
    expect(container.textContent).not.toMatch(/tokens/);
    expect(container.textContent).not.toContain("0.1920");
  });
});
