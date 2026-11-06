/**
 * useCreatedMarkets: a completed P3 (vault-LP) launch has no creator-owned LP portfolio (useCreateMarket
 * `includeM2 = !params.p3`) and its marketauth is the stake-pool PDA, so neither existing marker names the creator.
 * VaultLpState.junior_owner does: InitVaultLp sets it to the launching marketauth and no instruction moves it, so it
 * also survives an admin-key burn (asset_admin zeroed).
 * The fake connection APPLIES the filters (dataSize, memcmp in base58 or base64) and the dataSlice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { HEADER_KIND_OFF, KIND_VAULT_LP_STATE, VAULT_LP_STATE_ACCOUNT_LEN, VS } from "@/lib/limits/constants";

const h = vi.hoisted(() => ({ conn: null as unknown, markets: [] as unknown[] }));
vi.mock("@/hooks/useWalletCompat", () => ({
  useWalletCompat: () => ({ publicKey: null }),
  useConnectionCompat: () => ({ connection: h.conn }),
}));
vi.mock("@/hooks/useMarketDiscovery", () => ({
  useMarketDiscovery: () => ({ markets: h.markets, loading: false, error: null, refetch: async () => undefined }),
}));
vi.mock("@/lib/tokenMeta", () => ({ fetchTokenMeta: async () => ({ symbol: "T", name: "T" }), isPlaceholderTokenMeta: () => false }));

import { useCreatedMarkets } from "@/hooks/useCreatedMarkets";

const PROGRAM = PublicKey.unique();
const CREATOR = PublicKey.unique();
const P3_MARKET = PublicKey.unique();
const OTHER_P3_MARKET = PublicKey.unique();

function vaultLpState(market: PublicKey, juniorOwner: PublicKey): Uint8Array {
  const d = new Uint8Array(VAULT_LP_STATE_ACCOUNT_LEN);
  d[HEADER_KIND_OFF] = KIND_VAULT_LP_STATE;
  d.set(market.toBytes(), VS.marketGroup);
  d.set(juniorOwner.toBytes(), VS.juniorOwner);
  return d;
}
const ACCOUNTS = [
  { pubkey: PublicKey.unique(), data: vaultLpState(P3_MARKET, CREATOR) },
  { pubkey: PublicKey.unique(), data: vaultLpState(OTHER_P3_MARKET, PublicKey.unique()) },
];
type Filter = { dataSize?: number; memcmp?: { offset: number; bytes: string; encoding?: string } };
const matches = (d: Uint8Array, f: Filter): boolean => {
  if (f.dataSize !== undefined) return d.length === f.dataSize;
  const m = f.memcmp!;
  const want = m.encoding === "base64" ? new Uint8Array(Buffer.from(m.bytes, "base64")) : bs58.decode(m.bytes);
  return d.length >= m.offset + want.length && want.every((b, i) => d[m.offset + i] === b);
};
function fakeConnection(fail = false) {
  return {
    rpcEndpoint: "fake",
    getProgramAccounts: vi.fn(async (_p: PublicKey, cfg: { filters: Filter[]; dataSlice?: { offset: number; length: number } }) => {
      if (fail && cfg.dataSlice?.length === 32) throw new Error("429");
      return ACCOUNTS.filter((a) => cfg.filters.every((f) => matches(a.data, f))).map((a) => ({
        pubkey: a.pubkey,
        account: { data: Buffer.from(cfg.dataSlice ? a.data.slice(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length) : a.data), owner: PROGRAM, lamports: 1, executable: false },
      }));
    }),
    getSlot: vi.fn(async () => 1),
    getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[]) => ks.map(() => null)),
  };
}
// Discovery's v2.2 shape (lib/v22/sdk/discovery.ts): a completed launch's marketauth is the stake-pool PDA, not the creator.
const market = (slab: PublicKey) => ({ slabAddress: slab, programId: PROGRAM, header: {}, config: {}, engine: {}, params: {}, configV17: { marketauth: PublicKey.unique() } });

afterEach(() => {
  h.markets = [];
});

describe("useCreatedMarkets: completed P3 launches", () => {
  it("lists a completed P3 market for its junior owner (failed before: no LP marker, marketauth is the pool)", async () => {
    h.conn = fakeConnection();
    h.markets = [market(P3_MARKET), market(OTHER_P3_MARKET)];
    const { result } = renderHook(() => useCreatedMarkets(CREATOR.toBase58()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.myMarkets.map((m) => m.slabAddress.toBase58())).toEqual([P3_MARKET.toBase58()]);
  });

  it("scans VaultLpState by junior_owner, market id only", async () => {
    const conn = fakeConnection();
    h.conn = conn;
    h.markets = [market(P3_MARKET)];
    const { result } = renderHook(() => useCreatedMarkets(CREATOR.toBase58()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const juniorCall = conn.getProgramAccounts.mock.calls.find(([, cfg]) => cfg.dataSlice?.length === 32);
    expect(juniorCall?.[1]).toEqual({
      dataSlice: { offset: 16, length: 32 },
      filters: [
        { dataSize: 272 },
        { memcmp: { offset: 10, bytes: bs58.encode(Uint8Array.of(9)) } },
        { memcmp: { offset: 112, bytes: CREATOR.toBase58() } },
      ],
    });
  });

  it("a wallet that is no junior owner gets nothing from the P3 marker", async () => {
    h.conn = fakeConnection();
    h.markets = [market(P3_MARKET), market(OTHER_P3_MARKET)];
    const stranger = PublicKey.unique().toBase58();
    const { result } = renderHook(() => useCreatedMarkets(stranger));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.myMarkets).toEqual([]);
  });

  it("a failed junior scan is an error, never a confirmed-empty list", async () => {
    h.conn = fakeConnection(true);
    h.markets = [market(P3_MARKET)];
    const { result } = renderHook(() => useCreatedMarkets(CREATOR.toBase58()));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/Unable to verify created markets: 429/);
    expect(result.current.myMarkets).toEqual([]);
  });
});
