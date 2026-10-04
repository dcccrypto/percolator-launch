/**
 * Portfolio's "Earn and stake positions" panel and LP Value read useLpPositions, which only knew
 * /api/stake/pools. An Earn (LP vault) deposit lives in the wrapper's LP Vault Registry, so it
 * never appeared: the panel said "No Earn or stake positions" and LP Value read $0.00.
 */
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wallet = new PublicKey("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa");
const SLAB_A = "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx";
const SLAB_B = "5hFefu1F6Y41b8JwFvSo7jeYni5Vo56FZ8hZL1bpvYnJ";
const mocks = vi.hoisted(() => ({
  connection: {} as Record<string, unknown>,
  readEarnPositions: vi.fn(),
  markets: { ok: true, body: {} as unknown },
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: mocks.connection }),
  useWalletCompat: () => ({ publicKey: wallet }),
}));
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => {} }));
vi.mock("@/lib/limits/earn-positions", () => ({ readEarnPositions: mocks.readEarnPositions }));

import { useLpPositions, type LpPosition } from "@/hooks/useLpPositions";
import { LpPositionsPanel } from "@/components/portfolio/LpPositionsPanel";

async function settled() {
  const hook = renderHook(() => useLpPositions());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook.result.current;
}

describe("useLpPositions: Earn deposits", () => {
  beforeEach(() => {
    mocks.readEarnPositions.mockReset();
    mocks.markets = { ok: true, body: { markets: [{ slab_address: SLAB_A, symbol: "SI", name: "SI" }, { slab_address: SLAB_B, symbol: "OTC" }] } };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/markets")
      ? { ok: mocks.markets.ok, status: mocks.markets.ok ? 200 : 500, json: async () => mocks.markets.body }
      : { ok: true, json: async () => ({ pools: [] }) }));
  });

  it("lists an Earn deposit and counts it in the total when there are no stake pools", async () => {
    mocks.readEarnPositions.mockResolvedValue(new Map([
      [SLAB_A, { shares: 250_000_000n, valueAtoms: 251_500_000n }],
      [SLAB_B, { shares: 0n, valueAtoms: 0n }],
    ]));
    const r = await settled();
    expect(r.error).toBeNull();
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0]).toMatchObject({ kind: "earn", slabAddress: SLAB_A, symbol: "SI" });
    expect(r.positions[0].redeemable).toBeCloseTo(251.5, 6);
    expect(r.totalRedeemable).toBeCloseTo(251.5, 6);
    expect(mocks.readEarnPositions.mock.calls[0][3]).toEqual([SLAB_A, SLAB_B]);
  });

  it("reports an error, not an empty list, when the markets read fails", async () => {
    mocks.markets = { ok: false, body: {} };
    const r = await settled();
    expect(r.error).toMatch(/markets/);
    expect(mocks.readEarnPositions).not.toHaveBeenCalled();
  });

  it("reports an error when the Earn read itself fails", async () => {
    mocks.readEarnPositions.mockRejectedValue(new Error("429"));
    const r = await settled();
    expect(r.error).toBe("429");
  });
});

describe("LpPositionsPanel: Earn rows", () => {
  const earn: LpPosition = {
    poolAddress: SLAB_A, slabAddress: SLAB_A, collateralMint: "", lpMint: "", name: "SI", symbol: "SI", logoUrl: null,
    lpBalanceRaw: 1n, lpBalance: 0, redeemableRaw: 251_500_000n, redeemable: 251.5, totalLpSupply: 0, tvl: 0,
    userSharePct: 0, cooldownSlots: 0, cooldownElapsed: true, apr: 0, poolMode: 1, kind: "earn",
  };

  // #2871 split the panel into Vault/Stake sections: an Earn row now deep-links to its own
  // market's Earn page (/earn/<slab>) and is labelled "Earn vault" under the "Vault" heading.
  it("links to /earn/<slab>, says Earn vault, and leaves out the stake-pool details", () => {
    render(<LpPositionsPanel loading={false} positions={[earn]} totalRedeemable={251.5} error={null} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe(`/earn/${SLAB_A}`);
    expect(screen.getByText("Earn vault")).toBeTruthy();
    expect(screen.getByText("Vault")).toBeTruthy();
    expect(screen.queryByText("Fee staking")).toBeNull();
    expect(screen.queryByText("Pool TVL")).toBeNull();
    expect(screen.queryByText("Withdraw")).toBeNull();
  });

  it("keeps the stake row as it was", () => {
    render(<LpPositionsPanel loading={false} positions={[{ ...earn, kind: "stake", poolMode: 0, poolAddress: SLAB_B }]} totalRedeemable={251.5} error={null} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/stake");
    // #2871: the per-row "Insurance stake" line became "Insurance pool" under the "Stake" heading.
    expect(screen.getByText("Insurance pool")).toBeTruthy();
    expect(screen.getByText("Fee staking")).toBeTruthy();
    expect(screen.getByText("Pool TVL")).toBeTruthy();
  });
});
