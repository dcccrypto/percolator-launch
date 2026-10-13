import { PublicKey } from "@solana/web3.js";

/**
 * Public trader profile (/trader/<wallet>): helpers shared by the page and the leaderboard link.
 *
 * Everything the profile shows is already public: on-chain accounts and the indexer's trade log,
 * served by the same rate-limited /api/trader/:wallet/* routes the portfolio page uses.
 */

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The wallet from the URL segment, or null when it is not a Solana address. The segment is user
 * input: it is validated here before it reaches an RPC filter or an API path.
 */
export function parseTraderWallet(raw: string | string[] | undefined): string | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (typeof s !== "string") return null;
  const trimmed = decodeURIComponent(s).trim();
  if (!BASE58.test(trimmed)) return null;
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return null;
  }
}

/** Profile path for a wallet. */
export const traderPath = (wallet: string): string => `/trader/${wallet}`;

/** "843GV9…7ko8", the leaderboard's short form. */
export function shortWallet(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
