/**
 * Staked position must be valued from FRESH on-chain pool + vault, not the CDN-cached
 * /api/stake/pools snapshot (which predates a first deposit: supply 0, tvl 0 -> "$0.00").
 * Accounts are shaped like the real ones for wallet 9sM73A..., pool 8WC8vALs....
 */
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wallet = new PublicKey("9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa");
const mocks = vi.hoisted(() => ({ connection: {} as Record<string, unknown>, wallet: null as unknown }));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: () => ({ connection: mocks.connection }),
  useWalletCompat: () => ({ publicKey: mocks.wallet ?? wallet }),
}));
// spl-token's layout decoders and PDA derivation reject jsdom-realm buffers, so the three helpers
// the hook uses are replaced by byte-offset reads of the same layout; this is the real ATA
// (read on chain) of wallet 9sM73A... for lp mint DHUcri....
const REAL_ATA = "5gVwohxiXx3MBfQZUWK2xtsGq2sTMphG3SGxT61MEimW";
vi.mock("@solana/spl-token", async (orig) => ({
  ...(await orig<typeof import("@solana/spl-token")>()),
  getAssociatedTokenAddressSync: () => new PublicKey(REAL_ATA),
  unpackAccount: (_k: PublicKey, info: { data: Buffer }) => ({ amount: info.data.readBigUInt64LE(64) }),
  unpackMint: (_k: PublicKey, info: { data: Buffer }) => ({ decimals: info.data[44] }),
}));
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => {} }));

import { useLpPositions } from "@/hooks/useLpPositions";

const pool = new PublicKey("5hFefu1F6Y41b8JwFvSo7jeYni5Vo56FZ8hZL1bpvYnJ");
const lpMint = new PublicKey("DHUcriBp5UGBVqCKaUgq6zfZga4Y7ZtHrMb7QNYJBueU");
const vault = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const collateral = new PublicKey("SysvarRent111111111111111111111111111111111");
const slab = new PublicKey("8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx");
const LP = 399_999_000n;

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint) {
  // spl-token Account layout: mint@0, owner@32, amount@64 (u64 LE), state@108 (1 = initialized).
  const data = Buffer.alloc(165);
  data.set(mint.toBytes(), 0);
  data.set(owner.toBytes(), 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1, data, rentEpoch: 0 };
}
function mintAccount(decimals: number) {
  const data = Buffer.alloc(82);
  data[44] = decimals;
  data[45] = 1;
  return { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1, data, rentEpoch: 0 };
}
function poolAccount(totalLpSupply: bigint) {
  const data = Buffer.alloc(408);
  data.writeBigUInt64LE(totalLpSupply, 176);
  return { executable: false, owner: PublicKey.default, lamports: 1, data, rentEpoch: 0 };
}

describe("useLpPositions valuation freshness", () => {
  beforeEach(() => {
    mocks.wallet = wallet;
    const ata = new PublicKey(REAL_ATA);
    const accounts = new Map<string, unknown>([
      [lpMint.toBase58(), mintAccount(6)],
      [collateral.toBase58(), mintAccount(6)],
      [ata.toBase58(), tokenAccount(lpMint, wallet, LP)],
      [pool.toBase58(), poolAccount(400_000_000n)],
      [vault.toBase58(), tokenAccount(collateral, pool, 400_000_000n)],
    ]);
    mocks.connection.getSlot = vi.fn(async () => 1);
    mocks.connection.getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null));
    // Cached API snapshot from BEFORE the deposit: empty pool.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/markets") ? ({ ok: true, json: async () => ({ markets: [] }) }) : ({
      ok: true,
      json: async () => ({ pools: [{
        poolAddress: pool.toBase58(), slabAddress: slab.toBase58(), collateralMint: collateral.toBase58(),
        lpMint: lpMint.toBase58(), vault: vault.toBase58(), name: "T", symbol: "T", logoUrl: null,
        tvl: 0, tvlRaw: "0", totalLpSupply: 0, cooldownSlots: 0, apr: 0, poolMode: 0,
      }] }),
    })));
  });

  it("shows the staked amount and counts it in the total despite a stale API snapshot", async () => {
    const { result } = renderHook(() => useLpPositions());
    await waitFor(() => expect((mocks.connection.getMultipleAccountsInfo as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0)); await waitFor(() => expect(result.current.loading).toBe(false)); await new Promise((r) => setTimeout(r, 50));
    expect(result.current.error).toBeNull(); expect(result.current.positions).toHaveLength(1);
    expect(result.current.positions[0].redeemable).toBeCloseTo(399.999, 3);
    expect(result.current.totalRedeemable).toBeCloseTo(399.999, 3);
  });

  // S25: the wallet-change effect re-fetched but kept the previous wallet's rows and total, and a failed
  // read only sets `error`, so a new wallet whose first read failed showed the old wallet's LP Value.
  it("S25: drops the previous wallet's rows and total; a failed first read leaves nothing to show", async () => {
    const { result, rerender } = renderHook(() => useLpPositions());
    await waitFor(() => expect(result.current.totalRedeemable).toBeGreaterThan(0));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("rate limited"); }));
    mocks.wallet = new PublicKey("DrrDGxiojUPHnLZaNw7DN6JYoEKKqu3bG4PmNjv8P1yG");
    rerender();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.positions).toHaveLength(0);
    expect(result.current.totalRedeemable).toBe(0);
  });
});
