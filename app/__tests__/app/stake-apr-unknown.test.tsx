/**
 * #25: stake APR isn't tracked (the API's fee history table was dropped), and the API sent 0, so
 * every pool read "0%" and the header "Avg APR 0%", next to copy saying stakers earn fee income.
 * The API now sends null (unknown) and the page shows "—".
 */
import { cleanup, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const WALLET = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SLAB_OK = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const LP_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
const h = vi.hoisted(() => ({
  getAccountInfo: vi.fn(),
  fetch: vi.fn(),
  conn: null as unknown as { connection: Record<string, unknown> },
}));
h.conn = {
  connection: {
    getAccountInfo: (...a: unknown[]) => h.getAccountInfo(...a),
    getSlot: async () => 0,
    getTokenAccountBalance: async () => { throw new Error("n/a"); },
  },
};

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ connected: true, publicKey: WALLET }),
  // Stable object: the page's effects depend on `connection` identity, as with the real hook.
  useConnectionCompat: () => h.conn,
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ vaultProgramId: STAKE_PROGRAM.toBase58() }) }));
vi.mock("@/hooks/useStakeDepositByPool", () => ({ useStakeDepositByPool: () => ({ deposit: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useStakeWithdrawByPool", () => ({ useStakeWithdrawByPool: () => ({ withdraw: vi.fn(async () => "withdrawSig11111"), loading: false, error: null }) }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/wallet/ConnectWalletCta", () => ({ ConnectWalletCta: ({ label }: { label: string }) => <button>{label}</button> }));

import StakePage from "@/app/stake/page";

function apiPool(slab: PublicKey, name: string) {
  return {
    poolAddress: `pool-${name}`,
    slabAddress: slab.toBase58(),
    collateralMint: MINT.toBase58(),
    lpMint: LP_MINT.toBase58(),
    vault: LP_MINT.toBase58(),
    name,
    symbol: name,
    logoUrl: null,
    tvl: 1000,
    tvlRaw: "1000000000",
    poolValue: 1000,
    apr: 0,
    capTotal: 0,
    capTotalRaw: "0",
    capUsed: 0,
    capUsedRaw: "0",
    cooldownSlots: 0,
    totalLpSupply: 1_000_000_000,
    vaultBalance: 1000,
    poolMode: 0,
    adminTransferred: false,
  };
}

const okResponse = (pools: unknown[]) => ({ ok: true, status: 200, json: async () => ({ pools }) });
beforeEach(() => {
  h.getAccountInfo.mockReset();
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const withApr = (pool: ReturnType<typeof apiPool>, apr: number | null) => ({ ...pool, apr });
const avgAprStat = () => screen.getByText("Avg APR").parentElement!.textContent;

describe("#25: an untracked APR is shown as unknown, not 0%", () => {
  it("shows — for the pool and the average when the API has no APR", async () => {
    h.fetch.mockResolvedValue(okResponse([withApr(apiPool(SLAB_OK, "AAA"), null)]));
    h.getAccountInfo.mockResolvedValue(null);
    render(<StakePage />);
    await screen.findAllByText("AAA");
    expect(avgAprStat()).toContain("—");
    expect(avgAprStat()).not.toContain("0%");
    expect(screen.getByTitle("Not tracked yet").textContent).toBe("—");
    expect(screen.queryByText(/fee income shown as APR/)).toBeNull();
  });

  it("CONTROL: a reported APR is still shown", async () => {
    h.fetch.mockResolvedValue(okResponse([withApr(apiPool(SLAB_OK, "AAA"), 12.34)]));
    h.getAccountInfo.mockResolvedValue(null);
    render(<StakePage />);
    await screen.findAllByText("AAA");
    expect(avgAprStat()).toContain("12.3%");
    expect(screen.getAllByText("12.3%").length).toBeGreaterThan(1); // row + header
  });
});
