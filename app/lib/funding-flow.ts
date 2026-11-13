/**
 * r10 owner decision 1: the Trade result INCLUDES funding.
 *
 * What the chain keeps. Every time a leg is settled (a trade, a crank, a close) the engine moves the leg's funding into the account and adds it to
 * four lifetime counters on the portfolio (engine v16.rs `record_account_funding_flow`): `funding_{long,short}_{paid,received}_atoms_total`.
 * Funding that has accrued but not yet been settled sits in the asset's per-side index `F` against the leg's snapshot `f_snap`:
 *
 *     pending funding (signed, + = received) = floor(|basis_pos_q| x (F_side_now - f_snap) / (a_basis x POS_SCALE))
 *
 * (engine `leg_kf_delta_components_for_settlement_from_asset`, f_delta). So over a trade's life
 *
 *     funding paid = (counters_now - counters_at_open) + pending paid
 *
 * `counters_at_open` is sampled once, from the account read at the slot of the fill that opened the trade (an open from flat settles nothing,
 * so that read equals the state just before it). Taken together this is exactly the funding the chain moved on the position, to the atom.
 *
 * Not in this figure: holding rent (a per-leg rent index, no lifetime counter) and anything else the engine takes without a counter. The
 * funding counters are the only per-position charge the chain exposes besides the trade fee_atoms the book already carries.
 *
 * Counters are per PORTFOLIO, not per leg: a sample is only meaningful when the portfolio holds no leg other than the one being followed, so
 * the sample carries the active-leg count and callers check it.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { parsePortfolio } from "@/lib/v22/layout";
import type { AssetSettleState, RiskLegSnap } from "@/lib/risk-entry";

const POS_SCALE = 1_000_000n;

export interface FundingSample {
  /** Lifetime funding paid minus funding received on this portfolio, atoms (positive = the account has paid more than it received). */
  netPaid: bigint;
  /** Active legs the portfolio holds when sampled. */
  legs: number;
}

interface FundingCounters {
  fundingLongPaidAtomsTotal: bigint;
  fundingLongReceivedAtomsTotal: bigint;
  fundingShortPaidAtomsTotal: bigint;
  fundingShortReceivedAtomsTotal: bigint;
  legs: readonly { active: boolean }[];
}

export function fundingSampleOf(p: FundingCounters): FundingSample {
  // A decoder that left a counter out must not read as zero funding: refuse (callers treat a throw as "not read").
  for (const v of [p.fundingLongPaidAtomsTotal, p.fundingLongReceivedAtomsTotal, p.fundingShortPaidAtomsTotal, p.fundingShortReceivedAtomsTotal]) {
    if (typeof v !== "bigint") throw new Error("funding counter missing");
  }
  return {
    netPaid: p.fundingLongPaidAtomsTotal + p.fundingShortPaidAtomsTotal - p.fundingLongReceivedAtomsTotal - p.fundingShortReceivedAtomsTotal,
    legs: p.legs.filter((l) => l.active).length,
  };
}

/** The account-carried net funding counter (atoms), so every surface can reach it from the Account it already holds. */
export interface FundingCarrier {
  fundingNetPaidAtoms?: bigint | null;
}
export function fundingFields(p: FundingCounters): { fundingNetPaidAtoms?: bigint } {
  try {
    return { fundingNetPaidAtoms: fundingSampleOf(p).netPaid };
  } catch {
    return {}; // not carried: the funding so far is then unknown
  }
}
export function fundingNetOf(account: unknown): bigint | null {
  if (account === null || typeof account !== "object") return null;
  const v = (account as FundingCarrier).fundingNetPaidAtoms;
  return typeof v === "bigint" ? v : null;
}

/**
 * Funding accrued on a leg but not yet settled, as atoms PAID (negative = received). Null when it cannot be known exactly: the leg is on an
 * older ADL epoch than the side's current one (the engine would use the epoch-start index), is stale, or an input is missing.
 *
 * The K/F stale-cohort epoch (`kf_epoch_snap` vs the side's `kf_epoch`) is NOT a condition. The engine moves the side's kf_epoch on every
 * accrual (kernel_mark_kf_stale_cohorts) and settles a lagging leg against the same target, F_now (kf_target_for_leg_from_asset checks only
 * the ADL epoch), so the pending figure is exact either way. Requiring it made this null after nearly every crank of the market, and the close
 * estimate flipped to "excl. funding" at random (Council r10 recheck).
 */
export function pendingFundingPaidAtoms(
  asset: AssetSettleState | null | undefined,
  leg: RiskLegSnap | null | undefined,
  basisQ: bigint,
  aBasis: bigint,
): bigint | null {
  if (!asset || !leg || aBasis <= 0n || basisQ === 0n) return null;
  if (leg.stale) return null;
  const long = leg.side === 0;
  if (!long && leg.side !== 1) return null;
  if (leg.epochSnap !== (long ? asset.epochLong : asset.epochShort)) return null;
  const fNow = long ? asset.fLong : asset.fShort;
  const d = fNow - leg.fSnap;
  if (d === 0n) return 0n;
  const basisAbs = basisQ < 0n ? -basisQ : basisQ;
  const den = aBasis * POS_SCALE;
  const num = basisAbs * d;
  // floor division for a signed numerator (the engine floors the signed delta)
  const delta = num >= 0n ? num / den : -((-num + den - 1n) / den);
  return -delta;
}

/** Funding paid over a trade so far: what was settled since the trade opened plus what is pending. Null when either part is unknown. */
export function fundingPaidSoFar(base: bigint | null | undefined, netNow: bigint | null | undefined, pending: bigint | null | undefined): bigint | null {
  if (base == null || netNow == null || pending == null) return null;
  return netNow - base + pending;
}

/** Waits between attempts when a funding read fails (a busy public RPC answers 429 for a moment). Three retries, about 3 s in all. */
export const FUNDING_READ_RETRY_MS: readonly number[] = [300, 900, 1800];

/**
 * Runs `read` and, while it answers null, tries again after each delay (backoff). Null after the last try: the read failed and the caller claims
 * no figure. A throw counts as null. `sleep` is a test seam.
 */
export async function retryFundingRead<T>(
  read: () => Promise<T | null>,
  delaysMs: readonly number[] = FUNDING_READ_RETRY_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T | null> {
  for (let i = 0; ; i++) {
    let out: T | null = null;
    try {
      out = await read();
    } catch {
      out = null;
    }
    if (out !== null || i >= delaysMs.length) return out;
    await sleep(delaysMs[i]);
  }
}

/**
 * Samples the portfolio's funding counters at (or after) `slot`. The pinned slot means a node that has not seen the fill yet refuses instead of
 * handing back the state before it. A failed read is retried with backoff (rate limits pass). Null once the retries fail: the caller then claims
 * no funding figure.
 */
export async function readFundingSample(
  connection: Pick<Connection, "getAccountInfo">,
  portfolio: PublicKey,
  slot: number,
  delaysMs: readonly number[] = FUNDING_READ_RETRY_MS,
  sleep?: (ms: number) => Promise<void>,
): Promise<FundingSample | null> {
  return retryFundingRead(
    async () => {
      const info = await connection.getAccountInfo(portfolio, { commitment: "confirmed", minContextSlot: slot });
      if (!info) return null;
      return fundingSampleOf(parsePortfolio(new Uint8Array(info.data)));
    },
    delaysMs,
    sleep,
  );
}
