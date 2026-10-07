/** What the Earn rail hands the v2.2 bond / rescue surfaces (all already read by the rail; no extra RPC). */
import type { PublicKey } from "@solana/web3.js";
import type { EarnTrancheView } from "@/lib/limits/vault-tranche";

export interface EarnV22Context {
  market: PublicKey;
  programId: PublicKey;
  collateralMint: PublicKey;
  decimals: number;
  symbol: string;
  /** `registry.domain` of the vault. */
  registryDomain: number;
  /** The bound vault LP portfolio (bond deposit / withdraw / rescue need it on a bound vault). */
  lpPortfolio: PublicKey | null;
  view: EarnTrancheView | null;
  /** Senior shares outstanding (registry). */
  registryShares: bigint | null;
  oiLongQ: bigint;
  oiShortQ: bigint;
  /** |LP_eff| in engine Q (0 when unknown). */
  lpEffAbsQ: bigint;
  onDone?: () => void;
}
