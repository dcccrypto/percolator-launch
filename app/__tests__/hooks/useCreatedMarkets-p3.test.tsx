/**
 * /my-markets and /trader/<wallet>: a completed P3 (vault-LP) launch has no creator-owned LP (useCreateMarket
 * `includeM2 = !params.p3`) and its marketauth is the stake pool PDA, so neither existing marker finds it; asset 0's
 * `asset_admin` (+1766 on v2.2, set to the creator by InitMarket) does. Real bytes: devnet market K6xMbo (P3, slot 518,690,419;
 * creator 2GxFkYSK... = fee payer of its creation tx) and CHILLHOUSE-T with its LP portfolio (owned by an off-curve vault-LP address; it exercises the LP marker). The
 * DiscoveredMarkets come from the app's own decoder (getMarketsByAddress), and the fake connection APPLIES the filters and the
 * dataSlice to those accounts, so a market is found only when the bytes on chain carry the marker.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { DiscoveredMarket } from "@percolatorct/sdk";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { readAssetAdmin } from "@/lib/v18-wire";
import { getMarketsByAddress } from "@/lib/v22/discovery";
import { useCreatedMarkets } from "@/hooks/useCreatedMarkets";
import { liftV22Portfolio } from "../helpers/portfolio-disc20";

const fx = (n: string): { owner: string; data: Uint8Array } => {
  const j = JSON.parse(readFileSync(path.join(__dirname, `../fixtures/v22-growth/${n}.json`), "utf8")) as { owner: string; data: string };
  return { owner: j.owner, data: liftV22Portfolio(new Uint8Array(Buffer.from(j.data, "base64"))) }; // recorded pre-#299 portfolios lifted to disc 20
};
const LP = fx("chillhouse-t.lp");
const MKT = fx("chillhouse-t.market");
const P3 = fx("k6xmbo-p3.market");
const PROGRAM = new PublicKey(P3.owner);
const SLAB = new PublicKey("56pWj8zYeZMv6oHHf4nwAfWAunzixxknaVNEFY48oJ2Y");
const P3_SLAB = new PublicKey("K6xMbo6GUNhhAf2Krrm6pUCiFj1qbdZPSnrXig1scHi");
const LP_OWNER = new PublicKey(LP.data.subarray(116, 148)); // owner of CHILLHOUSE-T's LP portfolio (off-curve)
const CREATOR = new PublicKey("2GxFkYSKrWayzGZFagk6LMdeyJ2tTACAXf255Fn9HWLa"); // K6xMbo's creator

type Filter = { dataSize?: number; memcmp?: { offset: number; bytes: string; encoding?: string } };
type Cfg = { filters?: Filter[]; dataSlice?: { offset: number; length: number } };
const ACCOUNTS: Array<{ pubkey: PublicKey; data: Uint8Array }> = [
  { pubkey: P3_SLAB, data: P3.data },
  { pubkey: SLAB, data: MKT.data },
  { pubkey: new PublicKey(new Uint8Array(32).fill(7)), data: LP.data },
];
const matches = (d: Uint8Array, f: Filter): boolean => {
  if (f.dataSize !== undefined) return d.length === f.dataSize;
  const m = f.memcmp!;
  const want = m.encoding === "base64" ? Buffer.from(m.bytes, "base64") : bs58.decode(m.bytes);
  return d.length >= m.offset + want.length && want.every((b, i) => d[m.offset + i] === b);
};
const acct = (data: Uint8Array) => ({ data: Buffer.from(data), owner: PROGRAM, lamports: 1, executable: false });
const conn = {
  getSlot: vi.fn(async () => 518_690_419),
  getProgramAccounts: vi.fn(async (_p: PublicKey, cfg: Cfg) =>
    ACCOUNTS.filter((a) => (cfg.filters ?? []).every((f) => matches(a.data, f))).map((a) => ({
      pubkey: a.pubkey,
      account: acct(cfg.dataSlice ? a.data.slice(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length) : a.data),
    })),
  ),
  getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map((k) => {
    const a = ACCOUNTS.find((x) => x.pubkey.equals(k));
    return a ? acct(a.data) : null;
  })),
};
const connectionResult = { connection: conn };
let wallet: PublicKey | null = CREATOR;
let markets: DiscoveredMarket[] = [];
const discovery = { markets, loading: false, error: null, refetch: vi.fn() };

vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: wallet, connected: !!wallet }),
  useConnectionCompat: () => connectionResult,
}));
vi.mock("@/hooks/useMarketDiscovery", () => ({ useMarketDiscovery: () => discovery }));
vi.mock("@/lib/tokenMeta", () => ({
  fetchTokenMeta: vi.fn().mockRejectedValue(new Error("no network in tests")),
  isPlaceholderTokenMeta: () => true,
}));

beforeEach(async () => {
  __setDevnetV22ForTest(true);
  markets = await getMarketsByAddress(conn as never, PROGRAM, [P3_SLAB, SLAB]);
  discovery.markets = markets;
  wallet = CREATOR;
  conn.getProgramAccounts.mockClear();
});
afterEach(() => __setDevnetV22ForTest(null));

const listed = async (): Promise<string[]> => {
  const { result } = renderHook(() => useCreatedMarkets());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBeNull();
  return result.current.myMarkets.map((m) => m.slabAddress.toBase58()).sort();
};

describe("useCreatedMarkets: a completed P3 (vault-LP) launch", () => {
  it("fixture: both markets decode; K6xMbo's marketauth is not its creator and no LP names it; asset_admin (+1766) is the creator", () => {
    expect(markets.map((m) => m.slabAddress.toBase58())).toEqual([P3_SLAB.toBase58(), SLAB.toBase58()]);
    const p3 = markets[0];
    expect(p3.configV17?.marketauth.equals(CREATOR)).toBe(false);
    expect(readAssetAdmin(P3.data, 0).equals(CREATOR)).toBe(true);
    expect(new PublicKey(P3.data.subarray(1766, 1798)).equals(CREATOR)).toBe(true);
    expect(new PublicKey(LP.data.subarray(16, 48)).equals(P3_SLAB)).toBe(false);
  });

  it("lists the P3 market for its creator (failed before: neither the marketauth nor the LP marker matches)", async () => {
    expect(await listed()).toEqual([P3_SLAB.toBase58()]);
  });

  it("the asset_admin scan is keys only, market kind, asset 0 at +1766, for the viewed wallet", async () => {
    await listed();
    const calls = conn.getProgramAccounts.mock.calls as unknown as Array<[PublicKey, Cfg]>;
    expect(calls).toHaveLength(3);
    const admin = calls.find(([, c]) => c.dataSlice?.length === 0)!;
    expect(admin[0].equals(PROGRAM)).toBe(true);
    expect(admin[1].filters).toEqual([
      { memcmp: { offset: 10, bytes: bs58.encode(Uint8Array.of(1)) } },
      { memcmp: { offset: 1766, bytes: CREATOR.toBase58() } },
    ]);
  });

  it("the LP marker still lists a market for its LP owner, and an unrelated wallet finds nothing", async () => {
    wallet = LP_OWNER;
    expect(await listed()).toEqual([SLAB.toBase58()]);
    wallet = new PublicKey(new Uint8Array(32).fill(9));
    expect(await listed()).toEqual([]);
  });

  it("a failed asset_admin scan is an error, never a confirmed list without the P3 market", async () => {
    const real = conn.getProgramAccounts.getMockImplementation()!;
    conn.getProgramAccounts.mockImplementation(async (p: PublicKey, cfg: Cfg) => {
      if (cfg.dataSlice?.length === 0) throw new Error("asset_admin scan failed");
      return real(p, cfg);
    });
    try {
      const { result } = renderHook(() => useCreatedMarkets());
      await waitFor(() => expect(result.current.error).toMatch(/Unable to verify created markets: asset_admin scan failed/));
      expect(result.current.myMarkets).toEqual([]);
    } finally {
      conn.getProgramAccounts.mockImplementation(real);
    }
  });
});
