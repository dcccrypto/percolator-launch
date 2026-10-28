/**
 * Earn vault page (/earn/[slab]) display rules (product review 2026-10-28, E-4 / E-6).
 *
 * - E-6: the program refuses every Earn deposit on a market that is not Live (`handle_deposit_to_lp_vault`: `mode != Live` -> 21),
 *   but the page kept Deposit enabled, called the vault "Active", and a refused deposit read "Vault updating… try again in a moment".
 * - E-4: a direct /earn/<market> link showed no loss warning before Deposit (only the hub header had one).
 */
import type { MarketHealthRow } from "@/lib/market-health";

/** The same plain loss line the Earn hub header shows. */
export const EARN_LOSS_LINE = "It can also fall when traders win, so only deposit what you can afford to lose.";

export const EARN_SETTLED_DEPOSIT_BLOCK =
  "This market has settled, so its vault takes no new deposits. Use the settlement panel above to get your money out.";

/** True once the market is Resolved (health lock reason "resolved"). Unknown health (null) is not treated as settled. */
export function earnMarketSettled(health: Pick<MarketHealthRow, "lockReasons"> | null | undefined): boolean {
  return health?.lockReasons?.includes("resolved") === true;
}

/** The deposit block for the vault page: settled first, otherwise whatever the vault itself reports (e.g. covering a loss). */
export function earnPageDepositBlock(health: Pick<MarketHealthRow, "lockReasons"> | null | undefined, vaultReason: string | null): string | null {
  return earnMarketSettled(health) ? EARN_SETTLED_DEPOSIT_BLOCK : vaultReason;
}

/** "Vault status" row: Settled beats Active. */
export function earnVaultStatusLabel(vaultAvailable: boolean, settled: boolean): "Settled" | "Active" | "Unavailable" {
  if (settled) return "Settled";
  return vaultAvailable ? "Active" : "Unavailable";
}
