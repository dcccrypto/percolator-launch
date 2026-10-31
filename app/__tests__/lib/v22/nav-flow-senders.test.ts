// @vitest-environment node
/**
 * #636 / #636b (percolator-prog #640 + #641 at 780013c8, merged together into rc23): EVERY app sender of a flow tag, its
 * exact account list as it leaves the app (builder + the send choke point lib/v22/market-tails.ts) and its compute-unit
 * limit. The expected lists are written out by hand from the Rust handlers (`lev_nav_flow_begin(.., guard_idx, ext_idx, ..)`):
 *   96 [7] guard w [8] ext w · 97 [11] ext w [12] tranche|pad [13] guard w · 98 [8] ext w [9] guard w ·
 *   103 [7] ext [9] tranche|pad [10] guard w · 108 / 110 [13] ext w [14] guard w · 102 Resolved: unchanged.
 * PDAs are derived here from their seeds, independently of the code under test.
 * Negative control: on the pre-#640 app (feat/v22-app 7701447eb) every case here fails (see the PR body).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setTailsClockForTest, applyMarketTailsV22, NO_TAILS } from "@/lib/v22/market-tails";
import * as V22 from "@/lib/v22/sdk";
import { buildDepositJuniorTrancheIx, buildWithdrawJuniorTrancheIx, buildVaultLpReleaseSurplusIx, type VaultLpMarket } from "@/lib/limits/p3-ix";
import { buildP3BindIxs } from "@/lib/limits/p3-wizard";
import { recallIxFor77, recallCu, RECALL_CU } from "@/lib/limits/senior-draw-repair";
import { buildVaultLpAllocateIx } from "@/lib/v21/sdk/p2b-earn";
import { juniorFlowComputeUnits } from "@/hooks/useJuniorTranche";
import { decodeVaultLpExtV19 } from "@/lib/v22/sdk/records/p2b-earn";

const k = (): PublicKey => Keypair.generate().publicKey;
const prog = k(), market = k(), lp = k();
const pda = (...seeds: (string | PublicKey)[]): PublicKey =>
  PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())), prog)[0];
const GUARD = pda("lev_guard", market);
const EXT = pda("vault_lp_ext", market);
const STATE = pda("vault_lp", market);
const TRANCHE = pda("bond_tranche", market);
const SYS = SystemProgram.programId;
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const REG = k(), OWN = k(), SIB = k();
const vm: VaultLpMarket = { programId: prog, market, registry: REG, vaultLpState: STATE, lpPortfolio: lp, ledger: OWN, siblingLedger: SIB, ext: EXT };
const b58 = (xs: PublicKey[]): string[] => xs.map((x) => x.toBase58());
const keys = (ix: TransactionInstruction): string[] => ix.keys.map((m) => m.pubkey.toBase58());
const sent = (ix: TransactionInstruction, tails = NO_TAILS): TransactionInstruction => applyMarketTailsV22(ix, tails);

beforeEach(() => {
  __setDevnetV22ForTest(true);
  __setTailsClockForTest(null);
});
afterEach(() => __setDevnetV22ForTest(null));

describe("96 DepositJuniorTranche", () => {
  const [owner, src, vault] = [k(), k(), k()];
  const base = [owner, market, STATE, lp, src, vault, TOKEN];
  it("useJuniorTranche deposit: 7 -> 9 ([7] guard w, [8] ext w) at the send choke point; 250k CU", () => {
    const ix = sent(buildDepositJuniorTrancheIx(vm, owner, src, vault, 5n));
    expect(keys(ix)).toEqual(b58([...base, GUARD, EXT]));
    expect([ix.keys[7].isWritable, ix.keys[8].isWritable]).toEqual([true, true]);
    expect(juniorFlowComputeUnits("deposit")).toBe(250_000);
  });
  it("launch bind (batched M4p and the single-tx launch, which skips the choke point): the 96 carries the tail itself", () => {
    const portfolio = lp, ctx = k();
    const ixs = buildP3BindIxs({
      market: vm, creator: owner, vaultLpPortfolio: portfolio, portfolioLen: 10_607, portfolioRentLamports: 1, matcherProgram: k(), matcherCtx: ctx,
      matcherCtxRentLamports: 1, juniorFloorBps: 1000, juniorAtoms: 5n, creatorAta: src, vaultToken: vault,
      growth: { lLaunchX100: 500 }, levGuard: true, navFlowTail: true,
    });
    const dep = ixs.find((i) => i.programId.equals(prog) && i.data[0] === 96)!;
    expect(keys(dep)).toEqual(b58([...base, GUARD, EXT]));
    // the guard INIT (124) follows the deposit in the same tx: the deposit names the (still empty) guard PDA
    const init = ixs.find((i) => i.programId.equals(prog) && i.data[0] === 124)!;
    expect(ixs.indexOf(init)).toBeGreaterThan(ixs.indexOf(dep));
    expect(init.keys.some((m) => m.pubkey.equals(GUARD))).toBe(true);
    // the batched send passes the choke point too: idempotent
    expect(sent(dep)).toBe(dep);
  });
});

describe("97 WithdrawJuniorTranche (useJuniorTranche withdraw); 300k CU", () => {
  const [owner, dest, vault, auth] = [k(), k(), k(), k()];
  const base = [owner, market, REG, STATE, lp, OWN, SIB, dest, vault, auth, TOKEN];
  it("app builder (ext known): 12 -> 14 ([11] ext, [12] pad, [13] guard w)", () => {
    const ix = sent(buildWithdrawJuniorTrancheIx(vm, owner, dest, vault, auth, 5n));
    expect(keys(ix)).toEqual(b58([...base, EXT, SYS, GUARD]));
    expect([ix.keys[11].isWritable, ix.keys[12].isWritable, ix.keys[13].isWritable]).toEqual([true, false, true]);
    expect(juniorFlowComputeUnits("withdraw")).toBe(300_000);
  });
  it("app builder (no ext account yet): 11 -> 14, the ext PDA is still passed", () => {
    expect(keys(sent(buildWithdrawJuniorTrancheIx({ ...vm, ext: undefined }, owner, dest, vault, auth, 5n)))).toEqual(b58([...base, EXT, SYS, GUARD]));
  });
  it("bond market: app builder + choke point puts the tranche at [12]", () => {
    const ix = sent(buildWithdrawJuniorTrancheIx(vm, owner, dest, vault, auth, 5n), { bondTranche: TRANCHE, insuranceUnits: null });
    expect(keys(ix)).toEqual(b58([...base, EXT, TRANCHE, GUARD]));
  });
  it("bond market: the vendored SDK builder (14) passes the choke point unchanged", () => {
    const ix = V22.buildWithdrawJuniorTrancheIxV22({ programId: prog, market, registryDomain: 0, lpPortfolio: lp, vaultLpExt: EXT }, owner, dest, vault, 5n, { bond: true });
    expect(ix.keys).toHaveLength(14);
    expect(keys(ix).slice(11)).toEqual(b58([EXT, TRANCHE, GUARD]));
    expect(sent(ix, { bondTranche: TRANCHE, insuranceUnits: null })).toBe(ix);
  });
});

describe("98 VaultLpRecall (senior-draw repair in front of a bound 77; built after the choke point, simulated directly)", () => {
  const ix77 = new TransactionInstruction({
    programId: prog,
    keys: [k(), market, REG, k(), k(), k(), k(), k(), OWN, k(), k(), SIB, k(), STATE, lp].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    data: Buffer.from([77, 0, 0]),
  });
  const cranker = k();
  it("10 accounts: [8] ext w (always), [9] guard w; margin 400k CU (was 120k)", () => {
    const ix = recallIxFor77(ix77, cranker, 9n);
    expect(keys(ix)).toEqual(b58([cranker, market, REG, STATE, lp, OWN, SIB, SYS, EXT, GUARD]));
    expect([ix.keys[8].isWritable, ix.keys[9].isWritable]).toEqual([true, true]);
    expect(keys(recallIxFor77(ix77, cranker, 9n, EXT))).toEqual(keys(ix));
    expect(recallCu()).toBe(400_000);
  });
  it("flag off (v2.1): the old 8-account recall and the 120k margin", () => {
    __setDevnetV22ForTest(false);
    expect(recallIxFor77(ix77, cranker, 9n).keys).toHaveLength(8);
    expect(recallCu()).toBe(RECALL_CU);
  });
});

describe("103 VaultLpAllocate (useTrade allocate prefix: the choke point is applied BEFORE its gate simulation)", () => {
  const cranker = k();
  const base = [cranker, market, REG, STATE, lp, OWN, SIB, EXT, SYS];
  const built = () => buildVaultLpAllocateIx({ programId: prog, cranker, market, registry: REG, vaultLpState: STATE, lpPortfolio: lp, ledger: OWN, siblingLedger: SIB });
  it("9 -> 11 ([9] pad, [10] guard w); bond market: [9] tranche", () => {
    const ix = sent(built());
    expect(keys(ix)).toEqual(b58([...base, SYS, GUARD]));
    expect(ix.keys[10].isWritable).toBe(true);
    expect(keys(sent(built(), { bondTranche: TRANCHE, insuranceUnits: null }))).toEqual(b58([...base, TRANCHE, GUARD]));
  });
});

describe("108 / 110 bonds (useBondV22): the vendored SDK builders carry [13] ext w, [14] guard w; 600k CU presets", () => {
  const [holder, tok, vault] = [k(), k(), k()];
  const m = { programId: prog, market, registryDomain: 0, lpPortfolio: lp };
  it("108 BondDeposit: 15", () => {
    const ix = V22.buildBondDepositIxV22(m, holder, tok, vault, 100n, 1n);
    expect(ix.keys).toHaveLength(15);
    expect(keys(ix).slice(13)).toEqual(b58([EXT, GUARD]));
    expect([ix.keys[13].isWritable, ix.keys[14].isWritable]).toEqual([true, true]);
    expect(sent(ix)).toBe(ix);
    expect(V22.COMPUTE_PRESETS_V22.bondDeposit.units).toBe(600_000);
  });
  it("110 BondExecuteWithdraw: 15", () => {
    const ix = V22.buildBondExecuteWithdrawIxV22(m, holder, tok, vault, 1n, 0);
    expect(ix.keys).toHaveLength(15);
    expect(keys(ix).slice(13)).toEqual(b58([EXT, GUARD]));
    expect(sent(ix)).toBe(ix);
    expect(V22.COMPUTE_PRESETS_V22.bondExecuteWithdraw.units).toBe(600_000);
  });
});

describe("102 VaultLpReleaseSurplus (junior-resolved-release: Resolved only) is unchanged", () => {
  it("11 (+ tranche on a bond market), no flow tail", () => {
    const ix = buildVaultLpReleaseSurplusIx(vm, k(), 1n, 0, { destToken: k(), vaultToken: k(), vaultAuthority: k() });
    expect(sent(ix)).toBe(ix);
    const bond = sent(ix, { bondTranche: TRANCHE, insuranceUnits: null });
    expect(bond.keys).toHaveLength(12);
    expect(bond.keys.some((m) => m.pubkey.equals(GUARD))).toBe(false);
  });
});

describe("the vendored SDK table and CU numbers equal percolator-sdk#437", () => {
  it("NAV_FLOW_COMPUTE_UNITS_V22", () => {
    expect(Object.fromEntries(Object.entries(V22.NAV_FLOW_COMPUTE_UNITS_V22).map(([t, v]) => [t, v.units]))).toEqual({ 96: 250_000, 97: 300_000, 98: 400_000, 102: 300_000, 103: 600_000, 108: 600_000, 110: 600_000, 111: 600_000 });
  });
  it("#641 ext decoder reads the other_flow counters (a pre-#641 decoder threw on them)", () => {
    const d = new Uint8Array(144);
    const v = new DataView(d.buffer);
    v.setBigUint64(0, V22.WRAPPER_ACCOUNT_MAGIC, true);
    v.setUint16(8, 19, true);
    d[10] = V22.ACCOUNT_KIND.VaultLpExt;
    d.set(market.toBytes(), 16);
    v.setUint16(16 + 96, 5000, true); // alpha
    v.setUint16(16 + 98, 3000, true); // buffer
    d[16 + 104] = 1; // version
    d[16 + 106] = 7; // other_in = 7
    d[16 + 117 + 10] = 1; // other_out = 2^80
    const x = decodeVaultLpExtV19(d);
    expect([x.otherInAtoms, x.otherOutAtoms]).toEqual([7n, 1n << 80n]);
  });
});
