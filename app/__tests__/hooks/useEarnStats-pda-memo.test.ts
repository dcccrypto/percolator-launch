// @vitest-environment node
/**
 * Differential: the memoised PDA path of fetchCuratedVaultsOnChain returns exactly what the uncached
 * path (direct SDK derivations) would, requests the same account keys in the same order, and a warm
 * poll does no findProgramAddressSync at all. Also bounds + invalid-input behaviour of lib/pda-memo.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveLpBackingLedger, deriveLpVaultRegistry } from "@percolatorct/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chunked: vi.fn(), domain: 0 }));

const PROGRAM = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ programId: PROGRAM }),
  getRpcEndpoint: () => "http://localhost:8899",
}));
vi.mock("@/lib/program-upgrade-detect", () => ({
  programUpgradeState: async () => "post",
  earnNavFloorLive: async () => true,
}));
vi.mock("@/lib/rpc-chunk", () => ({ getMultipleAccountsInfoChunked: mocks.chunked }));
vi.mock("@/lib/v22/records", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/records")>()),
  parseLpVaultRegistry: () => ({
    totalLpSharesOutstanding: 2_000_000_000n,
    feeDistributionTotalAtoms: 350_000n,
    redemptionCooldownSlots: 150n,
    domain: mocks.domain,
  }),
}));
vi.mock("@/lib/limits/decode", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/decode")>()),
  decodeLpVaultRegistryBound: () => false,
}));
vi.mock("@/lib/limits/earn-split-pot", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/earn-split-pot")>()),
  splitPotStateFromAccounts: () => null,
}));

import { fetchCuratedVaultsOnChain } from "@/hooks/useEarnStats";
import { splitPotLedgerKeys } from "@/lib/limits/earn-split-pot";
import {
  PDA_MEMO_MAX,
  _clearPdaMemo,
  _pdaMemoSizes,
  cachedLpBackingLedgerPda,
  cachedLpVaultRegistryPda,
  cachedPublicKey,
} from "@/lib/pda-memo";

const program = new PublicKey(PROGRAM);
const SLABS = Array.from({ length: 12 }, () => Keypair.generate().publicKey.toBase58());
const acct = { data: new Uint8Array(8), owner: PublicKey.default, lamports: 1, executable: false, rentEpoch: 0 };

describe("pda memo: differential vs the uncached derivations", () => {
  beforeEach(() => {
    _clearPdaMemo();
    mocks.chunked.mockReset().mockImplementation(async (_c: unknown, keys: unknown[]) => keys.map(() => acct));
    mocks.domain = 0;
  });

  it("requests exactly the uncached keys and returns identical data, cold and warm", async () => {
    const expectedRegistries = SLABS.map((s) => deriveLpVaultRegistry(program, new PublicKey(s))[0].toBase58());
    const expectedSplit = SLABS.flatMap((s) => {
      const m = new PublicKey(s);
      return [m, deriveLpBackingLedger(program, m, 0)[0], deriveLpBackingLedger(program, m, 1)[0]].map((k) => k.toBase58());
    });

    const cold = await fetchCuratedVaultsOnChain(SLABS);
    const spy = vi.spyOn(PublicKey, "findProgramAddressSync");
    const warm = await fetchCuratedVaultsOnChain(SLABS);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    expect(warm).toEqual(cold);
    expect(cold.ok).toBe(true);
    expect(Object.keys(cold.data)).toEqual(SLABS);
    // RPC call pattern unchanged: one registry read, then one market+2-ledger read.
    expect(mocks.chunked).toHaveBeenCalledTimes(4);
    for (const call of [0, 2]) {
      expect(mocks.chunked.mock.calls[call][1].map((k: PublicKey) => k.toBase58())).toEqual(expectedRegistries);
    }
    for (const call of [1, 3]) {
      expect(mocks.chunked.mock.calls[call][1].map((k: PublicKey) => k.toBase58())).toEqual(expectedSplit);
    }
  });

  it("matches the SDK for registry, ledger (both domains) and splitPotLedgerKeys", () => {
    for (const s of SLABS.slice(0, 4)) {
      const m = cachedPublicKey(s);
      expect(m.equals(new PublicKey(s))).toBe(true);
      expect(cachedLpVaultRegistryPda(program, m)).toEqual(deriveLpVaultRegistry(program, new PublicKey(s))[0]);
      for (const d of [0, 1, 2]) {
        expect(cachedLpBackingLedgerPda(program, m, d)).toEqual(deriveLpBackingLedger(program, m, d)[0]);
      }
    }
    // Different programs / domains never collide in the memo.
    const m = cachedPublicKey(SLABS[0]);
    expect(cachedLpBackingLedgerPda(program, m, 0).equals(cachedLpBackingLedgerPda(program, m, 1))).toBe(false);
    expect(cachedLpVaultRegistryPda(program, m).equals(cachedLpVaultRegistryPda(PublicKey.default, m))).toBe(false);
    const k = splitPotLedgerKeys(program, m, new Uint8Array(8));
    expect(k).toEqual({
      ownLedger: deriveLpBackingLedger(program, m, 0)[0],
      sibLedger: deriveLpBackingLedger(program, m, 1)[0],
    });
  });

  it("still throws on an invalid slab and does not cache it", () => {
    expect(() => cachedPublicKey("not-a-key")).toThrow();
    expect(_pdaMemoSizes().keys).toBe(0);
  });

  it("is bounded and evicts oldest first", () => {
    const key = (i: number) =>
      new PublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 255 : 0))).toBase58();
    for (let i = 0; i < PDA_MEMO_MAX + 50; i++) cachedPublicKey(key(i));
    expect(_pdaMemoSizes().keys).toBe(PDA_MEMO_MAX);
    // Oldest evicted (re-parsed as a fresh object), newest still the cached instance.
    const newest = cachedPublicKey(key(PDA_MEMO_MAX + 49));
    expect(cachedPublicKey(key(PDA_MEMO_MAX + 49))).toBe(newest);
    const oldest = cachedPublicKey(key(0));
    expect(oldest.toBase58()).toBe(key(0));
    expect(_pdaMemoSizes().keys).toBe(PDA_MEMO_MAX);
  });
});
