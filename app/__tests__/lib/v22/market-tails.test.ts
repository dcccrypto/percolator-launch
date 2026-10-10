// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ACCOUNT_KIND, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, deriveBondTrancheV22, deriveInsuranceUnitsV22 } from "@/lib/v22/sdk";
import { __setTailsClockForTest, applyMarketTailsV22, fetchMarketTailsV22, withMarketTailsV22, NO_TAILS } from "@/lib/v22/market-tails";

const prog = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;
const tranche = deriveBondTrancheV22(prog, market)[0];
const units = deriveInsuranceUnitsV22(prog, market)[0];
const k = () => Keypair.generate().publicKey;

function acct(kind: number, owner = prog) {
  const d = new Uint8Array(200);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  d[10] = kind;
  return { owner, data: d, lamports: 1, executable: false };
}
function ix(tag: number, n: number, writable8 = false): TransactionInstruction {
  const keys = Array.from({ length: n }, (_, i) => ({ pubkey: i === 1 ? market : k(), isSigner: false, isWritable: i === 8 ? writable8 : false }));
  return new TransactionInstruction({ programId: prog, keys, data: Buffer.from([tag, 1, 2]) });
}
const conn = (t: unknown, u: unknown) => ({ getMultipleAccountsInfo: vi.fn(async () => [t, u]) });
const both = { bondTranche: tranche, insuranceUnits: units };

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __setTailsClockForTest(null);
});
afterEach(() => __setDevnetV22ForTest(null));

describe("applyMarketTailsV22", () => {
  it.each([[78, 9], [97, 12], [102, 11], [103, 9], [9, 5], [56, 5], [57, 6], [41, 6], [101, 12]])("tails absent: tag %i is byte-identical", (tag, n) => {
    const a = ix(tag, n);
    expect(applyMarketTailsV22(a, NO_TAILS)).toBe(a);
  });
  it.each([[78, 9, true], [97, 12, false], [102, 11, false], [103, 9, false]])("bond tag %i: exactly the tranche appended, writable only for 78", (tag, n, w) => {
    const a = ix(tag, n);
    const o = applyMarketTailsV22(a, both);
    expect(o.keys).toHaveLength(n + 1);
    expect(o.keys[n].pubkey.equals(tranche)).toBe(true);
    expect(o.keys[n].isWritable).toBe(w);
    expect(o.data.equals(a.data)).toBe(true);
    expect(o.keys.slice(0, n).map((x) => x.pubkey.toBase58())).toEqual(a.keys.map((x) => x.pubkey.toBase58()));
  });
  it("tag 78: the vault LP at [8] is rebuilt writable", () => {
    expect(applyMarketTailsV22(ix(78, 9, false), both).keys[8].isWritable).toBe(true);
  });
  it.each([[9, 5], [56, 5], [57, 6], [41, 6], [101, 12]])("units tag %i: units appended last, writable", (tag, n) => {
    const o = applyMarketTailsV22(ix(tag, n), both);
    expect(o.keys.at(-1)!.pubkey.equals(units)).toBe(true);
    expect(o.keys.at(-1)!.isWritable).toBe(true);
  });
  it("a wrong-length bond-tag instruction (live 102) is left alone; applying twice does not double-append", () => {
    const live = ix(102, 7);
    expect(applyMarketTailsV22(live, both)).toBe(live);
    const once = applyMarketTailsV22(ix(97, 12), both);
    expect(applyMarketTailsV22(once, both).keys).toHaveLength(13);
  });
});

describe("fetchMarketTailsV22", () => {
  it("one RPC call; present + right kind + wrapper-owned", async () => {
    const c = conn(acct(ACCOUNT_KIND.BondTranche), acct(ACCOUNT_KIND.InsuranceUnits));
    const t = await fetchMarketTailsV22(c, prog, market);
    expect(t.bondTranche?.equals(tranche)).toBe(true);
    expect(t.insuranceUnits?.equals(units)).toBe(true);
    expect(c.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    await fetchMarketTailsV22(c, prog, market); // cached
    expect(c.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });
  it("wrong kind or wrong owner counts as absent; missing too", async () => {
    const t = await fetchMarketTailsV22(conn(acct(ACCOUNT_KIND.Portfolio), acct(ACCOUNT_KIND.InsuranceUnits, Keypair.generate().publicKey)), prog, market);
    expect(t).toEqual(NO_TAILS);
    __setTailsClockForTest(null);
    expect(await fetchMarketTailsV22(conn(null, null), prog, market)).toEqual(NO_TAILS);
  });
  it("the cache expires on the injected clock", async () => {
    let t = 0;
    __setTailsClockForTest(() => t);
    const c = conn(null, null);
    await fetchMarketTailsV22(c, prog, market);
    t = 20_000;
    await fetchMarketTailsV22(c, prog, market);
    expect(c.getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
  });
});

describe("withMarketTailsV22 (the sendTx choke point)", () => {
  it("flag off: same array, no RPC", async () => {
    __setDevnetV22ForTest(false);
    const c = conn(acct(11), acct(13));
    const list = [ix(78, 9)];
    expect(await withMarketTailsV22(c, prog, list)).toBe(list);
    expect(c.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
  it("flag on, no instruction takes a tail: no RPC", async () => {
    const c = conn(acct(11), acct(13));
    const list = [ix(5, 9)];
    expect(await withMarketTailsV22(c, prog, list)).toBe(list);
    expect(c.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
  it("flag on: appends, one RPC for two instructions on one market; a foreign program's tag is untouched", async () => {
    const c = conn(acct(11), acct(13));
    const foreign = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: ix(97, 12).keys, data: Buffer.from([97]) });
    const out = await withMarketTailsV22(c, prog, [ix(97, 12), ix(9, 5), foreign]);
    expect(out[0].keys).toHaveLength(13);
    expect(out[1].keys.at(-1)!.pubkey.equals(units)).toBe(true);
    expect(out[2]).toBe(foreign);
    expect(c.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });
  it("an RPC failure leaves the instruction unchanged", async () => {
    const c = { getMultipleAccountsInfo: vi.fn(async () => { throw new Error("rpc"); }) };
    const a = ix(97, 12);
    expect((await withMarketTailsV22(c, prog, [a]))[0]).toBe(a);
  });
});
