/**
 * A close (or the withdraw that follows it), or a Wrap as NFT, that names ONE portfolio account must
 * act on exactly that account (#3301). The caller bound the account when it drew the row; nothing here may
 * substitute "the" wallet portfolio for it, because a wallet can own several on one market
 * (wrap, trade again, unwrap) and acting on another one closes a position the user did not pick.
 *
 * `verifyPortfolioTarget` is the gate: the account must exist, be owned by the market program,
 * decode as a trader portfolio, belong to this wallet (decoded mutable owner, not a memcmp hint)
 * and to this market. Anything else is a `PortfolioTargetError` with calm copy, never a silent
 * success and never a fallback scan.
 */
import type { PublicKey } from "@solana/web3.js";
import { parsePortfolio } from "@/lib/v22/layout";
import { isLpPortfolio } from "@/lib/lpPortfolio";
import { isPortfolioAccount } from "@/lib/portfolio-account";

export const TARGET_COPY = {
  /** The named account is missing, is not this wallet's, or is on another market. */
  unmatched: "We couldn't match this position to your wallet, so nothing was sent. Refresh and try again.",
  /** The named account has no open position (already closed, liquidated or unwrapped). */
  flat: "There's nothing left to close on this position. Nothing was sent.",
  /** The percent rounds to nothing on a very small position. */
  tooSmall: "That share is too small to close on its own. Try closing all of it.",
} as const;

/** A close target problem the user must see (its message is calm copy, shown as is). Callers keep their modal open on it. */
export class PortfolioTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioTargetError";
  }
}

export function isPortfolioTargetError(e: unknown): e is PortfolioTargetError {
  return e instanceof PortfolioTargetError;
}

export interface TargetAccountInfo {
  owner: PublicKey;
  data: Uint8Array;
}

/** Returns the target's account bytes, or throws `PortfolioTargetError`. */
export function verifyPortfolioTarget(
  info: TargetAccountInfo | null | undefined,
  programId: PublicKey,
  market: PublicKey,
  wallet: PublicKey,
): Buffer {
  if (!info) throw new PortfolioTargetError(TARGET_COPY.unmatched);
  if (!info.owner.equals(programId)) throw new PortfolioTargetError(TARGET_COPY.unmatched);
  const data = Buffer.from(info.data);
  if (!isPortfolioAccount(data) || isLpPortfolio(data)) throw new PortfolioTargetError(TARGET_COPY.unmatched);
  // v2.2 QA NB-1: decode by the account's own VERSION (lib/v22/layout parsePortfolio). The installed SDK's v2.1 parser
  // misreads a 10,603-byte v2.2 portfolio, which refused every close / withdraw on v2.2 as "couldn't match".
  let pf: ReturnType<typeof parsePortfolio>;
  try {
    pf = parsePortfolio(data);
  } catch {
    throw new PortfolioTargetError(TARGET_COPY.unmatched);
  }
  if (!pf.owner.equals(wallet)) throw new PortfolioTargetError(TARGET_COPY.unmatched);
  if (!pf.marketGroupId || !pf.marketGroupId.equals(market)) throw new PortfolioTargetError(TARGET_COPY.unmatched);
  return data;
}

/** The close options for a drawn row: the row's own account. `undefined` only for a row built without one. */
export function closeTargetFor(row: { portfolioPk?: PublicKey | null }): { portfolioPk: PublicKey } | undefined {
  return row.portfolioPk ? { portfolioPk: row.portfolioPk } : undefined;
}
