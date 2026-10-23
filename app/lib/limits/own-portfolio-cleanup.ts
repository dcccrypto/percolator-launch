/**
 * E2E B12 (HIGH) follow-up, app side: CloseSlab (reclaim) and the stake terminal recovery need
 * a terminal-flat market — `materialized_portfolio_count == 0` — and CloseResolved (30) empties
 * a portfolio but does NOT dematerialize it; only ClosePortfolio (8) does. So the creator's
 * own portfolios (at least the wizard's LP) block the reclaim until the creator closes them.
 *
 * For each portfolio the CONNECTED WALLET owns on a RESOLVED market, owner-signed:
 *   not empty            -> [30 CloseResolved (pays the owner's ATA), 8 ClosePortfolio]
 *   payout receipt open  -> [46 ClaimResolvedPayoutTopup, 8]
 *   empty                -> [8]
 * The caller simulates each group and falls back to the group WITHOUT the trailing 8 (a
 * winner's resolved close is progress-only until its loser settles, so the 8 can fail in the
 * same tx); anything still refused is reported, never retried blindly. Other users'
 * portfolios are out of scope here (tag 8 by a non-owner is Custom(8) on v18.2; the relaunch
 * wrapper's F-4 path is what `useResolvedExit` uses).
 * Wire: deployed v18.2 6377376a / P3 final — tag 8 [closer (s,w), market (w), portfolio (w)]
 * + identity [8, pid u64, seq u64, pep u64]; tag 30/46 [owner (s), market (w), portfolio (w),
 * owner ATA (w), vault token (w), vault authority, token program, NftRegistry].
 */
import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { KIND_PORTFOLIO, TAG_CLAIM_RESOLVED_PAYOUT_TOPUP, TAG_CLOSE_RESOLVED } from "./constants";
import { decodeResolvedMarket, decodeResolvedPortfolio } from "./decode";
import { readPortfolioIdentity } from "@/lib/v18-wire";
import { computeBudgetPrefix, connectionSelfHealDeps } from "@/lib/self-heal";
import { buildPermissionlessResolvedIx, encodeClosePortfolio } from "./p3-ix";
import { looksEmpty } from "./resolved-exit";
import type { ResolvedPortfolioView } from "./decode";

export interface OwnPortfolio {
  key: PublicKey;
  view: ResolvedPortfolioView;
  portfolioId: bigint;
  matcherSequence: bigint;
  positionEpoch: bigint;
}

export interface OwnCleanupGroup {
  portfolio: PublicKey;
  kind: "close-resolved" | "claim-topup" | "close-empty";
  /** Full group (ends with tag 8). */
  withClose: TransactionInstruction[];
  /** Fallback without the trailing 8 (null for close-empty). */
  withoutClose: TransactionInstruction[] | null;
}

export function ownerClosePortfolioIx(
  programId: PublicKey,
  owner: PublicKey,
  market: PublicKey,
  p: Pick<OwnPortfolio, "key" | "portfolioId" | "matcherSequence" | "positionEpoch">,
): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: p.key, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(encodeClosePortfolio(p.portfolioId, p.matcherSequence, p.positionEpoch)),
  });
}

/**
 * [create owner ATA (idempotent), 30 CloseResolved | 46 ClaimResolvedPayoutTopup] in the OWNER-SIGNED form: [owner (s), market (w),
 * portfolio (w), owner ATA (w), vault token (w), vault authority, token program] (wrapper `handle_close_resolved`,
 * percolator-prog 1b9ee2af / aca02ba6: accounts 0..6; the NftRegistry at [7] is the unsigned-caller proof and harmless here).
 * The owner signs, so it works inside the owner-only window too (before `resolved_slot + force_close_delay_slots`).
 */
export function ownResolvedPayIxs(
  c: { programId: PublicKey; owner: PublicKey; market: PublicKey; collateralMint: PublicKey; vaultToken: PublicKey; vaultAuthority: PublicKey },
  portfolio: PublicKey,
  tag: typeof TAG_CLOSE_RESOLVED | typeof TAG_CLAIM_RESOLVED_PAYOUT_TOPUP,
): [TransactionInstruction, TransactionInstruction] {
  const ata = getAssociatedTokenAddressSync(c.collateralMint, c.owner);
  const pay = buildPermissionlessResolvedIx({
    tag,
    programId: c.programId,
    owner: c.owner,
    market: c.market,
    portfolio,
    ownerAta: ata,
    vaultToken: c.vaultToken,
    vaultAuthority: c.vaultAuthority,
  });
  pay.keys[0] = { pubkey: c.owner, isSigner: true, isWritable: false };
  return [createAssociatedTokenAccountIdempotentInstruction(c.owner, ata, c.owner, c.collateralMint), pay];
}

/** The wallet's OWN portfolios on a market (decoded for the resolved exit), read from chain. */
export async function loadOwnPortfolios(connection: Connection, programId: PublicKey, market: PublicKey, owner: PublicKey): Promise<OwnPortfolio[]> {
  const accts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 16, bytes: market.toBase58() } }],
  });
  const own: OwnPortfolio[] = [];
  for (const { pubkey, account } of accts) {
    const d = new Uint8Array(account.data);
    if (d[10] !== KIND_PORTFOLIO) continue;
    const view = decodeResolvedPortfolio(d);
    if (!view || !new PublicKey(view.owner).equals(owner)) continue;
    try {
      own.push({ key: pubkey, view, ...readPortfolioIdentity(d) });
    } catch {
      // not a v18 portfolio this wire can address
    }
  }
  return own;
}

export function planOwnPortfolioCleanup(c: {
  programId: PublicKey;
  owner: PublicKey;
  market: PublicKey;
  collateralMint: PublicKey;
  vaultToken: PublicKey;
  vaultAuthority: PublicKey;
  portfolios: readonly OwnPortfolio[];
}): OwnCleanupGroup[] {
  const out: OwnCleanupGroup[] = [];
  for (const p of c.portfolios) {
    if (!new PublicKey(p.view.owner).equals(c.owner)) continue;
    const close8 = ownerClosePortfolioIx(c.programId, c.owner, c.market, p);
    if (looksEmpty(p.view)) {
      out.push({ portfolio: p.key, kind: "close-empty", withClose: [close8], withoutClose: null });
      continue;
    }
    const tag = p.view.receiptPresent && !p.view.receiptFinalized ? TAG_CLAIM_RESOLVED_PAYOUT_TOPUP : TAG_CLOSE_RESOLVED;
    const [create, pay] = ownResolvedPayIxs(c, p.key, tag);
    out.push({
      portfolio: p.key,
      kind: tag === TAG_CLOSE_RESOLVED ? "close-resolved" : "claim-topup",
      withClose: [create!, pay!, close8],
      withoutClose: [create!, pay!],
    });
  }
  return out;
}

export interface OwnCleanupDeps {
  simulate(ixs: TransactionInstruction[]): Promise<unknown | null>;
  send(ixs: TransactionInstruction[]): Promise<string>;
}

export interface OwnCleanupResult {
  signatures: string[];
  closed: string[];
  progressOnly: string[];
  refused: { portfolio: string; err: unknown }[];
}

/** Sim-gated: full group, else the group without the trailing 8, else report. */
export async function runOwnPortfolioCleanup(groups: readonly OwnCleanupGroup[], deps: OwnCleanupDeps): Promise<OwnCleanupResult> {
  const r: OwnCleanupResult = { signatures: [], closed: [], progressOnly: [], refused: [] };
  for (const g of groups) {
    const e1 = await deps.simulate(g.withClose);
    if (e1 === null) {
      r.signatures.push(await deps.send(g.withClose));
      r.closed.push(g.portfolio.toBase58());
      continue;
    }
    if (g.withoutClose) {
      const e2 = await deps.simulate(g.withoutClose);
      if (e2 === null) {
        r.signatures.push(await deps.send(g.withoutClose));
        r.progressOnly.push(g.portfolio.toBase58());
        continue;
      }
    }
    r.refused.push({ portfolio: g.portfolio.toBase58(), err: e1 });
  }
  return r;
}

// ── RPC orchestration for useCloseMarket (reclaim on a RESOLVED market) ────────────────────

/** Covers CloseResolved (up to 204k CU on the final wrapper) + ClosePortfolio in one tx. */
export const CLEANUP_CU = 600_000;

export type OwnCleanupOutcome =
  | { ok: true; closed: number; signatures: string[] }
  | { ok: false; reason: "progress-only" | "refused" | "others-remain"; remaining?: bigint; signatures: string[] };

/** Close the wallet's own portfolios on a Resolved market, then say whether CloseSlab can run. */
export async function cleanupOwnPortfoliosBeforeReclaim(p: {
  connection: Connection;
  programId: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  collateralMint: PublicKey;
  vaultToken: PublicKey;
  vaultAuthority: PublicKey;
  send: (ixs: TransactionInstruction[]) => Promise<string>;
}): Promise<OwnCleanupOutcome> {
  const own = await loadOwnPortfolios(p.connection, p.programId, p.market, p.owner);
  const groups = planOwnPortfolioCleanup({ ...p, portfolios: own });
  const sim = connectionSelfHealDeps(p.connection, p.market, p.owner);
  const res = await runOwnPortfolioCleanup(groups, {
    simulate: async (ixs) => (await sim.simulate([...computeBudgetPrefix(CLEANUP_CU), ...ixs])).err ?? null,
    send: p.send,
  });
  if (res.refused.length > 0) return { ok: false, reason: "refused", signatures: res.signatures };
  if (res.progressOnly.length > 0) return { ok: false, reason: "progress-only", signatures: res.signatures };
  const mi = await p.connection.getAccountInfo(p.market, "confirmed");
  const m = mi ? decodeResolvedMarket(new Uint8Array(mi.data)) : null;
  if (m && (m.materializedPortfolioCount !== 0n || m.cTot !== 0n)) {
    return { ok: false, reason: "others-remain", remaining: m.materializedPortfolioCount, signatures: res.signatures };
  }
  return { ok: true, closed: res.closed.length, signatures: res.signatures };
}

/**
 * UX WP-9 (audit §3.11): the same cleanup, PLANNED for the close-market one approval instead of
 * sent. Each group is simulated now; the run can close the market only when every own group
 * closes its portfolio (a progress-only or refused group, or other accounts left, stops it
 * before anything is signed). Returns the instruction lists to sign with the CloseSlab tx.
 */
export async function planOwnCleanupForOneApproval(p: {
  connection: Connection;
  programId: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  collateralMint: PublicKey;
  vaultToken: PublicKey;
  vaultAuthority: PublicKey;
}): Promise<{ ok: true; groups: TransactionInstruction[][] } | { ok: false; reason: "progress-only" | "refused" | "others-remain"; remaining?: bigint }> {
  const own = await loadOwnPortfolios(p.connection, p.programId, p.market, p.owner);
  const groups = planOwnPortfolioCleanup({ ...p, portfolios: own });
  const sim = connectionSelfHealDeps(p.connection, p.market, p.owner);
  const out: TransactionInstruction[][] = [];
  for (const g of groups) {
    const e1 = (await sim.simulate([...computeBudgetPrefix(CLEANUP_CU), ...g.withClose])).err ?? null;
    if (e1 === null) {
      out.push(g.withClose);
      continue;
    }
    const e2 = g.withoutClose ? (await sim.simulate([...computeBudgetPrefix(CLEANUP_CU), ...g.withoutClose])).err ?? null : e1;
    return { ok: false, reason: e2 === null ? "progress-only" : "refused" };
  }
  const mi = await p.connection.getAccountInfo(p.market, "confirmed");
  const m = mi ? decodeResolvedMarket(new Uint8Array(mi.data)) : null;
  const left = m ? m.materializedPortfolioCount - BigInt(out.length) : 0n;
  if (left > 0n) return { ok: false, reason: "others-remain", remaining: left };
  return { ok: true, groups: out };
}
