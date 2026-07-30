/**
 * Shared DEX constants used across API routes and client hooks.
 * Single source of truth for DEX configuration - centralized here to affect all consumers.
 * 
 * These constants define which decentralized exchanges are supported for:
 * - Hyperp EMA oracle mode (price feeds from DEX pools)
 * - Market creation and validation
 * - Price oracle bootstrapping
 */

/**
 * Set of DEX identifiers supported for Hyperp EMA oracle mode.
 * Hyperp allows launching markets using DEX pool prices as the oracle feed,
 * eliminating need for external oracle feeds for permissionless markets.
 *
 * Supported DEXes:
 * - **pumpswap**: Pump.fun's DEX integration
 * - **meteora**: Meteora's concentrated liquidity pools
 *
 * This is the single gate for pool selection — the wizard's pool search
 * (useDexPoolSearch), /api/oracle/resolve and /api/launch all filter on it, so
 * a DEX removed here cannot back a new market anywhere.
 */
export const SUPPORTED_DEX_IDS = new Set(["pumpswap", "meteora"]);

/**
 * DEXes deliberately withheld from new market creation, and why. Rendered to
 * the creator so a blocked launch reads as "not supported yet" rather than the
 * generic "no price could be resolved".
 *
 * **raydium** — the keeper cannot yet publish a correct USD price for a Raydium
 * CLMM pool that is paired against SOL. Raydium CLMM orders its two mints by
 * PUBKEY, not by meaning, and its price is always "mint1 per mint0", so WSOL
 * lands on either side depending on the other token's address: when WSOL is
 * mint1 the price is SOL-per-token (multiply by SOL/USD), and when WSOL is
 * mint0 it is token-per-SOL (invert). Publishing one convention for both would
 * be right about half the time and ~80x wrong the rest, and a wrong price does
 * not merely mis-price the chart — it permanently mis-sizes the LP trade caps
 * written once at market creation (see lib/matcherCaps.ts and the 2026-07-29
 * Meteora/WSOL incident, which had exactly this shape). Blocked until the
 * keeper's price-reader handles both orientations. Raydium pools quoted in a
 * USD stable are safe in principle; the block is deliberately coarse because
 * the creator-facing flow does not know the on-chain mint ordering.
 */
export const BLOCKED_DEX_IDS: Record<string, string> = {
  raydium:
    "Raydium pools aren't supported for new markets yet — our price feed can't " +
    "yet publish a reliable USD price for Raydium pools paired against SOL. " +
    "Launch against a Pump.fun or Meteora pool instead.",
};

