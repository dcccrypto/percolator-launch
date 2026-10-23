// @vitest-environment node
/**
 * #3602: on v2.2 the wrapper requires the bond tranche on tag 78 (at [9], [8] writable) and the InsuranceUnits account
 * on tag 101 (at [12]), and fails closed without them. The resolved sweep builds both with exitStepIxs and simulates
 * them (run, finish) and signs them (finish) outside sendTx, the only place the tails were added, so on a bond /
 * ins_units market the harvest and the vault-LP settle were refused in simulation and dropped. The tails now ride on
 * the instruction context, and exitStepIxs applies them.
 */
import { describe, expect, it } from "vitest";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { exitStepIxs, type ExitIxContext } from "@/lib/limits/resolved-exit-ixs";
import { buildFinishTxs } from "@/lib/limits/resolved-finish";
import { deriveBondTrancheV22, deriveInsuranceUnitsV22 } from "@/lib/v22/sdk";

const k = (): PublicKey => Keypair.generate().publicKey;
const prog = k();
const market = k();
const tranche = deriveBondTrancheV22(prog, market)[0];
const units = deriveInsuranceUnitsV22(prog, market)[0];

const ctx = (tails?: ExitIxContext["tails"]): ExitIxContext => ({
  payer: k(), collateralMint: k(), vaultToken: k(), vaultAuthority: k(), programId: prog, market,
  portfolios: new Map(),
  vault: { programId: prog, market, registry: k(), vaultLpState: k(), lpPortfolio: k(), ledger: k(), siblingLedger: k(), ext: k(), juniorOwner: k(), domain: 0 },
  ...(tails ? { tails } : {}),
});
const tag = (ixs: ReturnType<typeof exitStepIxs>, t: number) => ixs.find((i) => i.data[0] === t)!;
const settle = { kind: "settle-vault-lp", topup: 0 } as const;

describe("#3602: the resolved sweep's 78 and 101 carry the v2.2 market tails", () => {
  it("harvest (78) on a bond market: the tranche at [9], [8] writable", () => {
    const ix = tag(exitStepIxs({ kind: "harvest" }, ctx({ bondTranche: tranche, insuranceUnits: null })), 78);
    expect(ix.keys).toHaveLength(10);
    expect(ix.keys[9].pubkey.equals(tranche)).toBe(true);
    expect(ix.keys[8].isWritable).toBe(true);
  });

  it("vault-LP settle (101) on an ins_units market: the units account at [12]", () => {
    const ix = tag(exitStepIxs(settle, ctx({ bondTranche: null, insuranceUnits: units })), 101);
    expect(ix.keys).toHaveLength(13);
    expect(ix.keys[12].pubkey.equals(units)).toBe(true);
  });

  it("Finish now's pre-signed transactions carry the same tails", () => {
    const c = ctx({ bondTranche: tranche, insuranceUnits: units });
    const txs = buildFinishTxs([{ step: { kind: "harvest" }, copy: 0 }, { step: settle, copy: 0 }], c, null, { blockhash: "11111111111111111111111111111111", priorityFeeMicroLamports: 1000, feePayer: c.payer });
    const ixs = txs.flatMap((t) => t.instructions);
    expect(tag(ixs, 78).keys.some((m) => m.pubkey.equals(tranche))).toBe(true);
    expect(tag(ixs, 101).keys.some((m) => m.pubkey.equals(units))).toBe(true);
    for (const t of txs) expect(t.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBeLessThanOrEqual(1232);
  });

  it("a 78 that can't take the tranche (no vault_lp_ext: v2.2 on without v2.1) stays as built, not a thrown sweep", () => {
    const c = ctx({ bondTranche: tranche, insuranceUnits: null });
    c.vault = { ...c.vault!, ext: undefined };
    const ix = tag(exitStepIxs({ kind: "harvest" }, c), 78);
    expect(ix.keys).toHaveLength(7);
    expect(ix.keys.some((m) => m.pubkey.equals(tranche))).toBe(false);
  });

  it("CONTROL: no tails on the context (flag off, or a market without those accounts) leaves both lists as built", () => {
    expect(tag(exitStepIxs({ kind: "harvest" }, ctx()), 78).keys).toHaveLength(9);
    expect(tag(exitStepIxs(settle, ctx()), 101).keys).toHaveLength(12);
  });
});
