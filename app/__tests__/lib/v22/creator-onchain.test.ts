// @vitest-environment node
/**
 * #3637: the creator's own markets found on chain, with no registry. Real LP portfolio + market bytes (CHILLHOUSE-T). The fake
 * connection checks the exact filters sent (offsets: percolator-prog aca02ba6: portfolio market id +16, owner +116, market kind
 * byte +10 = 1, marketauth +16) and that the RPC budget holds.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import {
  MAX_CREATION_LOOKUPS,
  __clearCreationSlotCache,
  findCreationSlot,
  findCreatorSlabKeys,
  lookupCreatorMarkets,
  readCreatorSlabs,
} from "@/lib/v22/creator-onchain";

const fx = (n: string): { owner: string; data: Uint8Array } => {
  const j = JSON.parse(readFileSync(path.join(__dirname, `../../fixtures/v22-growth/${n}.json`), "utf8")) as { owner: string; data: string };
  return { owner: j.owner, data: new Uint8Array(Buffer.from(j.data, "base64")) };
};
const LP = fx("chillhouse-t.lp");
const MKT = fx("chillhouse-t.market");
const PROGRAM = new PublicKey(LP.owner);
const SLAB = new PublicKey("56pWj8zYeZMv6oHHf4nwAfWAunzixxknaVNEFY48oJ2Y");
const WALLET = new PublicKey(LP.data.subarray(116, 148));

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __clearCreationSlotCache();
});
afterEach(() => __setDevnetV22ForTest(null));

const acct = (data: Uint8Array) => ({ data: Buffer.from(data), owner: PROGRAM, lamports: 1, executable: false });

describe("fixture sanity (the offsets are real)", () => {
  it("the LP portfolio carries the market id at +16 and the creator at +116", () => {
    expect(new PublicKey(LP.data.subarray(16, 48)).toBase58()).toBe(SLAB.toBase58());
    expect(LP.data[10]).toBe(2);
    expect(MKT.data[10]).toBe(1);
  });
});

describe("findCreatorSlabKeys", () => {
  it("one owner-scoped portfolio scan + one keys-only marketauth scan; the LP's market id is the creator marker", async () => {
    const getProgramAccounts = vi.fn(async (_p: PublicKey, cfg?: { filters?: unknown[]; dataSlice?: unknown }) =>
      cfg?.dataSlice ? [] : [{ pubkey: new PublicKey("11111111111111111111111111111112"), account: acct(LP.data) }],
    );
    const keys = await findCreatorSlabKeys({ getProgramAccounts } as never, PROGRAM, WALLET);
    expect(keys.map((k) => k.toBase58())).toEqual([SLAB.toBase58()]);
    expect(getProgramAccounts).toHaveBeenCalledTimes(2);
    const [portfolioCall, authCall] = getProgramAccounts.mock.calls as unknown as [[PublicKey, { filters: Array<Record<string, unknown>> }], [PublicKey, { filters: Array<Record<string, unknown>>; dataSlice: unknown }]];
    expect(portfolioCall[1].filters).toContainEqual({ memcmp: { offset: 116, bytes: WALLET.toBase58() } });
    expect(portfolioCall[1].filters.some((f) => "dataSize" in f && f.dataSize === LP.data.length)).toBe(true);
    expect(authCall[1].dataSlice).toEqual({ offset: 0, length: 0 });
    expect(authCall[1].filters).toEqual([
      { memcmp: { offset: 10, bytes: bs58.encode(Uint8Array.of(1)) } },
      { memcmp: { offset: 16, bytes: WALLET.toBase58() } },
    ]);
  });
  it("a trading portfolio (matcher not enabled) is not a creator marker", async () => {
    const trader = LP.data.slice();
    const off = trader.length - 104 - 24 + 96;
    trader.fill(0, off, off + 8); // control word: enabled bit cleared
    const getProgramAccounts = vi.fn(async (_p: PublicKey, cfg?: { dataSlice?: unknown }) => (cfg?.dataSlice ? [] : [{ pubkey: SLAB, account: acct(trader) }]));
    expect(await findCreatorSlabKeys({ getProgramAccounts } as never, PROGRAM, WALLET)).toEqual([]);
  });
  it("an unfinished launch (marketauth still the wallet) is found by key, and de-duplicated with the LP marker", async () => {
    const getProgramAccounts = vi.fn(async (_p: PublicKey, cfg?: { dataSlice?: unknown }) =>
      cfg?.dataSlice ? [{ pubkey: SLAB, account: acct(new Uint8Array()) }] : [{ pubkey: SLAB, account: acct(LP.data) }],
    );
    expect((await findCreatorSlabKeys({ getProgramAccounts } as never, PROGRAM, WALLET)).length).toBe(1);
  });
});

describe("readCreatorSlabs", () => {
  it("keeps program-owned v2.2 markets; drops foreign owners, missing and non-market accounts; batches by 100", async () => {
    const other = new PublicKey("11111111111111111111111111111112");
    const keys = Array.from({ length: 103 }, () => PublicKey.unique());
    const getMultipleAccountsInfo = vi.fn(async (ks: PublicKey[]) =>
      ks.map((_, i) => (i === 0 ? acct(MKT.data) : i === 1 ? { ...acct(MKT.data), owner: other } : i === 2 ? null : acct(new Uint8Array(40)))),
    );
    const out = await readCreatorSlabs({ getMultipleAccountsInfo } as never, PROGRAM, keys);
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    expect(out.length).toBe(2); // index 0 of each batch
  });
});

describe("findCreationSlot", () => {
  const sig = (slot: number, err: unknown = null) => ({ signature: `s${slot}`, slot, err, memo: null, blockTime: null });
  it("the oldest successful transaction; a failed earlier attempt does not count", async () => {
    const getSignaturesForAddress = vi.fn(async () => [sig(30), sig(20), sig(10, { InstructionError: [0, "x"] })]);
    expect(await findCreationSlot({ getSignaturesForAddress } as never, SLAB)).toBe(20n);
  });
  it("a full page is an old busy market: unknown (so not classified), and is cached", async () => {
    const getSignaturesForAddress = vi.fn(async () => Array.from({ length: 1000 }, (_, i) => sig(i + 1)));
    expect(await findCreationSlot({ getSignaturesForAddress } as never, SLAB)).toBeNull();
    await findCreationSlot({ getSignaturesForAddress } as never, SLAB);
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });
  it("an RPC failure is unknown and is NOT cached (the next scan retries)", async () => {
    const getSignaturesForAddress = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValueOnce([sig(5)]);
    expect(await findCreationSlot({ getSignaturesForAddress } as never, SLAB)).toBeNull();
    expect(await findCreationSlot({ getSignaturesForAddress } as never, SLAB)).toBe(5n);
  });
});

describe("lookupCreatorMarkets budget", () => {
  it("at most MAX_CREATION_LOOKUPS signature calls however many markets the wallet has", async () => {
    const n = MAX_CREATION_LOOKUPS + 5;
    const lps = Array.from({ length: n }, () => {
      const d = LP.data.slice();
      d.set(PublicKey.unique().toBytes(), 16);
      return d;
    });
    const getProgramAccounts = vi.fn(async (_p: PublicKey, cfg?: { dataSlice?: unknown }) => (cfg?.dataSlice ? [] : lps.map((d) => ({ pubkey: PublicKey.unique(), account: acct(d) }))));
    const getMultipleAccountsInfo = vi.fn(async (ks: PublicKey[]) => ks.map(() => acct(MKT.data)));
    const getSignaturesForAddress = vi.fn(async () => [{ signature: "s", slot: 7, err: null, memo: null, blockTime: null }]);
    const out = await lookupCreatorMarkets({ getProgramAccounts, getMultipleAccountsInfo, getSignaturesForAddress } as never, PROGRAM, WALLET);
    expect(out.length).toBe(n);
    expect(getSignaturesForAddress).toHaveBeenCalledTimes(MAX_CREATION_LOOKUPS);
    expect(out.filter((o) => o.creationSlot === null).length).toBe(5);
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });
});
