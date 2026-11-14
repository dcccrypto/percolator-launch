/**
 * Collateral the bot API can value in USD. The notional cap is stated in USD, so it needs a USD value for one collateral
 * atom: the market's collateral mint must be one this table knows, with its decimals (a market account stores the mint,
 * not the decimals). An unknown mint is `market_unsupported` for orders that add risk; it never silently reads as a
 * 6-decimal stable.
 *
 * Devnet: the Sim-USDC mint the app's faucet hands out (app/faucet/page.tsx, app/api/playground/faucet/route.ts), 6 decimals,
 * 1 token = 1 USD by construction. NEXT_PUBLIC_TEST_USDC_MINT (the same env the app reads) names it when it is rotated.
 */
import { PublicKey } from "@solana/web3.js";
import { parseWrapperConfigV17, V17_HEADER_LEN } from "@percolatorct/sdk";
import { ApiError } from "@/lib/bot-api/errors";

export const SIM_USDC_MINT = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
export const SIM_USDC_DECIMALS = 6;

/** mint (base58) -> decimals, for collateral that is worth 1 USD per token. */
export function usdStableMints(): Record<string, number> {
  const out: Record<string, number> = { [SIM_USDC_MINT]: SIM_USDC_DECIMALS };
  const env = process.env.NEXT_PUBLIC_TEST_USDC_MINT?.trim();
  if (env && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env)) out[env] = SIM_USDC_DECIMALS;
  return out;
}

/** Decimals of a mint the API can value in USD, or null. */
export function collateralDecimalsOf(mint: string): number | null {
  const d = usdStableMints()[mint];
  return d === undefined ? null : d;
}

/** The market's collateral mint (base58) and its decimals (null = not a mint the API can value). Throws market_unreadable. */
export function collateralOfMarket(raw: Uint8Array): { mint: string; decimals: number | null } {
  let mint: PublicKey;
  try {
    mint = parseWrapperConfigV17(raw, V17_HEADER_LEN).collateralMint;
  } catch {
    throw new ApiError("market_unreadable");
  }
  const m = mint.toBase58();
  return { mint: m, decimals: collateralDecimalsOf(m) };
}

/** Like collateralOfMarket, but refuses a mint that cannot be valued in USD. */
export function requireValuedCollateral(raw: Uint8Array): { mint: string; decimals: number } {
  const c = collateralOfMarket(raw);
  if (c.decimals === null) {
    throw new ApiError("market_unsupported", `this market's collateral (mint ${c.mint}) cannot be valued in USD, so the notional cap cannot be applied; the API supports Sim-USDC (${SIM_USDC_MINT}) only`, {
      details: { collateralMint: c.mint, supported: Object.keys(usdStableMints()) },
    });
  }
  return { mint: c.mint, decimals: c.decimals };
}
