/**
 * Dollar stablecoins are not perp underlyings on v2.2 (owner decision 2026-11-09, Council R2-11 / R3-10).
 *
 * One list and one predicate for every off-chain gate: the create wizard (UI), POST /api/markets (registration),
 * GET /api/markets (listing) and POST /api/mobile/create-market. v2.2 flag only: with the flag off nothing here blocks.
 * This is NOT an on-chain rule: InitMarket stays permissionless, so these gates only keep such a market from being
 * created through the app or listed by it.
 *
 * Mainnet mints (the address pasted at step 1 / stored as `mainnet_ca` is the mainnet reference CA).
 */
import { PublicKey } from "@solana/web3.js";
import { isDevnetV22Enabled } from "@/lib/v22/flag";

export const STABLECOIN_PERP_MINTS: ReadonlySet<string> = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export const STABLECOIN_PERP_REASON =
  "This is a dollar stablecoin (USDC, USDT or PYUSD), so it can't be a perp market's token. Paste the mint of the token you want to list.";

/** True on v2.2 when `ca` (trimmed; canonicalised through PublicKey when it parses) is a blocked stablecoin mint. */
export function isStablecoinPerpBlocked(ca: string | null | undefined): boolean {
  if (!isDevnetV22Enabled() || typeof ca !== "string") return false;
  const v = ca.trim();
  if (v.length === 0) return false;
  if (STABLECOIN_PERP_MINTS.has(v)) return true;
  try {
    return STABLECOIN_PERP_MINTS.has(new PublicKey(v).toBase58());
  } catch {
    return false;
  }
}
