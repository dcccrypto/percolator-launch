/**
 * Council GO1106-UX #4 (Creator, HIGH): "Pasting mainnet USDC (EPjFWdd5…) into the create wizard passes the token
 * step. Step 2 then shows ... PRICE FEED 'Keeper: PUMP / USDC (PumpSwap)' and START PRICE $0.003969, which is PUMP's
 * price."
 *
 * DexScreener's /latest/dex/tokens/<mint> returns every pair the mint is in, on EITHER side, and `priceUsd` is
 * always the BASE token's price. A pair only prices `mint` when `mint` is its base token.
 */
export interface DexPairSides {
  baseToken?: { address?: string | null } | null;
  quoteToken?: { address?: string | null } | null;
}

/** True when `mint` is the pair's base token (so its priceUsd is `mint`'s price). */
export function dexPairBaseIs(pair: DexPairSides, mint: string): boolean {
  const base = pair.baseToken?.address;
  return typeof base === "string" && base === mint;
}

/** True when `mint` appears only as the pair's quote token (its priceUsd is ANOTHER token's price). */
export function dexPairQuoteIs(pair: DexPairSides, mint: string): boolean {
  const quote = pair.quoteToken?.address;
  return typeof quote === "string" && quote === mint && !dexPairBaseIs(pair, mint);
}

export const QUOTE_ONLY_REASON =
  "This token is only ever the quote side of its pools (for example a stablecoin like USDC), so there is no pool " +
  "that prices it. Markets need a pool where this token is the base token.";
