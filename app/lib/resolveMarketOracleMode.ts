export type MarketOracleMode =
  | "pyth"
  | "hyperp"
  | "admin"
  | "keeper";

export type MarketNetwork = "mainnet" | "devnet";

export interface ResolveMarketOracleModeInput {
  requestedMode: MarketOracleMode;
  network: MarketNetwork;
  hasMainnetCA: boolean;
}

/**
 * Resolve the effective oracle mode for market creation.
 *
 * Hyperp may fall back to Admin only for devnet mirror markets,
 * because mainnet DEX pool accounts are unavailable on devnet.
 *
 * mainnetCA alone is token metadata and must not be treated as
 * proof that the current runtime network is devnet.
 */
export function resolveMarketOracleMode(
  input: ResolveMarketOracleModeInput,
): MarketOracleMode {
  const isDevnetMirror =
    input.network === "devnet" &&
    input.hasMainnetCA;

  if (
    input.requestedMode === "hyperp" &&
    isDevnetMirror
  ) {
    return "admin";
  }

  return input.requestedMode;
}
