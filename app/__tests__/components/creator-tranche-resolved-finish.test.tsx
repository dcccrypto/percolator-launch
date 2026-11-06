/**
 * On a Resolved P3 market the creator-stake panel offers the market's remaining steps ("Finish now", useResolvedExit) when
 * this wallet can run them, instead of only "available about 24 h from now"; `caps={false}` drops the "Risk & caps" rows.
 * The data hooks are mocked; the panel's own wiring (CreatorTranchePanelLive) is what runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { __setLimitsFlagsForTest } from "@/lib/limits/flags";
import { COPY } from "@/lib/limits/copy";
import { ALL_ON } from "../lib/limits/fixtures";

const W = new PublicKey("11111111111111111111111111111112");
const h = vi.hoisted(() => ({
  exit: {} as Record<string, unknown>,
  finish: vi.fn(async () => null),
}));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ publicKey: W }), useConnectionCompat: () => ({ connection: {} }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ assetProfile: null, raw: null, config: null }) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useInsuranceLP", () => ({ useInsuranceLP: () => ({ state: { backingNavAtoms: 0n } }) }));
vi.mock("@/hooks/useVaultLpValuation", () => ({ useVaultLpValuation: () => ({ value: null }) }));
vi.mock("@/hooks/useJuniorTranche", () => ({ useJuniorTranche: () => ({ busy: false, error: null, refused75: false, deposit: vi.fn(), withdraw: vi.fn(), releaseResolved: vi.fn() }) }));
vi.mock("@/lib/limits/earn", () => ({ earnViewFromLimits: () => null }));
vi.mock("@/hooks/useMarketLimits", () => ({
  useMarketLimits: () => ({
    state: "ok",
    flags: ALL_ON,
    engine: { mode: 1 },
    lp: null,
    riskLimits: null,
    matcher: null,
    vaultState: { juniorOwner: W.toBytes(), assetIndex: 0, seniorClaimAtoms: 0n, juniorFloorBps: 1_000, seniorDrawOutstandingAtoms: 0n, juniorDepositedAtoms: 0n, juniorWithdrawnAtoms: 0n },
  }),
}));
vi.mock("@/hooks/useResolvedExit", () => ({ useResolvedExit: () => ({ ...h.exit, finish: h.finish }) }));

import { CreatorTranchePanel } from "@/components/limits/CreatorLimits";

const ownerWindow = { phase: "owner-window" as const, untilSlot: 216_100n, steps: [{ kind: "settle-vault-lp" as const, topup: 0 as const, portfolio: "V" }], blockers: [] };

beforeEach(() => {
  __setLimitsFlagsForTest(ALL_ON);
  h.finish.mockClear();
  h.exit = { plan: ownerWindow, nowSlot: 100n, estimate: { steps: 2, sol: "0.0001" }, running: false, error: null };
});
afterEach(() => {
  cleanup();
  __setLimitsFlagsForTest(null);
});

describe("the creator stake on a Resolved market", () => {
  it("steps this wallet can run now (the junior owner's 101 in the owner window): 'Finish now' runs useResolvedExit.finish", () => {
    const r = render(<CreatorTranchePanel slab="S" decimals={6} collateralSymbol="USDC" />);
    expect(r.getByTestId("limits-junior-finish-explain").textContent).toBe(COPY.resolvedExit.finishNow(2, "0.0001"));
    fireEvent.click(r.getByTestId("limits-junior-finish"));
    expect(h.finish).toHaveBeenCalledTimes(1);
  });
  it("CONTROL nothing this wallet can run (no estimate): no finish, the waiting line only", () => {
    h.exit = { ...h.exit, estimate: null };
    const r = render(<CreatorTranchePanel slab="S" decimals={6} collateralSymbol="USDC" />);
    expect(r.queryByTestId("limits-junior-finish")).toBeNull();
    expect(r.getByTestId("limits-junior-resolved-surplus")).toBeTruthy();
  });
  it("CONTROL: a trader only its owner can close keeps the market open until the window ends: no Finish, the wait line", () => {
    h.exit = { ...h.exit, plan: { ...ownerWindow, ownersPending: 1 } };
    const r = render(<CreatorTranchePanel slab="S" decimals={6} collateralSymbol="USDC" />);
    expect(r.queryByTestId("limits-junior-finish")).toBeNull();
    expect(r.getByTestId("limits-junior-resolved-surplus").textContent).toMatch(/^Available once the market's final payouts finish/);
  });
  it("caps={false}: the stake only; by default the 'Risk & caps' card stays", () => {
    const off = render(<CreatorTranchePanel slab="S" decimals={6} collateralSymbol="USDC" caps={false} />);
    expect(off.getByTestId("limits-junior-actions")).toBeTruthy();
    expect(off.queryByTestId("limits-creator-tranche")).toBeNull();
    off.unmount();
    const on = render(<CreatorTranchePanel slab="S" decimals={6} collateralSymbol="USDC" />);
    expect(on.getByTestId("limits-creator-tranche")).toBeTruthy();
  });
});
