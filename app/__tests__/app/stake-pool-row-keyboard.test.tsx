/**
 * #38: each stake pool row was a role="button" div with the market's symbol link inside it. A
 * link inside role="button" is hidden from screen readers (its children are presentational), and
 * the row's Enter handler called preventDefault on the link's keydown, so Enter on the symbol
 * selected the pool instead of opening the chart. The figures are now one real button and the
 * link sits beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";

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

beforeEach(() => {
  h.connected = false;
  h.getAccountInfo.mockReset();
  h.getAccountInfo.mockResolvedValue(null);
  h.fetch.mockReset();
  h.fetch.mockResolvedValue(okResponse([apiPool(SLAB_OK, "AAA"), apiPool(SLAB_BAD, "BBB")]));
  vi.stubGlobal("fetch", h.fetch);
  Element.prototype.scrollIntoView = () => {}; // selecting a pool scrolls the rail into view; jsdom has none
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderRows() {
  render(<StakePage />);
  return screen.findByRole("link", { name: "BBB" });
}
const poolButton = (symbol: string) => screen.getByRole("button", { name: new RegExp(`Select ${symbol} pool`) });

describe("#38: stake pool rows", () => {
  it("the symbol link is not inside a button, so screen readers see it", async () => {
    const link = await renderRows();
    expect(link.closest('button, [role="button"]')).toBeNull();
  });

  it("Enter on the symbol link is left to the link and doesn't select the pool", async () => {
    const link = await renderRows();
    // fireEvent returns false when a handler called preventDefault, which blocked the navigation.
    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
    expect(poolButton("BBB").getAttribute("aria-pressed")).toBe("false");
  });

  it("the pool button selects the pool", async () => {
    await renderRows();
    fireEvent.click(poolButton("BBB"));
    expect(poolButton("BBB").getAttribute("aria-pressed")).toBe("true");
    expect(poolButton("AAA").getAttribute("aria-pressed")).toBe("false");
  });

  it("a click elsewhere on the row still selects it", async () => {
    const link = await renderRows();
    fireEvent.click(link.parentElement!);
    expect(poolButton("BBB").getAttribute("aria-pressed")).toBe("true");
  });
});
