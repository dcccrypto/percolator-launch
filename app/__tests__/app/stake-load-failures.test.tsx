/**
 * #2706: /stake rendered two failures as confident empty states.
 *   1. A failed /api/stake/pools fetch showed "No insurance pools available yet" with no retry.
 *   2. fetchPoolPosition swallowed every error into `null`, so a per-pool RPC failure rendered as
 *      "no stake in that pool": the position (and its withdraw row) vanished and the header
 *      under-reported the wallet's deposits.
 *
 * Renders the real StakePage (real fetchPoolPosition, real decodeStakePoolV1 / SPL unpack); only the
 * wallet, RPC connection, config, tx hooks and fetch are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  useWalletCompat: () => ({ connected: h.connected, publicKey: h.connected ? WALLET : null }),
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
vi.mock("@/hooks/useStakeWithdrawByPool", () => ({ useStakeWithdrawByPool: () => ({ withdraw: vi.fn(), loading: false, error: null }) }));
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
const failResponse = () => ({ ok: false, status: 500, json: async () => ({ error: "Failed to fetch stake pools", pools: [] }) });

/** 352-byte StakePool V1 with lpMint at offset 104 (decodeStakePoolV1 layout). */
function poolAccountData(): Buffer {
  const d = Buffer.alloc(352);
  d[0] = 1;
  LP_MINT.toBuffer().copy(d, 104);
  return d;
}
function lpTokenAccountData(amount: bigint): Buffer {
  // SPL token Account layout written by hand (AccountLayout.encode trips jsdom's realm-split
  // Uint8Array check): mint 0..32, owner 32..64, amount u64 @64, state u8 @108 (1 = initialized).
  const d = Buffer.alloc(ACCOUNT_SIZE);
  LP_MINT.toBuffer().copy(d, 0);
  WALLET.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1;
  return d;
}

const poolPdaOk = POOL_PDA_OK;
const poolPdaBad = POOL_PDA_BAD;
const lpAta = LP_ATA;

beforeEach(() => {
  h.connected = true;
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

describe("#2706: a failed pools fetch is a failure, not an empty protocol", () => {
  it("shows an error with a retry instead of 'No insurance pools available yet', and retry recovers", async () => {
    h.fetch.mockResolvedValueOnce(failResponse()).mockResolvedValue(okResponse([apiPool(SLAB_OK, "AAA")]));
    h.getAccountInfo.mockResolvedValue(null);

    render(<StakePage />);
    const err = await screen.findByTestId("stake-pools-error");
    expect(err.textContent).toMatch(/Couldn.t load insurance pools/);
    expect(screen.queryByText(/No insurance pools available yet/)).toBeNull();
    // The positions panel must not claim "No open positions" when no pool could be checked.
    expect(screen.queryByText(/No open positions/)).toBeNull();
    expect(screen.getByTestId("stake-positions-error").textContent).toMatch(/Couldn.t load your positions/);

    fireEvent.click(err.querySelector("button")!);
    await waitFor(() => expect(screen.queryByTestId("stake-pools-error")).toBeNull());
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect((await screen.findAllByText("AAA")).length).toBeGreaterThan(0);
    // Pool read OK, wallet holds nothing -> confirmed empty is still rendered as empty.
    expect(await screen.findByText(/No open positions/)).toBeTruthy();
  });

  it("a genuinely empty pool list still renders the true-empty state", async () => {
    h.fetch.mockResolvedValue(okResponse([]));
    render(<StakePage />);
    expect(await screen.findByText(/No insurance pools available yet/)).toBeTruthy();
    expect(screen.queryByTestId("stake-pools-error")).toBeNull();
  });
});

describe("#2706: a per-pool RPC failure is surfaced, never rendered as 'no position'", () => {
  it("keeps the readable pool's position, flags the unreadable pool, and marks the total unknown", async () => {
    h.fetch.mockResolvedValue(okResponse([apiPool(SLAB_OK, "AAA"), apiPool(SLAB_BAD, "BBB")]));
    h.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
      if (pk.equals(poolPdaBad)) throw new Error("429 Too Many Requests");
      if (pk.equals(poolPdaOk)) return { data: poolAccountData(), owner: STAKE_PROGRAM, lamports: 1, executable: false };
      if (pk.equals(lpAta)) return { data: lpTokenAccountData(5_000_000n), owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
      return null;
    });

    render(<StakePage />);
    const alert = await screen.findByTestId("stake-positions-error");
    expect(alert.textContent).toMatch(/Couldn.t read your position in 1 pool\./);
    expect(alert.getAttribute("role")).toBe("alert");
    // The readable pool's position is still listed (allSettled keeps the rest).
    expect(screen.getByText("Manage / Withdraw Partial")).toBeTruthy();
    // Header must not present a partial sum as the wallet's deposits.
    const depositsLabel = screen.getByText("Your Deposits");
    expect(depositsLabel.parentElement!.textContent).toContain("…");

    // Retry re-scans; once the RPC recovers the alert clears.
    h.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
      if (pk.equals(poolPdaOk)) return { data: poolAccountData(), owner: STAKE_PROGRAM, lamports: 1, executable: false };
      if (pk.equals(lpAta)) return { data: lpTokenAccountData(5_000_000n), owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
      return null;
    });
    fireEvent.click(alert.querySelector("button")!);
    await waitFor(() => expect(screen.queryByTestId("stake-positions-error")).toBeNull());
  });

  it("an RPC failure on the only pool does not say 'No open positions'", async () => {
    h.fetch.mockResolvedValue(okResponse([apiPool(SLAB_BAD, "BBB")]));
    h.getAccountInfo.mockRejectedValue(new Error("fetch failed"));

    render(<StakePage />);
    expect(await screen.findByTestId("stake-positions-error")).toBeTruthy();
    expect(screen.queryByText(/No open positions/)).toBeNull();
  });

  it("confirmed no-balance (no pool account / no LP ATA) is still an empty state, not an error", async () => {
    h.fetch.mockResolvedValue(okResponse([apiPool(SLAB_OK, "AAA"), apiPool(SLAB_BAD, "BBB")]));
    h.getAccountInfo.mockImplementation(async (pk: PublicKey) =>
      pk.equals(poolPdaOk) ? { data: poolAccountData(), owner: STAKE_PROGRAM, lamports: 1, executable: false } : null,
    );

    render(<StakePage />);
    expect(await screen.findByText(/No open positions/)).toBeTruthy();
    // Let the scan settle, then confirm no failure banner appeared.
    await waitFor(() => expect(h.getAccountInfo).toHaveBeenCalled());
    expect(screen.queryByTestId("stake-positions-error")).toBeNull();
  });
});
