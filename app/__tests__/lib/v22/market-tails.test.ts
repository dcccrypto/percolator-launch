// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ACCOUNT_KIND, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, deriveBondTrancheV22, deriveInsuranceUnitsV22, deriveLevGuardV22 } from "@/lib/v22/sdk";
import { deriveVaultLpExtP2b } from "@/lib/v22/sdk/records/p2b-earn";
import { SystemProgram } from "@solana/web3.js";
import { __setTailsClockForTest, applyMarketTailsV22, fetchMarketTailsV22, withMarketTailsV22, NO_TAILS } from "@/lib/v22/market-tails";

const prog = Keypair.generate().publicKey;
const market = Keypair.generate().publicKey;
const tranche = deriveBondTrancheV22(prog, market)[0];
const units = deriveInsuranceUnitsV22(prog, market)[0];
// #636 (prog #640 / #641): the flow tags carry the vault ext at its PDA (97 [11], 98 [8], 103 [7]) and get the lev guard appended.
const ext = deriveVaultLpExtP2b(prog, market)[0];
const guard = deriveLevGuardV22(prog, market)[0];
const EXT_SLOT: Record<number, number> = { 97: 11, 98: 8, 103: 7 };
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
  const keys = Array.from({ length: n }, (_, i) => ({ pubkey: i === 1 ? market : i === EXT_SLOT[tag] ? ext : k(), isSigner: false, isWritable: i === 8 ? writable8 : false }));
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
  it.each([[78, 9], [102, 11], [9, 5], [56, 5], [57, 6], [41, 6], [101, 12]])("tails absent: tag %i is byte-identical (no #636 flow tail: not a flow, or 102 Resolved)", (tag, n) => {
    const a = ix(tag, n);
    expect(applyMarketTailsV22(a, NO_TAILS)).toBe(a);
  });
  it.each([[97, 12, 14], [103, 9, 11], [102, 7, 14], [98, 9, 10]])("tails absent: flow tag %i (%i accounts) gets the #636 tail -> %i, lev guard last, writable; bond slot padded", (tag, n, full) => {
    const a = ix(tag, n);
    const o = applyMarketTailsV22(a, NO_TAILS);
    expect(o.keys).toHaveLength(full);
    expect(o.keys.slice(0, n).map((x) => x.pubkey.toBase58())).toEqual(a.keys.map((x) => x.pubkey.toBase58()));
    expect(o.keys.at(-1)!.pubkey.equals(guard)).toBe(true);
    expect(o.keys.at(-1)!.isWritable).toBe(true);
    if (tag === 97) expect(o.keys[12].pubkey.equals(SystemProgram.programId)).toBe(true);
    if (tag === 103) expect(o.keys[9].pubkey.equals(SystemProgram.programId)).toBe(true);
    if (tag === 102) expect(o.keys[12].pubkey.equals(ext)).toBe(true);
    expect(o.data.equals(a.data)).toBe(true);
  });
  it.each([[78, 9, true], [97, 12, false], [102, 11, false], [103, 9, false]])("bond tag %i: exactly the tranche appended, writable only for 78 (97 / 103 then get the lev guard)", (tag, n, w) => {
    const a = ix(tag, n);
    const o = applyMarketTailsV22(a, both);
    const flow = tag === 97 || tag === 103;
    expect(o.keys).toHaveLength(n + 1 + (flow ? 1 : 0));
    expect(o.keys[n].pubkey.equals(tranche)).toBe(true);
    expect(o.keys[n].isWritable).toBe(w);
    if (flow) expect(o.keys[n + 1].pubkey.equals(guard)).toBe(true);
    expect(o.data.equals(a.data)).toBe(true);
    expect(o.keys.slice(0, n).map((x) => x.pubkey.toBase58())).toEqual(a.keys.map((x) => x.pubkey.toBase58()));
  });
  it("a full-form 97 / 103 with a PADDED bond slot gets the tranche in that slot on a bond market (not appended)", () => {
    const f97 = applyMarketTailsV22(ix(97, 12), NO_TAILS);
    const o = applyMarketTailsV22(f97, both);
    expect(o.keys).toHaveLength(14);
    expect(o.keys[12].pubkey.equals(tranche)).toBe(true);
    const f103 = applyMarketTailsV22(ix(103, 9), NO_TAILS);
    expect(applyMarketTailsV22(f103, both).keys[9].pubkey.equals(tranche)).toBe(true);
  });
  it("a flow tag the #636 tail cannot place (non-PDA ext) is refused loudly, before any prompt", () => {
    const bad = new TransactionInstruction({ programId: prog, keys: ix(98, 9).keys.map((m, i) => (i === 8 ? { ...m, pubkey: k() } : m)), data: Buffer.from([98, 0]) });
    expect(() => applyMarketTailsV22(bad, NO_TAILS)).toThrow(/isn't available/);
  });
  it("tag 78: the vault LP at [8] is rebuilt writable", () => {
    expect(applyMarketTailsV22(ix(78, 9, false), both).keys[8].isWritable).toBe(true);
  });
  it.each([[9, 5], [56, 5], [57, 6], [41, 6], [101, 12]])("units tag %i: units appended last, writable", (tag, n) => {
    const o = applyMarketTailsV22(ix(tag, n), both);
    expect(o.keys.at(-1)!.pubkey.equals(units)).toBe(true);
    expect(o.keys.at(-1)!.isWritable).toBe(true);
  });
  it("live 102 gets no tranche (only the #636 tail); applying twice does not double-append", () => {
    const live = applyMarketTailsV22(ix(102, 7), both);
    expect(live.keys).toHaveLength(14);
    expect(live.keys.some((m) => m.pubkey.equals(tranche))).toBe(false);
    const once = applyMarketTailsV22(ix(97, 12), both);
    expect(applyMarketTailsV22(once, both)).toBe(once);
    expect(once.keys).toHaveLength(14);
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
    expect(out[0].keys).toHaveLength(14); // tranche at [12] + #636 lev guard at [13]
    expect(out[0].keys[12].pubkey.equals(tranche)).toBe(true);
    expect(out[1].keys.at(-1)!.pubkey.equals(units)).toBe(true);
    expect(out[2]).toBe(foreign);
    expect(c.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
  });
  it("an RPC failure leaves the bond / units tails off; the #636 flow tail (no RPC) is still applied", async () => {
    const c = { getMultipleAccountsInfo: vi.fn(async () => { throw new Error("rpc"); }) };
    const a = ix(97, 12);
    const o = (await withMarketTailsV22(c, prog, [a]))[0];
    expect(o.keys).toHaveLength(14);
    expect(o.keys[12].pubkey.equals(SystemProgram.programId)).toBe(true);
    const b = ix(78, 9);
    expect((await withMarketTailsV22(c, prog, [b]))[0]).toBe(b);
  });
});
