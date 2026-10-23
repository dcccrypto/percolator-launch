/**
 * #3636 follow-up (ledger pr5-2026-10-22): on a v2.2 page with fee-only pools the intro says
 * V22_COPY.stake.closeOut.feeOnly ("earn nothing while the market runs"), but the fee split's Stakers row said the
 * insurance share is "paid into the stake pool automatically" and that stakers "take first loss". A FEE_ONLY pool is
 * paid nothing while the market runs and never deploys (percolator-stake v22 closeout: "FEE_ONLY pools never record a
 * backlog (they are paid nothing)", deploy target 0). The row now says so, at 0%. Legacy pools keep the old row.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const h = vi.hoisted(() => ({ fetch: vi.fn(), conn: null as unknown as { connection: Record<string, unknown> } }));
h.conn = { connection: { getAccountInfo: async () => null, getSlot: async () => 0, getTokenAccountBalance: async () => { throw new Error("n/a"); } } };

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: false, publicKey: null }), useConnectionCompat: () => h.conn }));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ vaultProgramId: STAKE_PROGRAM.toBase58() }) }));
vi.mock("@/hooks/useStakeDepositByPool", () => ({ useStakeDepositByPool: () => ({ deposit: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useStakeWithdrawByPool", () => ({ useStakeWithdrawByPool: () => ({ withdraw: vi.fn(), loading: false, error: null }) }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/wallet/ConnectWalletCta", () => ({ ConnectWalletCta: ({ label }: { label: string }) => <button>{label}</button> }));

import StakePage from "@/app/stake/page";
import { V22_COPY } from "@/lib/v22/copy";

const SLAB = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const pool = (stakeKind?: "fee-only" | "first-loss") => ({
  poolAddress: "pool-AAA", slabAddress: SLAB, collateralMint: "So11111111111111111111111111111111111111112", lpMint: SLAB, vault: SLAB,
  name: "AAA", symbol: "AAA", logoUrl: null, tvl: 500, tvlRaw: "500000000", poolValue: 500, apr: null,
  capTotal: 0, capTotalRaw: "0", capUsed: 500, capUsedRaw: "500000000", cooldownSlots: 0, totalLpSupply: 1_000_000_000, vaultBalance: 500,
  poolMode: 0, adminTransferred: false, ...(stakeKind ? { stakeKind } : {}), unclaimedValue: 0,
});

beforeEach(() => {
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setDevnetV22ForTest(null);
});

async function stakersRow(pools: unknown[]) {
  h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ pools }) });
  render(<StakePage />);
  await screen.findAllByText("AAA");
  fireEvent.click(screen.getByTestId("stake-fee-split-toggle"));
  const split = screen.getByTestId("stake-fee-split");
  const li = Array.from(split.querySelectorAll("li")).find((el) => el.textContent?.startsWith("Stakers"));
  return { split: split.textContent ?? "", row: li?.textContent ?? "" };
}

describe("fee-only Stakers row agrees with the close-out rule", () => {
  it("a v2.2 fee-only page: nothing while the market runs, 0%, no first loss", async () => {
    __setDevnetV22ForTest(true);
    const { split, row } = await stakersRow([pool("fee-only")]);
    expect(screen.getByTestId("stake-intro-feeonly").textContent).toBe(V22_COPY.stake.closeOut.feeOnly);
    expect(row).toContain(V22_COPY.stake.feeOnlyStakersRow);
    expect(row).toMatch(/0%$/);
    expect(row).not.toMatch(/paid into the stake pool|first loss/);
    // The insurance leg doesn't promise stakers its share either.
    expect(split).not.toMatch(/Stakers provide this fund and receive this share/);
  });

  it("a mixed page (fee-only + first-loss) keeps the paid-insurance-share row: first-loss stakers are paid", async () => {
    __setDevnetV22ForTest(true);
    const { row } = await stakersRow([pool("fee-only"), { ...pool("first-loss"), poolAddress: "pool-BBB" }]);
    expect(row).not.toContain(V22_COPY.stake.feeOnlyStakersRow);
    expect(row).not.toMatch(/0%$/);
  });

  it("CONTROL: legacy pools (no kind) keep the paid-insurance-share row", async () => {
    __setDevnetV22ForTest(true);
    const { row } = await stakersRow([pool()]);
    expect(row).toMatch(/the insurance share above, paid into the stake pool automatically/);
  });
});
