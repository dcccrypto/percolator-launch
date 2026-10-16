/**
 * Review F6: an Earn exit quote (the floor the user saw) is valid ONLY for the inputs it was made for, and only
 * for a short time. Withdraw signs the floor from the quote, so a quote for 100 shares must never be used to send
 * 1,000 shares. The key covers every input that changes what the program would pay.
 */
export const EXIT_QUOTE_MAX_AGE_MS = 20_000;

export interface ExitQuoteInputs {
  market: string | null;
  programId: string | null;
  collateralMint: string | null;
  sourceDomain: number;
  shares: bigint;
  mode: string;
  /** The wallet that would sign (a different wallet is a different redeemer). */
  redeemer: string | null;
}

export const exitQuoteKey = (i: ExitQuoteInputs): string =>
  [i.market, i.programId, i.collateralMint, i.sourceDomain, i.shares.toString(), i.mode, i.redeemer].join("|");

export interface BoundQuote {
  key: string;
  at: number;
}

/** True when a quote bound to `bound` may be used with `currentKey` at time `now`. */
export function quoteUsable(bound: BoundQuote | null, currentKey: string, now: number, maxAgeMs = EXIT_QUOTE_MAX_AGE_MS): boolean {
  return !!bound && bound.key === currentKey && now - bound.at >= 0 && now - bound.at <= maxAgeMs;
}

export class StaleExitQuoteError extends Error {
  constructor() {
    super("The exit price is out of date. Get a new one.");
    this.name = "StaleExitQuoteError";
  }
}
