/**
 * GH#2953: refresh the market's STALE-COHORT portfolios inside the user's own transaction.
 *
 * Every accrual that moves a side's K/F starts a new settlement cohort
 * (engine 35ddd692 v16.rs:871 `kernel_mark_kf_stale_cohorts`):
 *   stale_account_count_<side> = stored_pos_count_<side>
 * and the count only falls as each positioned portfolio is refreshed (v16.rs:896
 * `kernel_settle_kf_stale_cohort`: a leg with kf_epoch_snap < the side's kf_epoch). While
 * either count is non-zero the asset is loss-stale (v16.rs:7558 `asset_is_loss_stale_at_slot`)
 * and `trade_preflight_risk_gate` (v16.rs:22593, called at :16716) refuses EVERY
 * risk-increasing trade with LockActive -> wrapper Custom(21) EngineLockActive. Strict
 * reductions still pass.
 *
 * The keeper refreshes every positioned portfolio right after its accrual, in ONE transaction
 * (percolator-oracle-keeper `positioned-refresh.ts`). A refresh costs ~110-129k CU, so once a
 * market has more positioned portfolios than fit one 1.4M-CU transaction the last ones are never
 * refreshed and the market stays loss-stale indefinitely: Percolator 9EPm8nB8 since 2026-10-02
 * 18:55 UTC, 12 positioned portfolios, 2 stale long legs (FebDwbxR, J43pWxNZ), every new
 * position refused 21 while the keeper reported the market healthy.
 *
 * A refresh is a PermissionlessCrank with NO observation (the engine picks RefreshAccount for a
 * stale account from committed state); anyone may send it, it moves no tokens, and the engine
 * refuses it (EngineNonProgress 22) unless the account really is stale and nothing is pending.
 * Putting the few stale portfolios' refreshes in front of the user's trade clears the gate for
 * that trade. Measured live (devnet, 2026-10-02, the app's own first-trade builders): the
 * unchanged first trade refused 21 in 6/6 rounds; with the stale refreshes prepended it passed
 * the 21 gate in 8/10 rounds (the other 2 were a refresh refused 22 mid-keeper-cycle).
 * Only used when the user's transaction already failed 19/21; never guesses.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import {
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  V17_PORTFOLIO_ACCOUNT_LEN,
  buildAccountMetas,
  buildIx,
  encodePermissionlessCrank,
  parsePortfolioV17,
} from "@percolatorct/sdk";
import { OWNER_PORTFOLIO_MAGIC, OWNER_PORTFOLIO_MARKET_OFF } from "@/lib/owner-portfolio";

// ── Layout (deployed dump_layout; same table as lib/self-heal.ts) ────────────
const MARKET_GROUP_OFF = 592;
const MARKET_GROUP_LEN = 758;
const ASSET_WRAPPER_LEN = 1024;
const MARKET_ASSET_SLOT_LEN = 2325;
/** AssetStateV16Account: kf_epoch_long/short u64 @145/@153 (after k/f long/short i128 @81..@145). */
const AS_KF_EPOCH = [145, 153] as const;
/** AssetStateV16Account: stale_account_count_long/short u64 @337/@345. */
const AS_STALE = [337, 345] as const;

/** A refresh crank, measured live 110-129k CU (keeper REFRESH_CRANK_CU budgets 130k). */
export const STALE_REFRESH_CU = 130_000;
/** Most refreshes put in one user transaction (CU + size headroom for the trade itself). */
export const MAX_STALE_REFRESHES = 4;

export interface StaleCohort {
  /** kf_epoch per side (0 = long, 1 = short). */
  kfEpoch: [bigint, bigint];
  /** stale_account_count per side. */
  stale: [bigint, bigint];
}

function view(d: Uint8Array): DataView {
  return new DataView(d.buffer, d.byteOffset, d.byteLength);
}

/** Asset `assetIndex`'s cohort state, or null when the account is too short. */
export function decodeStaleCohort(market: Uint8Array, assetIndex = 0): StaleCohort | null {
  const e = MARKET_GROUP_OFF + MARKET_GROUP_LEN + assetIndex * MARKET_ASSET_SLOT_LEN + ASSET_WRAPPER_LEN;
  if (market.length < e + AS_STALE[1] + 8) return null;
  const dv = view(market);
  return {
    kfEpoch: [dv.getBigUint64(e + AS_KF_EPOCH[0], true), dv.getBigUint64(e + AS_KF_EPOCH[1], true)],
    stale: [dv.getBigUint64(e + AS_STALE[0], true), dv.getBigUint64(e + AS_STALE[1], true)],
  };
}

export function hasStaleCohort(c: StaleCohort | null): boolean {
  return !!c && (c.stale[0] > 0n || c.stale[1] > 0n);
}

export interface LegView {
  active: boolean;
  assetIndex: number;
  /** 0 = long, 1 = short. */
  side: number;
  kfEpochSnap: bigint;
}

/**
 * The portfolios holding a leg on `assetIndex` whose kf_epoch_snap is behind its side's epoch:
 * exactly the legs `kernel_settle_kf_stale_cohort` still counts. Deterministic order (input).
 */
export function selectStalePortfolios(
  portfolios: ReadonlyArray<{ pubkey: PublicKey; legs: readonly LegView[] }>,
  cohort: StaleCohort,
  assetIndex = 0,
): PublicKey[] {
  const out: PublicKey[] = [];
  for (const p of portfolios) {
    const stale = p.legs.some(
      (l) => l.active && l.assetIndex === assetIndex && (l.side === 0 || l.side === 1) && l.kfEpochSnap < cohort.kfEpoch[l.side as 0 | 1],
    );
    if (stale) out.push(p.pubkey);
  }
  return out;
}

/** PermissionlessCrank with no observation: [cranker(s,w), market(w), portfolio(w)]. */
export function buildStaleRefreshIx(programId: PublicKey, cranker: PublicKey, market: PublicKey, portfolio: PublicKey): TransactionInstruction {
  return buildIx({
    programId,
    keys: buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [cranker, market, portfolio]),
    data: encodePermissionlessCrank({ nowSlot: 0n, observations: [] }),
  });
}

/**
 * Read every portfolio of `market` and return the stale-cohort ones (at most
 * MAX_STALE_REFRESHES; more than that is the keeper's job, so none are returned).
 */
export async function findStalePortfolios(
  connection: Pick<Connection, "getProgramAccounts">,
  programId: PublicKey,
  market: PublicKey,
  cohort: StaleCohort,
): Promise<PublicKey[]> {
  const accts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [
      { dataSize: V17_PORTFOLIO_ACCOUNT_LEN },
      { memcmp: { offset: 0, bytes: OWNER_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
      { memcmp: { offset: OWNER_PORTFOLIO_MARKET_OFF, bytes: market.toBase58() } },
    ],
  });
  const parsed: { pubkey: PublicKey; legs: LegView[] }[] = [];
  for (const a of accts) {
    try {
      parsed.push({ pubkey: a.pubkey, legs: parsePortfolioV17(new Uint8Array(a.account.data)).legs });
    } catch {
      // not a decodable portfolio: skip
    }
  }
  parsed.sort((x, y) => x.pubkey.toBase58().localeCompare(y.pubkey.toBase58()));
  const stale = selectStalePortfolios(parsed, cohort);
  return stale.length <= MAX_STALE_REFRESHES ? stale : [];
}
