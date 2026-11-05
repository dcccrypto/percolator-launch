// @vitest-environment node
/**
 * A completed P3 (vault-LP) launch has no creator-owned LP (useCreateMarket `includeM2 = !params.p3`) and its marketauth is the
 * stake pool PDA, so asset 0's `asset_admin` (+1766, set by InitMarket) names the creator, and after an admin-key burn only the
 * vault's `VaultLpState.junior_owner` does. Real bytes of devnet market K6xMbo (slot 518,690,419; creator 2GxFkYSK... = fee payer
 * of its creation tx) and of CHILLHOUSE-T, whose LP portfolio is owned by an off-curve vault-LP address (it exercises the LP marker).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { readAssetAdmin } from "@/lib/v18-wire";
import { findCreatorSlabKeys } from "@/lib/v22/creator-onchain";
import { KIND_VAULT_LP_STATE, VAULT_LP_STATE_ACCOUNT_LEN, VS } from "@/lib/limits/constants";

const fx = (n: string): { owner: string; data: Uint8Array } => {
  const j = JSON.parse(readFileSync(path.join(__dirname, `../../fixtures/v22-growth/${n}.json`), "utf8")) as { owner: string; data: string };
  return { owner: j.owner, data: new Uint8Array(Buffer.from(j.data, "base64")) };
};
const LP = fx("chillhouse-t.lp");
const MKT = fx("chillhouse-t.market");
const P3 = fx("k6xmbo-p3.market");
const PROGRAM = new PublicKey(LP.owner);
const SLAB = new PublicKey("56pWj8zYeZMv6oHHf4nwAfWAunzixxknaVNEFY48oJ2Y");
const P3_SLAB = new PublicKey("K6xMbo6GUNhhAf2Krrm6pUCiFj1qbdZPSnrXig1scHi");
const WALLET = new PublicKey(LP.data.subarray(116, 148)); // owner of CHILLHOUSE-T's LP portfolio (off-curve)

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

const acct = (data: Uint8Array) => ({ data: Buffer.from(data), owner: PROGRAM, lamports: 1, executable: false });
const slice = (d: Uint8Array, o: number, l: number): Uint8Array => d.slice(o, o + l);

describe("findCreatorSlabKeys: a completed P3 (vault-LP) launch", () => {
  // A fake that APPLIES the filters (dataSize, base58 memcmp) and the dataSlice to real accounts, so a marker is found only when
  // the bytes on chain carry it.
  const accounts: Array<{ pubkey: PublicKey; data: Uint8Array }> = [
    { pubkey: P3_SLAB, data: P3.data },
    { pubkey: SLAB, data: MKT.data },
    { pubkey: PublicKey.unique(), data: LP.data },
  ];
  const matches = (d: Uint8Array, f: { dataSize?: number; memcmp?: { offset: number; bytes: string } }): boolean => {
    if (f.dataSize !== undefined) return d.length === f.dataSize;
    const want = bs58.decode(f.memcmp!.bytes);
    return d.length >= f.memcmp!.offset + want.length && want.every((b, i) => d[f.memcmp!.offset + i] === b);
  };
  const conn = {
    getProgramAccounts: vi.fn(async (_p: PublicKey, cfg: { filters: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string } }>; dataSlice: { offset: number; length: number } }) =>
      accounts.filter((a) => cfg.filters.every((f) => matches(a.data, f))).map((a) => ({ pubkey: a.pubkey, account: acct(slice(a.data, cfg.dataSlice.offset, cfg.dataSlice.length)) })),
    ),
    getMultipleAccountsInfo: vi.fn(async (ks: PublicKey[], cfg?: { dataSlice?: { offset: number; length: number } }) =>
      ks.map((k) => {
        const a = accounts.find((x) => x.pubkey.equals(k));
        return a ? acct(cfg?.dataSlice ? slice(a.data, cfg.dataSlice.offset, cfg.dataSlice.length) : a.data) : null;
      }),
    ),
  };
  const CREATOR = new PublicKey("2GxFkYSKrWayzGZFagk6LMdeyJ2tTACAXf255Fn9HWLa"); // fee payer of K6xMbo's creation tx
  const INIT_SIGNER = new PublicKey("FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7"); // CHILLHOUSE-T's asset_admin (the InitMarket signer)

  it("fixture: no creator LP marker, marketauth is not the creator, asset_admin (read by the app's own decoder) is, at +1766", () => {
    const creator = readAssetAdmin(P3.data, 0);
    expect(creator.equals(CREATOR)).toBe(true);
    expect(P3.data[10]).toBe(1);
    expect(new PublicKey(P3.data.subarray(16, 48)).equals(creator)).toBe(false);
    expect(new PublicKey(P3.data.subarray(1766, 1798)).equals(creator)).toBe(true);
    expect(creator.equals(PublicKey.default)).toBe(false);
  });
  it("the creator's lookup lists the P3 market (failed before this fix: neither the LP nor the marketauth marker matches)", async () => {
    const keys = await findCreatorSlabKeys(conn as never, PROGRAM, CREATOR);
    expect(keys.map((k) => k.toBase58())).toEqual([P3_SLAB.toBase58()]);
  });
  it("an unfinished P3 launch (marketauth AND asset_admin still the creator) is listed once", async () => {
    const unfinished = P3.data.slice();
    unfinished.set(CREATOR.toBytes(), 16);
    accounts[0] = { pubkey: P3_SLAB, data: unfinished };
    try {
      expect((await findCreatorSlabKeys(conn as never, PROGRAM, CREATOR)).map((k) => k.toBase58())).toEqual([P3_SLAB.toBase58()]);
    } finally {
      accounts[0] = { pubkey: P3_SLAB, data: P3.data };
    }
  });
  it("the LP marker still lists a market for its LP owner; CHILLHOUSE-T's asset_admin is its InitMarket signer; an unrelated wallet finds nothing", async () => {
    expect(readAssetAdmin(MKT.data, 0).equals(INIT_SIGNER)).toBe(true); // CHILLHOUSE-T: LP owner != asset_admin
    expect((await findCreatorSlabKeys(conn as never, PROGRAM, WALLET)).map((k) => k.toBase58())).toEqual([SLAB.toBase58()]);
    expect((await findCreatorSlabKeys(conn as never, PROGRAM, INIT_SIGNER)).map((k) => k.toBase58())).toEqual([SLAB.toBase58()]);
    expect(await findCreatorSlabKeys(conn as never, PROGRAM, PublicKey.unique())).toEqual([]);
  });
  it("a burned admin key (asset_admin zero) is still listed through the vault's junior_owner, and only through it", async () => {
    const burned = P3.data.slice();
    burned.fill(0, 1766, 1798);
    const vault = new Uint8Array(VAULT_LP_STATE_ACCOUNT_LEN);
    vault[10] = KIND_VAULT_LP_STATE;
    vault.set(P3_SLAB.toBytes(), VS.marketGroup);
    vault.set(CREATOR.toBytes(), VS.juniorOwner);
    accounts[0] = { pubkey: P3_SLAB, data: burned };
    try {
      expect(await findCreatorSlabKeys(conn as never, PROGRAM, CREATOR)).toEqual([]);
      accounts.push({ pubkey: PublicKey.unique(), data: vault });
      expect((await findCreatorSlabKeys(conn as never, PROGRAM, CREATOR)).map((k) => k.toBase58())).toEqual([P3_SLAB.toBase58()]);
      expect(await findCreatorSlabKeys(conn as never, PROGRAM, PublicKey.unique())).toEqual([]);
    } finally {
      accounts[0] = { pubkey: P3_SLAB, data: P3.data };
      accounts.splice(3);
    }
  });
});
