// @vitest-environment node
/**
 * P3 account lists (read from the handler bodies at feat/p3-vault-owned-lp@424fe7e4; executed
 * end to end on real BPF by scripts/limits-parity/p3-sim) and the Earn tx plan.
 */
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as ix from "@/lib/limits/p3-ix";
import * as C from "@/lib/limits/constants";
import { buildEarnDepositIxs, buildEarnExecuteIxs, earnTxPlan, type EarnP3Context } from "@/lib/limits/earn-ixs";

const k = () => Keypair.generate().publicKey;
const PROG = k();
const MARKET = k();
const m: ix.VaultLpMarket = {
  programId: PROG,
  market: MARKET,
  registry: ix.deriveLpVaultRegistryPda(PROG, MARKET),
  vaultLpState: ix.deriveVaultLpState(PROG, MARKET),
  lpPortfolio: k(),
  ledger: k(),
  siblingLedger: k(),
};
const flags = (i: { keys: { isSigner: boolean; isWritable: boolean }[] }) => i.keys.map((x) => `${x.isSigner ? "s" : "-"}${x.isWritable ? "w" : "-"}`).join(" ");
const keys = (i: { keys: { pubkey: PublicKey }[] }) => i.keys.map((x) => x.pubkey.toBase58());

describe("P3 PDAs", () => {
  it("vault-LP state = [\"vault_lp\", market], registry = [\"lp_vault\", market], nft registry = [\"nft_registry\", market]", () => {
    const enc = new TextEncoder();
    expect(ix.deriveVaultLpState(PROG, MARKET).equals(PublicKey.findProgramAddressSync([enc.encode("vault_lp"), MARKET.toBytes()], PROG)[0])).toBe(true);
    expect(ix.deriveLpVaultRegistryPda(PROG, MARKET).equals(PublicKey.findProgramAddressSync([enc.encode("lp_vault"), MARKET.toBytes()], PROG)[0])).toBe(true);
    expect(ix.deriveNftRegistryPda(PROG, MARKET).equals(PublicKey.findProgramAddressSync([enc.encode("nft_registry"), MARKET.toBytes()], PROG)[0])).toBe(true);
  });
});

describe("P3 builders: account order + signer/writable exactly as the handlers read them", () => {
  it("94 InitVaultLp auto-pin (07a1d0eb handle_init_vault_lp): marketauth + [8] matcher, [9] ctx (w), [10] delegate", () => {
    const auth = k(), mp = k(), ctxk = k();
    const i = ix.buildInitVaultLpIx(m, auth, 2_000, { matcherProgram: mp, matcherCtx: ctxk });
    const del = ix.deriveVaultLpMatcherDelegate(PROG, MARKET, m.lpPortfolio, m.registry, mp, ctxk);
    expect(keys(i)).toEqual([auth, MARKET, m.registry, m.vaultLpState, m.lpPortfolio, SystemProgram.programId, m.ledger, m.siblingLedger, mp, ctxk, del].map((x) => x.toBase58()));
    expect(flags(i)).toBe("sw -w -w -w -w -- -w -w -- -w --");
  });
  it("96 DepositJuniorTranche (handle_deposit_junior_tranche :26282)", () => {
    const o = k(), src = k(), vt = k();
    const i = ix.buildDepositJuniorTrancheIx(m, o, src, vt, 5n);
    expect(keys(i).slice(0, 6)).toEqual([o, MARKET, m.vaultLpState, m.lpPortfolio, src, vt].map((x) => x.toBase58()));
    expect(flags(i)).toBe("s- -w -w -w -w -w --");
  });
  it("97 WithdrawJuniorTranche (handle_withdraw_junior_tranche :26357)", () => {
    const o = k(), dst = k(), vt = k(), va = k();
    const i = ix.buildWithdrawJuniorTrancheIx(m, o, dst, vt, va, 1n);
    expect(keys(i).slice(0, 10)).toEqual([o, MARKET, m.registry, m.vaultLpState, m.lpPortfolio, m.ledger, m.siblingLedger, dst, vt, va].map((x) => x.toBase58()));
    expect(i.keys).toHaveLength(11);
  });
  it("101 VaultLpSettleResolved (handle_vault_lp_settle_resolved :26694)", () => {
    const c = k(), jd = k(), vt = k(), va = k();
    const i = ix.buildVaultLpSettleResolvedIx(m, c, jd, vt, va, 0);
    expect(keys(i).slice(0, 10)).toEqual([c, MARKET, m.registry, m.vaultLpState, m.lpPortfolio, m.ledger, m.siblingLedger, jd, vt, va].map((x) => x.toBase58()));
    expect(i.keys[11].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(flags(i)).toBe("sw -w -- -w -w -w -- -w -w -- -- --");
  });
  it("30 / 46 permissionless: owner UNSIGNED at [0], owner ATA [3], NftRegistry proof at [7] and nothing after (no NFT trio)", () => {
    const owner = k(), pf = k(), ata = k(), vt = k(), va = k();
    for (const tag of [C.TAG_CLOSE_RESOLVED, C.TAG_CLAIM_RESOLVED_PAYOUT_TOPUP] as const) {
      const i = ix.buildPermissionlessResolvedIx({ tag, programId: PROG, owner, market: MARKET, portfolio: pf, ownerAta: ata, vaultToken: vt, vaultAuthority: va });
      expect(i.keys).toHaveLength(8);
      expect(i.keys[0]).toEqual({ pubkey: owner, isSigner: false, isWritable: false });
      expect(keys(i).slice(1, 6)).toEqual([MARKET, pf, ata, vt, va].map((x) => x.toBase58()));
      expect(i.keys[7].pubkey.equals(ix.deriveNftRegistryPda(PROG, MARKET))).toBe(true);
      expect(i.data[0]).toBe(tag);
    }
  });
  it("8 ClosePortfolio F-4 form: [closer (s,w), market (w), portfolio (w), owner (w)] + v18 identity", () => {
    const closer = k(), pf = k(), owner = k();
    const i = ix.buildResolvedClosePortfolioIx({ programId: PROG, closer, market: MARKET, portfolio: pf, owner, portfolioId: 7n, matcherSequence: 9n, positionEpoch: 2n });
    expect(keys(i)).toEqual([closer, MARKET, pf, owner].map((x) => x.toBase58()));
    expect(flags(i)).toBe("sw -w -w -w");
    expect(Buffer.from(i.data).toString("hex")).toBe(Buffer.from(ix.encodeClosePortfolio(7n, 9n, 2n)).toString("hex"));
  });
  it("78 LpVaultCrankFees: base 6 + bound tail [6] only (need_lp = false)", () => {
    const c = k();
    const unbound = ix.buildLpVaultCrankFeesIx({ programId: PROG, cranker: c, market: MARKET, registry: m.registry, ledger: m.ledger, siblingLedger: m.siblingLedger, domain: 0, bound: null });
    expect(unbound.keys).toHaveLength(6);
    const bound = ix.buildLpVaultCrankFeesIx({ programId: PROG, cranker: c, market: MARKET, registry: m.registry, ledger: m.ledger, siblingLedger: m.siblingLedger, domain: 0, bound: { vaultLpState: m.vaultLpState } });
    expect(bound.keys).toHaveLength(7);
    expect(bound.keys[C.BOUND_TAIL_INDEX[78]]).toEqual({ pubkey: m.vaultLpState, isSigner: false, isWritable: true });
    expect(flags(bound)).toBe("sw -w -w -w -w -- -w");
  });
  it("withBoundVaultLpTail refuses a base list that would put the tail at the wrong index, and a 75/77 tail without the LP", () => {
    const base = Array.from({ length: 10 }, () => ({ pubkey: k(), isSigner: false, isWritable: false }));
    expect(() => ix.withBoundVaultLpTail(75, base, m.vaultLpState, m.lpPortfolio)).toThrow(/\[11\]/);
    const eleven = [...base, { pubkey: k(), isSigner: false, isWritable: true }];
    expect(() => ix.withBoundVaultLpTail(75, eleven, m.vaultLpState)).toThrow(/vault LP portfolio/);
    const t = ix.withBoundVaultLpTail(75, eleven, m.vaultLpState, m.lpPortfolio);
    expect(t[11]).toEqual({ pubkey: m.vaultLpState, isSigner: false, isWritable: true });
    // d119eebd senior draw: the vault LP is WRITABLE on 75/77 (the instruction runs the draw).
    expect(t[12]).toEqual({ pubkey: m.lpPortfolio, isSigner: false, isWritable: true });
  });
});

const ctx = (o: Partial<EarnP3Context> = {}): EarnP3Context => ({
  bound: true,
  vaultLpState: m.vaultLpState,
  lpPortfolio: m.lpPortfolio,
  harvestable: 0n,
  registryShares: 1_000n,
  mode: C.MARKET_MODE_LIVE,
  ...o,
});

describe("earnTxPlan (P3-K1 / P3-L1 / bound flag / resolved harvest lock)", () => {
  it("unbound or unreadable registry => legacy shape (no tail)", () => {
    for (const bound of [false, null] as const) {
      expect(earnTxPlan(75, ctx({ bound }))).toEqual({ ok: true, tail: null, prependHarvest: false });
      expect(earnTxPlan(77, ctx({ bound }))).toEqual({ ok: true, tail: null, prependHarvest: false });
    }
  });
  it("registry flag 2+ => refused before signing", () => {
    expect(earnTxPlan(75, ctx({ bound: "invalid" }))).toEqual({ ok: false, reason: "registry-invalid" });
  });
  it("bound but the vault-LP state is unreadable => refused (never priced off backing alone)", () => {
    expect(earnTxPlan(77, ctx({ lpPortfolio: null }))).toEqual({ ok: false, reason: "vault-lp-unreadable" });
  });
  it("76 never takes a tail", () => {
    expect(earnTxPlan(76, ctx())).toEqual({ ok: true, tail: null, prependHarvest: false });
  });
  it("77 bound: tail always; 78 prepended iff fees are harvestable (K1)", () => {
    expect(earnTxPlan(77, ctx())).toMatchObject({ ok: true, prependHarvest: false });
    expect(earnTxPlan(77, ctx({ harvestable: 1n }))).toMatchObject({ ok: true, prependHarvest: true });
  });
  it("77 bound in RESOLVED mode with fees pending => 78 prepended (07a1d0eb: 78 runs once terminal-flat)", () => {
    expect(earnTxPlan(77, ctx({ harvestable: 5n, mode: C.MARKET_MODE_RESOLVED }))).toMatchObject({ ok: true, prependHarvest: true });
    expect(earnTxPlan(77, ctx({ harvestable: 0n, mode: C.MARKET_MODE_RESOLVED }))).toMatchObject({ ok: true, prependHarvest: false });
  });
  it("75 bound: 78 prepended only at GENESIS with fees pending (L1)", () => {
    expect(earnTxPlan(75, ctx({ harvestable: 9n, registryShares: 0n }))).toMatchObject({ ok: true, prependHarvest: true });
    expect(earnTxPlan(75, ctx({ harvestable: 9n, registryShares: 5n }))).toMatchObject({ ok: true, prependHarvest: false });
    expect(earnTxPlan(75, ctx({ harvestable: 0n, registryShares: 0n }))).toMatchObject({ ok: true, prependHarvest: false });
  });
});

describe("Earn assembly (shared by useInsuranceLP and the sim bridge)", () => {
  const u = k();
  const common = { programId: PROG, market: MARKET, registry: m.registry, lpMint: k(), vaultToken: k(), ledger: m.ledger, siblingLedger: m.siblingLedger, domain: 0 };
  it("deposit: [78, 75] with the tail at [11]/[12] when bound + genesis + fees", () => {
    const plan = earnTxPlan(75, ctx({ harvestable: 3n, registryShares: 0n }));
    if (!plan.ok) throw new Error("plan");
    const ixs = buildEarnDepositIxs({ ...common, depositor: u, depositorLpAta: k(), sourceToken: k(), amount: 10n, plan });
    expect(ixs.map((i) => i.data[0])).toEqual([C.TAG_LP_VAULT_CRANK_FEES, C.TAG_DEPOSIT_TO_LP_VAULT]);
    expect(ixs[1].keys).toHaveLength(13);
    expect(ixs[1].keys[11].pubkey.equals(m.vaultLpState)).toBe(true);
    expect(ixs[1].keys[12].pubkey.equals(m.lpPortfolio)).toBe(true);
  });
  it("execute: 13 base accounts ([12] = the redeemer as rent dest) + tail [13]/[14]; 78 first when fees pend", () => {
    const plan = earnTxPlan(77, ctx({ harvestable: 3n }));
    if (!plan.ok) throw new Error("plan");
    const ixs = buildEarnExecuteIxs({ ...common, redeemer: u, redemption: k(), escrow: k(), vaultAuthority: k(), redeemerDest: k(), plan });
    expect(ixs.map((i) => i.data[0])).toEqual([C.TAG_LP_VAULT_CRANK_FEES, C.TAG_EXECUTE_REDEMPTION]);
    const e = ixs[1];
    expect(e.keys).toHaveLength(15);
    // [12] is the redeemer: it signs (the redeemer is also the fee payer, so one signature on the message).
    // P2b H-1b needs it flagged on a Live non-bound 77; the legacy program ignores the flag.
    expect(e.keys[12]).toEqual({ pubkey: u, isSigner: true, isWritable: true });
    expect(e.keys[13].pubkey.equals(m.vaultLpState)).toBe(true);
    expect(e.keys[14].pubkey.equals(m.lpPortfolio)).toBe(true);
  });
  it("unbound: byte-identical legacy instructions (11 / 13 accounts, no 78)", () => {
    const plan = earnTxPlan(77, ctx({ bound: false }));
    if (!plan.ok) throw new Error("plan");
    const ixs = buildEarnExecuteIxs({ ...common, redeemer: u, redemption: k(), escrow: k(), vaultAuthority: k(), redeemerDest: k(), plan });
    expect(ixs).toHaveLength(1);
    expect(ixs[0].keys).toHaveLength(13);
  });
});
