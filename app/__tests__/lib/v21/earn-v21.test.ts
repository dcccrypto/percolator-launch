// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as ix from "@/lib/limits/p3-ix";
import { buildEarnExecuteIxs, buildEarnDepositIxs, earnTxPlan, type EarnP3Context } from "@/lib/limits/earn-ixs";
import { readEarnP3Context } from "@/lib/limits/earn-p3-read";
import { recallIxFor77 } from "@/lib/limits/senior-draw-repair";
import { MARKET_MODE_LIVE, TAG_EXECUTE_REDEMPTION, TAG_LP_VAULT_CRANK_FEES } from "@/lib/limits/constants";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { deriveVaultLpExt } from "@/lib/v21/sdk";
import { registryBytes, vaultLpStateBytes } from "./fixtures";

const k = () => Keypair.generate().publicKey;
const PROG = k();
const MARKET = k();
const EXT = deriveVaultLpExt(PROG, MARKET);
const m: ix.VaultLpMarket = {
  programId: PROG, market: MARKET, registry: ix.deriveLpVaultRegistryPda(PROG, MARKET), vaultLpState: ix.deriveVaultLpState(PROG, MARKET),
  lpPortfolio: k(), ledger: k(), siblingLedger: k(),
};
const flags = (i: { keys: { isSigner: boolean; isWritable: boolean }[] }) => i.keys.map((x) => `${x.isSigner ? "s" : "-"}${x.isWritable ? "w" : "-"}`).join(" ");
const ctx = (o: Partial<EarnP3Context> = {}): EarnP3Context => ({
  bound: true, vaultLpState: m.vaultLpState, lpPortfolio: m.lpPortfolio, harvestable: 0n, registryShares: 1_000n, mode: MARKET_MODE_LIVE, ...o,
});
afterEach(() => __setDevnetV21ForTest(null));

describe("tag 77: [12] is the wallet, as a signer (security review condition)", () => {
  const u = k();
  const common = { programId: PROG, market: MARKET, registry: m.registry, lpMint: k(), vaultToken: k(), ledger: m.ledger, siblingLedger: m.siblingLedger, domain: 0 };
  it("non-bound and bound: 13 / 15 accounts, [12] == redeemer, signer + writable, [0] the same key", () => {
    for (const bound of [false, true]) {
      const plan = earnTxPlan(77, ctx({ bound }));
      if (!plan.ok) throw new Error("plan");
      const ixs = buildEarnExecuteIxs({ ...common, redeemer: u, redemption: k(), escrow: k(), vaultAuthority: k(), redeemerDest: k(), plan });
      const e = ixs[ixs.length - 1];
      expect(e.keys).toHaveLength(bound ? 15 : 13);
      expect(e.keys[12]).toEqual({ pubkey: u, isSigner: true, isWritable: true });
      expect(e.keys[0].pubkey.equals(u)).toBe(true);
      expect(e.keys[0].isSigner).toBe(true);
    }
  });
});

describe("tag 78 once the P2b ext exists: [7] ext (w) + [8] the vault LP", () => {
  const c = k();
  const base = { programId: PROG, cranker: c, market: MARKET, registry: m.registry, ledger: m.ledger, siblingLedger: m.siblingLedger, domain: 0 };
  it("without the ext it is today's 7-account list", () => {
    const i = ix.buildLpVaultCrankFeesIx({ ...base, bound: { vaultLpState: m.vaultLpState } });
    expect(i.keys).toHaveLength(7);
  });
  it("with the ext: 9 accounts, ext writable at [7], the LP read-only at [8]", () => {
    const i = ix.buildLpVaultCrankFeesIx({ ...base, bound: { vaultLpState: m.vaultLpState, ext: EXT, lpPortfolio: m.lpPortfolio } });
    expect(i.keys).toHaveLength(9);
    expect(i.keys[7]).toEqual({ pubkey: EXT, isSigner: false, isWritable: true });
    expect(i.keys[8]).toEqual({ pubkey: m.lpPortfolio, isSigner: false, isWritable: false });
    expect(flags(i)).toBe("sw -w -w -w -w -- -w -w --");
  });
  it("an ext without the LP is refused before signing", () => {
    expect(() => ix.buildLpVaultCrankFeesIx({ ...base, bound: { vaultLpState: m.vaultLpState, ext: EXT } })).toThrow(/vault LP portfolio/);
  });
  it("the earn plan carries the ext into the harvest it prepends (77 and 75-at-genesis)", () => {
    const u = k();
    const common = { programId: PROG, market: MARKET, registry: m.registry, lpMint: k(), vaultToken: k(), ledger: m.ledger, siblingLedger: m.siblingLedger, domain: 0 };
    const p77 = earnTxPlan(77, ctx({ harvestable: 3n, vaultLpExt: EXT }));
    if (!p77.ok) throw new Error("plan");
    const ixs = buildEarnExecuteIxs({ ...common, redeemer: u, redemption: k(), escrow: k(), vaultAuthority: k(), redeemerDest: k(), plan: p77 });
    expect(ixs.map((i) => i.data[0])).toEqual([TAG_LP_VAULT_CRANK_FEES, TAG_EXECUTE_REDEMPTION]);
    expect(ixs[0].keys).toHaveLength(9);
    expect(ixs[0].keys[7].pubkey.equals(EXT)).toBe(true);
    expect(ixs[1].keys).toHaveLength(15); // 77 itself does NOT take the ext
    const p75 = earnTxPlan(75, ctx({ harvestable: 3n, registryShares: 0n, vaultLpExt: EXT }));
    if (!p75.ok) throw new Error("plan");
    const d = buildEarnDepositIxs({ ...common, depositor: u, depositorLpAta: k(), sourceToken: k(), amount: 5n, plan: p75 });
    expect(d[0].keys).toHaveLength(9);
    expect(d[1].keys).toHaveLength(13);
  });
  it("no ext in the context => exactly today's plan", () => {
    const a = earnTxPlan(77, ctx({ harvestable: 3n }));
    expect(a).toEqual({ ok: true, tail: { vaultLpState: m.vaultLpState, lpPortfolio: m.lpPortfolio }, prependHarvest: true });
  });
});

describe("97 and 98 take the ext (fail closed) once it exists", () => {
  it("98 recall: [8] ext; 97 withdraw junior: [11] ext; both unchanged without it", () => {
    const c = k();
    expect(ix.buildVaultLpRecallIx(m, c, 1n, 0).keys).toHaveLength(8);
    const r = ix.buildVaultLpRecallIx({ ...m, ext: EXT }, c, 1n, 0);
    expect(r.keys).toHaveLength(9);
    expect(r.keys[8]).toEqual({ pubkey: EXT, isSigner: false, isWritable: true });
    const a = ix.buildWithdrawJuniorTrancheIx(m, c, k(), k(), k(), 1n);
    expect(a.keys).toHaveLength(11);
    const b = ix.buildWithdrawJuniorTrancheIx({ ...m, ext: EXT }, c, k(), k(), k(), 1n);
    expect(b.keys).toHaveLength(12);
    expect(b.keys[11].pubkey.equals(EXT)).toBe(true);
  });
  it("the recall built from a bound 77 follows the ext when it is given", () => {
    const u = k();
    const plan = earnTxPlan(77, ctx());
    if (!plan.ok) throw new Error("plan");
    const e = buildEarnExecuteIxs({ programId: PROG, market: MARKET, registry: m.registry, lpMint: k(), vaultToken: k(), ledger: m.ledger, siblingLedger: m.siblingLedger, domain: 0, redeemer: u, redemption: k(), escrow: k(), vaultAuthority: k(), redeemerDest: k(), plan }).pop()!;
    expect(recallIxFor77(e, u, 5n).keys).toHaveLength(8);
    expect(recallIxFor77(e, u, 5n, EXT).keys).toHaveLength(9);
  });
});

describe("readEarnP3Context: the ext lookup is flag-gated and rides the same batched read", () => {
  const conn = (withExt: boolean) => {
    const calls: unknown[][] = [];
    const owner = PROG;
    const c = {
      getMultipleAccountsInfo: vi.fn(async (keys: unknown[]) => {
        calls.push(keys);
        const infos = [
          { owner, data: Buffer.alloc(4000) },
          { owner, data: Buffer.from(registryBytes({ bound: true })) },
          { owner, data: Buffer.from(vaultLpStateBytes(m.lpPortfolio.toBytes())) },
        ];
        if (keys.length === 4) infos.push(withExt ? { owner, data: Buffer.alloc(144) } : (null as never));
        return infos;
      }),
    };
    return { c: c as never, calls };
  };
  it("flag OFF: three keys, no ext field (today's read, unchanged)", async () => {
    __setDevnetV21ForTest(false);
    const { c, calls } = conn(true);
    const r = await readEarnP3Context(c, PROG, MARKET);
    expect(calls[0]).toHaveLength(3);
    expect("vaultLpExt" in r).toBe(false);
  });
  it("flag ON: four keys; the ext appears only when the account exists", async () => {
    __setDevnetV21ForTest(true);
    const a = conn(true);
    expect((await readEarnP3Context(a.c, PROG, MARKET)).vaultLpExt?.equals(EXT)).toBe(true);
    expect(a.calls[0]).toHaveLength(4);
    const b = conn(false);
    expect("vaultLpExt" in (await readEarnP3Context(b.c, PROG, MARKET))).toBe(false);
  });
});
