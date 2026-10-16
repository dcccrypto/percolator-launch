/**
 * The markets-row registration payload a launch binds into its creation-tx memo, and the margin
 * floor its max_leverage reads through. Moved out of hooks/useCreateMarket.ts so the launch and the
 * cross-device registration recovery (lib/launch-recovery.ts) build the payload with the SAME code:
 * the memo binds a digest of it, so two copies that drift would fail to verify.
 */
import type { PublicKey } from "@solana/web3.js";
import { getConfig } from "@/lib/config";
import { deriveMarketParams, leverageFromMarginBps, MIN_LEVERAGE_X } from "@/lib/market-params";
import type { MarketRegistrationPayload } from "@/lib/market-registration-auth";

/** The subset of the launch's CreateMarketParams the payload reads. */
export interface RegistrationPayloadParams {
  mint: PublicKey;
  symbol?: string;
  name?: string;
  decimals?: number;
  dexPoolAddress?: string;
  initialPriceE6: bigint;
  initialMarginBps: number;
  tradingFeeBps: number | bigint;
  lpCollateral: bigint;
  mainnetCA?: string;
}

/**
 * The on-chain initial_margin_bps this request will ACTUALLY be created with.
 *
 * Every leverage display (success screen, StepReview, markets DB `max_leverage`)
 * must go through this rather than the raw bps the user typed. Originally that
 * was BUG 16 (2026-07-06): create() floored the margin at 1500 but the displays
 * read the unfloored value, so a market advertised as 10x was initialized at
 * ~6.67x.
 *
 * The floor is gone (see MIN_SAFE_INITIAL_MARGIN_BPS above), but the reason for
 * this mirror is not: deriveMarketParams clamps leverage to [MIN_LEVERAGE_X,
 * MAX_LEVERAGE_X] and rounds margin UP, so the requested bps and the on-chain
 * bps can still differ. A pure function of the request — no retry/session
 * state — so it is safe to call before submission.
 */
export function flooredInitialMarginBps(requestedBps: number): number {
  const lev = requestedBps > 0 ? 10_000 / requestedBps : MIN_LEVERAGE_X;
  return deriveMarketParams(lev, 0n, 1_000_000n).initialMarginBps;
}


/**
 * Single source of truth for the market-registration payload.
 *
 * The batched fast path and the sequential fallback both POST this object to
 * /api/markets AND sign a canonical encoding of it (buildMarketRegistrationMessage,
 * #2387). The signed bytes and the POSTed bytes MUST be byte-identical or the
 * server's signature check 401s — so the payload must be built in exactly ONE
 * place. Previously each path hand-wrote its own literal (they had already
 * drifted cosmetically on the oracle_authority fallback); this factory removes
 * any chance of a future field being added to one and forgotten on the other.
 */
export function buildMarketRegistrationPayload(args: {
  slabAddress: string;
  params: RegistrationPayloadParams;
  deployer: string;
  oracleMode: "pyth" | "hyperp" | "admin" | "keeper";
  isAdminOracle: boolean;
  isDevnetEnv: boolean;
  /** Tests / recovery: the crank wallet to use instead of the deployment's config. */
  crankWallet?: string;
}): MarketRegistrationPayload {
  const { slabAddress, params, deployer, oracleMode, isAdminOracle, isDevnetEnv } = args;
  const crankWallet = args.crankWallet ?? getConfig().crankWallet;
  return {
    slab_address: slabAddress,
    mint_address: params.mint.toBase58(),
    symbol: params.symbol ?? "UNKNOWN",
    name: params.name ?? "Unknown Token",
    decimals: params.decimals ?? 6,
    deployer,
    oracle_mode: oracleMode,
    dex_pool_address: params.dexPoolAddress ?? null,
    // Admin-oracle markets on devnet are cranked by the shared crank wallet;
    // otherwise the deployer is its own oracle authority. (deployer === the
    // connected wallet, so this matches the former walletPk.toBase58() literal.)
    //
    // A "keeper" market counts here. On devnet it is created in AUTH_MARK/admin
    // mode and its oracle authority is DELEGATED to the keeper — that is what
    // the mode means. Testing `isAdminOracle` alone (oracleMode === "admin")
    // excluded exactly those markets, so the row recorded oracle_authority=null
    // for the ones the keeper actually drives. Fauci's row shows the symptom.
    oracle_authority: (isAdminOracle || oracleMode === "keeper")
      ? (isDevnetEnv && crankWallet ? crankWallet : deployer)
      : null,
    initial_price_e6: params.initialPriceE6.toString(),
    // BUG 16: advertise the FLOORED margin actually enforced on-chain, not the
    // raw requested bps — see flooredInitialMarginBps.
    max_leverage: params.initialMarginBps > 0
      ? leverageFromMarginBps(flooredInitialMarginBps(params.initialMarginBps))
      : 1,
    trading_fee_bps: Number(params.tradingFeeBps),
    lp_collateral: params.lpCollateral.toString(),
    mainnet_ca: params.mainnetCA ?? null,
  };
}
