/**
 * The RPC read behind a resolved market's exit (P3 / F-4): the market, its LP-vault registry, the
 * vault-LP state and every portfolio on the market, planned by lib/limits/resolved-exit.ts.
 * Shared by hooks/useResolvedExit (the settled-market panel, "Finish now") and the Earn payout
 * path (hooks/useInsuranceLP), which bundles the viewer's tag-46 top-up into its own tx.
 */
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { deriveLpBackingLedger, deriveVaultAuthority } from "@percolatorct/sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readPortfolioIdentity } from "@/lib/v18-wire";
import { KIND_PORTFOLIO, MARKET_MODE_RESOLVED } from "./constants";
import {
  decodeLpVaultRegistryBound,
  decodeLpVaultRegistryDomain,
  decodeMarketEngineView,
  decodeResolvedMarket,
  decodeResolvedPortfolio,
  decodeTerminalBacking,
  decodeVaultLpState,
} from "./decode";
import { isDevnetV21Enabled } from "@/lib/v21/flag";
import { deriveVaultLpExt } from "@/lib/v21/sdk";
import { deriveLpVaultRegistryPda, deriveVaultLpState } from "./p3-ix";
import { planResolvedExit, type ExitPortfolio, type ExitStep, type ResolvedExitPlan } from "./resolved-exit";
import { exitStepIxs, type ExitIxContext, type ExitPortfolioRef } from "./resolved-exit-ixs";
import { viewerTopupSteps } from "./resolved-topup";
import { harvestableFeeAtoms } from "./vault-tranche";

/** Raw account offset of the portfolio's provenance market group (see hooks/useTrade.ts). */
export const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16;

export interface ResolvedExitSnapshot {
  plan: ResolvedExitPlan;
  ctx: ExitIxContext | null;
  portfolios: ExitPortfolio[];
  bound: boolean;
  nowSlot: bigint;
}

export async function loadResolvedExitSnapshot(p: {
  connection: Connection;
  programId: PublicKey;
  market: PublicKey;
  collateralMint: PublicKey;
  /** Fee payer of the planned steps (the market key when no wallet is connected: read-only). */
  payer: PublicKey | null;
}): Promise<ResolvedExitSnapshot | null> {
  const { connection, programId: prog, market } = p;
  const mi = await connection.getAccountInfo(market, "confirmed");
  if (!mi) return null;
  const md = new Uint8Array(mi.data);
  const m = decodeResolvedMarket(md);
  if (!m || m.mode !== MARKET_MODE_RESOLVED) return { plan: { phase: "not-resolved" }, ctx: null, portfolios: [], bound: false, nowSlot: 0n };

  const registry = deriveLpVaultRegistryPda(prog, market);
  const vaultLpState = deriveVaultLpState(prog, market);
  // Devnet v2.1: the P2b ext (a bound 78 needs it at [7] once it exists); flag-gated, one extra read.
  const extKey = isDevnetV21Enabled() ? deriveVaultLpExt(prog, market) : null;
  const [ri, si, nowSlot, pfs, xi] = await Promise.all([
    connection.getAccountInfo(registry, "confirmed"),
    connection.getAccountInfo(vaultLpState, "confirmed"),
    connection.getSlot("confirmed"),
    connection.getProgramAccounts(prog, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: market.toBase58() } }],
    }),
    extKey ? connection.getAccountInfo(extKey, "confirmed") : Promise.resolve(null),
  ]);
  const rd = ri && ri.owner.equals(prog) ? new Uint8Array(ri.data) : null;
  const bound = rd ? decodeLpVaultRegistryBound(rd) === true : false;
  const domain = rd ? decodeLpVaultRegistryDomain(rd) ?? 0 : 0;
  const st = bound && si && si.owner.equals(prog) ? decodeVaultLpState(new Uint8Array(si.data)) : null;
  const vaultLpKey = st ? new PublicKey(st.lpPortfolio).toBase58() : null;

  const portfolios: ExitPortfolio[] = [];
  const refs = new Map<string, ExitPortfolioRef>();
  for (const { pubkey, account } of pfs) {
    const d = new Uint8Array(account.data);
    if (d[10] !== KIND_PORTFOLIO) continue;
    const view = decodeResolvedPortfolio(d);
    if (!view) continue;
    const owner = new PublicKey(view.owner);
    const key = pubkey.toBase58();
    const isVaultLp = key === vaultLpKey;
    let identity;
    try {
      identity = readPortfolioIdentity(d);
    } catch {
      continue;
    }
    refs.set(key, { owner, ...identity });
    portfolios.push({ key, view, isVaultLp, escrowed: !isVaultLp && !PublicKey.isOnCurve(owner.toBytes()) && !owner.equals(registry) });
  }
  const engine = decodeMarketEngineView(md);
  const plan = planResolvedExit({
    market: m,
    nowSlot: BigInt(nowSlot),
    portfolios,
    boundVault: bound,
    harvestableAtoms: engine ? harvestableFeeAtoms(engine) : null,
    terminalResidualAtoms: decodeTerminalBacking(md, domain)?.residual ?? null,
  });
  const [vaultAuthority] = deriveVaultAuthority(prog, market);
  const ctx: ExitIxContext = {
    payer: p.payer ?? market,
    collateralMint: p.collateralMint,
    vaultToken: getAssociatedTokenAddressSync(p.collateralMint, vaultAuthority, true),
    vaultAuthority,
    programId: prog,
    market,
    portfolios: refs,
    vault:
      bound && st
        ? {
            programId: prog,
            market,
            registry,
            vaultLpState,
            lpPortfolio: new PublicKey(st.lpPortfolio),
            ledger: deriveLpBackingLedger(prog, market, domain)[0],
            siblingLedger: deriveLpBackingLedger(prog, market, domain ^ 1)[0],
            juniorOwner: new PublicKey(st.juniorOwner),
            domain,
            ...(extKey && xi && xi.owner.equals(prog) ? { ext: extKey } : {}),
          }
        : null,
  };
  return { plan, ctx, portfolios, bound, nowSlot: BigInt(nowSlot) };
}

/**
 * The viewer's tag-46 top-up instructions, ready to ride in front of their next transaction on
 * this market: empty unless the market is Resolved, the viewer holds an open (partial) receipt
 * AND the planner can run its 46 now (101 has closed). Each top-up is simulated alone first (the
 * viewer pays; tag 46 pays the OWNER's ATA); a refused one is left out. Never throws: a failed
 * read leaves the user's own tx untouched.
 */
export async function readViewerTopupIxs(p: {
  connection: Connection;
  programId: PublicKey;
  market: PublicKey;
  collateralMint: PublicKey;
  viewer: PublicKey;
  simulate: (ixs: TransactionInstruction[]) => Promise<unknown | null>;
}): Promise<TransactionInstruction[]> {
  try {
    const s = await loadResolvedExitSnapshot({ ...p, payer: p.viewer });
    if (!s || !s.ctx) return [];
    const out: TransactionInstruction[] = [];
    for (const step of viewerTopupSteps(s.plan, s.portfolios, p.viewer)) {
      const ixs = exitStepIxs(step, s.ctx);
      if ((await p.simulate(ixs)) === null) out.push(...ixs);
    }
    return out;
  } catch {
    return [];
  }
}

/** The plan's tag-8 closes of EMPTY portfolios (the vault LP's included), at most `max`. */
export function emptyCloseSteps(plan: ResolvedExitPlan, max: number): Extract<ExitStep, { kind: "close-empty" }>[] {
  if (plan.phase !== "sweep" && plan.phase !== "owner-window") return [];
  const out: Extract<ExitStep, { kind: "close-empty" }>[] = [];
  for (const s of plan.steps) if (s.kind === "close-empty" && out.length < max) out.push(s);
  return out;
}

/** Most tag-8 closes one bundled tx carries (each ~126k CU and 4 accounts; the rest next time). */
export const MAX_PREPENDED_EMPTY_CLOSES = 4;

/**
 * Permissionless tag-8 closes for every EMPTY portfolio still materialized on a Resolved market
 * (F-4: [closer (s), market, portfolio, owner] with the rent to the owner, as the keeper sends them
 * at f43272d). On a Resolved bound market the junior's 102 and a senior's 77 are refused 21 while
 * any empty portfolio is materialized, so these ride in front of that tx and nobody waits on the
 * keeper. Each close is simulated alone first; a refused one is left out. Never throws.
 */
export async function readEmptyCloseIxs(p: {
  connection: Connection;
  programId: PublicKey;
  market: PublicKey;
  collateralMint: PublicKey;
  payer: PublicKey;
  simulate: (ixs: TransactionInstruction[]) => Promise<unknown | null>;
  max?: number;
}): Promise<TransactionInstruction[]> {
  try {
    const s = await loadResolvedExitSnapshot({ ...p, payer: p.payer });
    if (!s || !s.ctx) return [];
    const out: TransactionInstruction[] = [];
    for (const step of emptyCloseSteps(s.plan, p.max ?? MAX_PREPENDED_EMPTY_CLOSES)) {
      const ixs = exitStepIxs(step, s.ctx);
      if ((await p.simulate(ixs)) === null) out.push(...ixs);
    }
    return out;
  } catch {
    return [];
  }
}
