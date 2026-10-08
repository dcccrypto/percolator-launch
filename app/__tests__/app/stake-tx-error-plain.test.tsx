/**
 * #26: a failed Stake withdraw/deposit showed `e.message` verbatim, i.e. the wallet's raw
 * "Transaction simulation failed ... custom program error ... Logs: [...]" text. The page and both
 * hooks now go through the shared resolver (surface "stake").
 */
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
  withdraw: vi.fn(),
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
vi.mock("@/hooks/useStakeWithdrawByPool", () => ({ useStakeWithdrawByPool: () => ({ withdraw: h.withdraw, loading: false, error: null }) }));
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
  h.wallet = null;
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

const RAW_SIM =
  'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x15. ' +
  'Logs: ["Program Stake11111111111111111111111111111111111111 invoke [1]", "Program log: Error: EngineLockActive", ' +
  '"Program Stake11111111111111111111111111111111111111 failed: custom program error: 0x15"]';

describe("#26: a failed Stake withdraw shows a plain line", () => {
  it("never shows the raw simulation text or program logs", async () => {
    h.fetch.mockResolvedValue(okResponse([apiPool(SLAB_OK, "AAA")]));
    h.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
      if (pk.equals(poolPdaOk)) return { data: poolAccountData(), owner: STAKE_PROGRAM, lamports: 1, executable: false };
      if (pk.equals(lpAta)) return { data: lpTokenAccountData(5_000_000n), owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
      return null;
    });
    h.withdraw.mockRejectedValue(new Error(RAW_SIM));

    render(<StakePage />);
    const btn = await screen.findByText(/Withdraw All/);
    await act(async () => { fireEvent.click(btn); });
    const err = await screen.findByTestId("stake-error");
    expect(err.textContent).toBeTruthy();
    expect(err.textContent).not.toMatch(/simulation|Program|0x15|Logs|custom program error/i);
  });

  it("a confirmation timeout says to check, not that it will update (nothing on /stake watches)", async () => {
    h.fetch.mockResolvedValue(okResponse([apiPool(SLAB_OK, "AAA")]));
    h.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
      if (pk.equals(poolPdaOk)) return { data: poolAccountData(), owner: STAKE_PROGRAM, lamports: 1, executable: false };
      if (pk.equals(lpAta)) return { data: lpTokenAccountData(5_000_000n), owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
      return null;
    });
    h.withdraw.mockRejectedValue(new Error("Confirmation timeout (90s) — tx may still land. Check explorer: 5abc"));

    render(<StakePage />);
    const btn = await screen.findByText(/Withdraw All/);
    await act(async () => { fireEvent.click(btn); });
    const text = (await screen.findByTestId("stake-error")).textContent;
    expect(text).toBe("Still confirming. It may still land, so check your balance before trying again.");
    expect(text).not.toMatch(/We.ll update this/);
  });

  it("keeps an app message that is already plain", async () => {
    h.fetch.mockResolvedValue(okResponse([apiPool(SLAB_OK, "AAA")]));
    h.getAccountInfo.mockImplementation(async (pk: PublicKey) => {
      if (pk.equals(poolPdaOk)) return { data: poolAccountData(), owner: STAKE_PROGRAM, lamports: 1, executable: false };
      if (pk.equals(lpAta)) return { data: lpTokenAccountData(5_000_000n), owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
      return null;
    });
    h.withdraw.mockRejectedValue(new Error("Stake pool not initialized for this market."));

    render(<StakePage />);
    const btn = await screen.findByText(/Withdraw All/);
    await act(async () => { fireEvent.click(btn); });
    expect((await screen.findByTestId("stake-error")).textContent).toBe("Stake pool not initialized for this market.");
  });
});
