/**
 * Council r9 delta review MED-A: the busy-side (utilisation) fee for THIS market, side and size, read FRESH from the chain right before an
 * order is signed. It is the same pure computation the ticket quotes with (`growthFor` + `growthTicketDecision`, whose `fee.utilFeeBps` is the
 * ticket's `utilFeeBps`), fed with a fresh read of the slab, the LP portfolio and the clock instead of the ticket's 20 s poll.
 *
 * Why this and not a tighter fee cap: devnet's matcher fee is adaptive (10-80 bps), so one cap cannot tell the matcher's part from the busy
 * part. The cap signed stays the chain cap (as before); this guard is what stops an order whose busy rate rose after the confirm screen.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { PublicKey as Pk } from "@solana/web3.js";
import { growthFor, decodeMarketLevGuard, type LpView } from "@/hooks/useMarketLimits";
import { decodeAssetVaultLp, decodeMarketEngineView, decodePortfolioLegs, decodePortfolioRisk, signedPositionForAsset } from "@/lib/limits/decode";
import { resolveLpAccounts } from "@/lib/limits/lp-discovery";
import { lpEffectiveSignedQ } from "@/lib/limits/lp-inventory-room";
import { decodeGrowthRecord, growthTicketDecision } from "@/lib/v21/growth-market";
import { levGuardPda } from "@/lib/v22/lev-guard";
import { isDevnetV22Enabled } from "@/lib/v22/flag";

export interface BusyGuard {
  /** The busy-side rate (bps) the confirm screen showed. */
  confirmedBusyFeeBps: bigint;
  /** Side of the order. */
  direction: "long" | "short";
  /** The taker's effective position before the order (signed), as the ticket quoted from. */
  takerEffQ: bigint;
  /** Size of the order (positive). */
  sizeQ: bigint;
}

/** The busy-side bps for the order now; 0n when the asset has no growth record; null when it cannot be read (never a guess). */
export async function readFreshBusyFeeBps(
  connection: Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo" | "getSlot">,
  programId: PublicKey,
  market: PublicKey,
  g: Pick<BusyGuard, "direction" | "takerEffQ" | "sizeQ">,
  assetIndex = 0,
): Promise<bigint | null> {
  try {
    const slabInfo = await connection.getAccountInfo(market, "confirmed");
    if (!slabInfo) return null;
    const raw = new Uint8Array(slabInfo.data);
    if (!decodeGrowthRecord(raw, assetIndex)) return 0n; // no growth record: no busy-side fee exists
    const engine = decodeMarketEngineView(raw, assetIndex);
    if (!engine) return null;
    const vaultLp = decodeAssetVaultLp(raw, assetIndex);
    const known = vaultLp?.bound ? new Pk(vaultLp.vaultLpPortfolio) : null;
    const lpAccts = await resolveLpAccounts(connection as Connection, programId, market, known);
    if (!lpAccts) return null;
    const keys: PublicKey[] = [lpAccts.lpPortfolio];
    let guardPda: PublicKey | null = null;
    if (isDevnetV22Enabled()) {
      try { guardPda = levGuardPda(programId, market); keys.push(guardPda); } catch { guardPda = null; }
    }
    const [infos, slot] = await Promise.all([connection.getMultipleAccountsInfo(keys, "confirmed"), connection.getSlot("confirmed")]);
    const lpInfo = infos[0];
    if (!lpInfo) return null;
    const lpBytes = new Uint8Array(lpInfo.data);
    const r = decodePortfolioRisk(lpBytes);
    if (!r) return null;
    const lp: LpView = { ...r, address: lpAccts.lpPortfolio, posQ: signedPositionForAsset(lpBytes, assetIndex, engine.marketId), legs: decodePortfolioLegs(lpBytes) };
    const lpRealQ = lpEffectiveSignedQ(lpBytes, engine, assetIndex, engine.marketId);
    const guard = guardPda ? { account: decodeMarketLevGuard(infos[1], programId, market, assetIndex) } : null;
    const view = growthFor({ engine, vaultLp }, { lp, guard }, lpRealQ, raw, assetIndex, BigInt(slot));
    if (!view) return null;
    const d = growthTicketDecision(view, g.direction, g.takerEffQ, g.sizeQ);
    return d.fee ? BigInt(Math.max(0, Math.round(d.fee.utilFeeBps))) : 0n;
  } catch {
    return null;
  }
}

/** Refused before the wallet: the order's busy-side rate is now higher than the one the trader confirmed. */
export class BusyFeeRoseError extends Error {
  readonly freshBps: bigint;
  constructor(freshBps: bigint) {
    super(`The busy-side fee rose to ${(Number(freshBps) / 100).toFixed(2)}% while you were reviewing. Review it again. Nothing was sent.`);
    this.name = "BusyFeeRoseError";
    this.freshBps = freshBps;
  }
}

/**
 * Runs immediately before the wallet is asked to sign (after any market / catch-up wait). Higher than confirmed => BusyFeeRoseError (nothing
 * signed). Equal or lower => proceeds. Unreadable => proceeds on the chain cap (the guard fails open) and says so in the console.
 */
export async function assertBusyFeeNotRisen(g: BusyGuard | undefined, read: () => Promise<bigint | null>): Promise<void> {
  if (!g) return;
  const fresh = await read().catch(() => null);
  if (fresh === null) {
    console.warn("[busy-fee-guard] the busy-side fee could not be re-read before signing; proceeding with the chain cap");
    return;
  }
  if (fresh > g.confirmedBusyFeeBps) throw new BusyFeeRoseError(fresh);
}
