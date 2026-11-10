/**
 * Council r4 N5: on v2.2, a failed pools read made /stake fall back to the legacy v1 intro ("Stake into a market's pool
 * to receive a share of that market's trading fees ... This has not happened so far."). It must show an error with a
 * retry instead, and never the v1 intro, while loading, empty, or failed. Renders the real StakePage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const STAKE_PROGRAM = new PublicKey("Stake11111111111111111111111111111111111111");
const WALLET = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const SLAB_OK = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const SLAB_BAD = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const LP_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
// PDA/ATA addresses: findProgramAddressSync can't run under jsdom's realm-split Uint8Array (see
// __tests__/setup.ts), so the derivations are stubbed to fixed, distinct addresses. Everything that
// reads those accounts (fetchPoolPosition, decodeStakePoolV1, unpackAccount) is the real code.
const POOL_PDA_OK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const POOL_PDA_BAD = new PublicKey("SysvarRent111111111111111111111111111111111");
const LP_ATA = new PublicKey("SysvarRecentB1ockHashes11111111111111111111");

const h = vi.hoisted(() => ({
  connected: true,
  /** The connected wallet when set; WALLET otherwise. */
  wallet: null as unknown as PublicKey | null,
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
  useWalletCompat: () => ({ connected: h.connected, publicKey: h.connected ? (h.wallet ?? WALLET) : null }),
  // Stable object: the page's effects depend on `connection` identity, as with the real hook.
  useConnectionCompat: () => h.conn,
}));
vi.mock("@percolatorct/sdk", async (orig) => ({
  ...(await orig<typeof import("@percolatorct/sdk")>()),
  deriveStakePool: (slab: PublicKey) => [slab.equals(SLAB_OK) ? POOL_PDA_OK : POOL_PDA_BAD, 255],
  deriveDepositPda: () => [PublicKey.default, 255],
}));
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: (mint: PublicKey) => (mint.equals(LP_MINT) ? LP_ATA : PublicKey.default),
  // spl-token's buffer-layout decode also fails jsdom's realm-split `instanceof Uint8Array`;
  // read the one field the page uses (amount, u64 LE @64) directly, and keep the real
  // "throws on a non-token account" contract for anything that isn't 165 bytes.
  unpackAccount: (address: PublicKey, info: { data: Buffer }) => {
    if (!info || info.data.length !== 165) throw new Error("TokenInvalidAccountSizeError");
    return { address, amount: Buffer.from(info.data).readBigUInt64LE(64) };
  },
}));
vi.mock("@/lib/config", () => ({ getConfig: () => ({ vaultProgramId: STAKE_PROGRAM.toBase58() }) }));
vi.mock("@/hooks/useStakeDepositByPool", () => ({ useStakeDepositByPool: () => ({ deposit: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useStakeWithdrawByPool", () => ({ useStakeWithdrawByPool: () => ({ withdraw: vi.fn(async () => "withdrawSig11111"), loading: false, error: null }) }));
vi.mock("@/components/market/MarketLogo", () => ({ MarketLogo: () => null }));
vi.mock("@/components/wallet/ConnectWalletCta", () => ({ ConnectWalletCta: ({ label }: { label: string }) => <button>{label}</button> }));

import StakePage from "@/app/stake/page";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

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
const failResponse = () => ({ ok: false, status: 500, json: async () => ({ error: "Failed to fetch stake pools", pools: [] }) });



beforeEach(() => {
  h.connected = true;
  h.wallet = null;
  h.getAccountInfo.mockReset();
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  __setDevnetV22ForTest(true);
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("N5: /stake on v2.2 when the pools read fails", () => {
  it("shows an error with retry in the header, never the legacy v1 intro; retry recovers", async () => {
    h.fetch.mockResolvedValueOnce(failResponse()).mockResolvedValue(okResponse([]));
    h.getAccountInfo.mockRejectedValue(new Error("fetch failed"));
    render(<StakePage />);
    const err = await screen.findByTestId("stake-intro-error");
    expect(err.textContent).toMatch(/Couldn.t load the staking pools/);
    expect(screen.queryByTestId("stake-intro-legacy")).toBeNull();
    expect(screen.queryByTestId("stake-loss-line")).toBeNull();
    fireEvent.click(err.querySelector("button")!);
    await waitFor(() => expect(screen.queryByTestId("stake-intro-error")).toBeNull());
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("stake-intro-legacy")).toBeNull();
  });

  it("while the pools are still loading there is no v1 intro either", () => {
    h.fetch.mockReturnValue(new Promise(() => {}));
    render(<StakePage />);
    expect(screen.queryByTestId("stake-intro-legacy")).toBeNull();
  });

  it("CONTROL: v2.2 off keeps the legacy intro (v1 deployment unchanged)", async () => {
    __setDevnetV22ForTest(false);
    h.fetch.mockResolvedValue(failResponse());
    render(<StakePage />);
    expect(await screen.findByTestId("stake-intro-legacy")).toBeTruthy();
  });
});
