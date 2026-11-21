/**
 * P3-L2 client self-repair (security review P3-D2/L2): Earn deposits (tag 75) and
 * redemptions (76/77) on a vault-owned-LP market must VALUE the vault LP whenever the
 * backing does not cover the senior; with a stale health certificate the program
 * refuses `VaultLpValuationStale` (P3 Custom(85): "Prepend a permissionless crank
 * (tag 5) of the vault LP"). This prepends that crank into the USER'S OWN transaction —
 * the same pattern as P0b's tags 89/45 (lib/self-heal.ts) — and only when needed:
 *
 *   1. read the market + the bound vault LP portfolio; if there is no bound vault LP, or
 *      its valuation is not stale (`vaultLpValueAtoms`), stop (no extra RPC beyond the read);
 *   2. simulate the user's instructions unchanged; ok => unchanged;
 *   3. only on a WRAPPER-originated Custom(VaultLpValuationStale): prepend the crank,
 *      re-simulate; keep it only if the 85 is gone.
 * Any RPC failure => unchanged. Kill switch: NEXT_PUBLIC_VAULT_LP_SELF_HEAL=0 (the P0b
 * switch NEXT_PUBLIC_SELF_HEAL=0 turns this off too).
 *
 * The crank: PermissionlessCrank (tag 5) `[cranker, market (w), portfolio (w), ...oracle
 * tail]` — the same builder useTrade uses for the taker's own portfolio, pointed at the
 * vault LP portfolio. Account 0 is not required to sign by the handler; the user wallet is
 * passed as the cranker (it is the fee payer anyway).
 */
import { PublicKey, Transaction, VersionedTransaction, type AccountMeta, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { ACCOUNTS_PERMISSIONLESS_CRANK_BASE, buildAccountMetas, buildIx, encodePermissionlessCrank } from "@percolatorct/sdk";
import { computeBudgetPrefix, parseCustomInstructionError, REPAIR_CU, type SimResult } from "@/lib/self-heal";
import { isSelfHealEnabled } from "@/lib/self-heal";
import { P3_ERR } from "./constants";
import { decodeAssetVaultLp, decodeMarketEngineView, decodePortfolioRisk } from "./decode";
import { vaultLpValueAtoms } from "./vault-tranche";

const MAX_TX_CU = 1_400_000;

export function isVaultLpSelfHealEnabled(): boolean {
  if (!isSelfHealEnabled()) return false;
  const v = process.env.NEXT_PUBLIC_VAULT_LP_SELF_HEAL?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** True iff the sim failed with Custom(VaultLpValuationStale) raised by a WRAPPER instruction. */
export function isValuationStaleFailure(
  err: unknown,
  txInstructions: readonly TransactionInstruction[],
  wrapperProgramId: PublicKey,
): boolean {
  const p = parseCustomInstructionError(err);
  if (!p || p.code !== P3_ERR.VaultLpValuationStale) return false;
  const ix = txInstructions[p.index];
  return !!ix && ix.programId.equals(wrapperProgramId);
}

export function buildVaultLpCrankIx(
  programId: PublicKey,
  cranker: PublicKey,
  market: PublicKey,
  vaultLp: PublicKey,
  oracleTail: readonly AccountMeta[] = [],
  assetIndex = 0,
): TransactionInstruction {
  // The hint must CLAIM the oracle accounts it carries: the program rejects a crank whose tail
  // is not fully consumed by the hints (InvalidInstruction), so a Pyth tail with a 0-account
  // hint (defaultCrankObservations) made every Pyth-market repair crank fail.
  const keys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [cranker, market, vaultLp]);
  for (const k of oracleTail) keys.push(k);
  return buildIx({
    programId,
    keys,
    data: encodePermissionlessCrank({ nowSlot: 0n, observations: [{ assetIndex, oracleAccounts: oracleTail.length }] }),
  });
}

export interface VaultLpRepairDeps {
  /** Market + (when bound) vault LP portfolio bytes; null entries when missing. */
  readMarket: () => Promise<Uint8Array | null>;
  readPortfolio: (pk: PublicKey) => Promise<Uint8Array | null>;
  simulate: (instructions: TransactionInstruction[]) => Promise<SimResult>;
}

export interface VaultLpRepairParams {
  programId: PublicKey;
  market: PublicKey;
  cranker: PublicKey;
  instructions: TransactionInstruction[];
  computeUnits: number;
  oracleTail?: readonly AccountMeta[];
  assetIndex?: number;
}

export type VaultLpRepairOutcome =
  | "disabled"
  | "not-bound"
  | "valuation-current"
  | "user-tx-ok"
  | "not-repairable"
  | "repaired"
  | "repair-did-not-help"
  | "rpc-error";

export interface VaultLpRepairResult {
  instructions: TransactionInstruction[];
  computeUnits: number;
  outcome: VaultLpRepairOutcome;
}

/** See the module header. Never throws. */
export async function planVaultLpRepair(p: VaultLpRepairParams, deps: VaultLpRepairDeps): Promise<VaultLpRepairResult> {
  const unchanged = (outcome: VaultLpRepairOutcome): VaultLpRepairResult => ({
    instructions: p.instructions,
    computeUnits: p.computeUnits,
    outcome,
  });
  if (!isVaultLpSelfHealEnabled()) return unchanged("disabled");
  try {
    const m = await deps.readMarket();
    if (!m) return unchanged("not-bound");
    const asset = p.assetIndex ?? 0;
    const rec = decodeAssetVaultLp(m, asset);
    const eng = decodeMarketEngineView(m, asset);
    if (!rec?.bound || !eng) return unchanged("not-bound");
    const vaultLp = new PublicKey(rec.vaultLpPortfolio);
    const pf = await deps.readPortfolio(vaultLp);
    const risk = pf ? decodePortfolioRisk(pf) : null;
    if (!risk) return unchanged("not-bound");
    if (vaultLpValueAtoms(risk, eng).kind !== "stale") return unchanged("valuation-current");

    const origList = [...computeBudgetPrefix(p.computeUnits), ...p.instructions];
    const orig = await deps.simulate(origList);
    if (!orig.err) return unchanged("user-tx-ok");
    if (!isValuationStaleFailure(orig.err, origList, p.programId)) return unchanged("not-repairable");

    const crank = buildVaultLpCrankIx(p.programId, p.cranker, p.market, vaultLp, p.oracleTail ?? [], asset);
    const cu = Math.min(MAX_TX_CU, p.computeUnits + REPAIR_CU);
    const healedIxs = [crank, ...p.instructions];
    const healedList = [...computeBudgetPrefix(cu), ...healedIxs];
    const healed = await deps.simulate(healedList);
    if (healed.err && isValuationStaleFailure(healed.err, healedList, p.programId)) return unchanged("repair-did-not-help");
    return { instructions: healedIxs, computeUnits: cu, outcome: "repaired" };
  } catch (e) {
    console.warn("[vault-lp-repair] skipped:", e);
    return unchanged("rpc-error");
  }
}

/** Real-connection deps (same simulate shape as P0b's connectionSelfHealDeps). */
export function connectionVaultLpRepairDeps(connection: Connection, market: PublicKey, payer: PublicKey): VaultLpRepairDeps {
  const read = async (pk: PublicKey) => {
    const info = await connection.getAccountInfo(pk, "confirmed");
    return info ? new Uint8Array(info.data) : null;
  };
  return {
    readMarket: () => read(market),
    readPortfolio: read,
    simulate: async (instructions) => {
      const tx = new Transaction();
      for (const ix of instructions) tx.add(ix);
      tx.feePayer = payer;
      tx.recentBlockhash = PublicKey.default.toBase58();
      const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        replaceRecentBlockhash: true,
        sigVerify: false,
        commitment: "confirmed",
      });
      return { err: sim.value.err };
    },
  };
}

/**
 * sendTx option for an Earn tx (flag P3; undefined = off). The crank's oracle tail
 * follows useTrade exactly: Pyth-pinned markets pass the Pyth push-oracle PDA,
 * admin/hyperp (AUTH_MARK) markets pass none.
 */
export function earnVaultLpRepairOption(
  p3Enabled: boolean,
  programId: PublicKey,
  market: PublicKey,
  pythFeedAccount: PublicKey | null,
): { programId: PublicKey; market: PublicKey; oracleTail: AccountMeta[] } | undefined {
  if (!p3Enabled) return undefined;
  return {
    programId,
    market,
    oracleTail: pythFeedAccount ? [{ pubkey: pythFeedAccount, isSigner: false, isWritable: false }] : [],
  };
}

/**
 * The PermissionlessCrank oracle tail, exactly as useTrade builds it: a Pyth-pinned
 * market passes its Pyth push-oracle PDA; admin/hyperp (AUTH_MARK) markets pass none.
 */
export function crankOracleTail(pythFeedAccount: PublicKey | null): AccountMeta[] {
  return pythFeedAccount ? [{ pubkey: pythFeedAccount, isSigner: false, isWritable: false }] : [];
}
