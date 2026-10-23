/**
 * LP-portfolio exclusion helper.
 *
 * Extracted from lib/userAccountScan.ts (2026-07-13) so SERVER routes (e.g.
 * app/api/markets/[slab]/logo/route.ts) can import `isLpPortfolio` without
 * pulling in a `"use client"` module. userAccountScan.ts re-exports both
 * names from here so its existing client call sites (useUserAccount,
 * usePositionNft, useNftWrappedPosition, usePortfolio,
 * useDeposit, useWithdraw, useClosePosition, useTrade, useInitUser,
 * useCreatedMarkets) don't need to change.
 *
 * WHY this exists (verified on-chain, 2026-07-12): the wizard creates a
 * market's LP portfolio (the AMM counterparty holding the market's seeded
 * liquidity, e.g. 1000 sim-USDC) via InitUser with the market CREATOR's own
 * wallet as its mutable owner (offset 116) — see useCreateMarket. Every "find
 * MY trading account on this market" owner-scan across the app filters ONLY
 * on (magic + market_group_id@16 + owner@116), with no LP exclusion. For a
 * market's CREATOR specifically, that means these scans return the LP
 * portfolio as if it were the creator's own trading account:
 *   - the trade page shows the market's LP liquidity as the creator's own
 *     "available to trade" balance;
 *   - a creator's DEPOSIT would top up the LP instead of creating their own
 *     portfolio;
 *   - a creator's TRADE would resolve accountA (taker) == accountB (LP,
 *     matcher-enabled) — the same account on both sides, nonsense/fails
 *     on-chain;
 *   - withdraw/close/portfolio/NFT-mint paths are similarly contaminated.
 * Non-creators are unaffected (the LP's owner is a different wallet).
 *
 * A portfolio IS the LP iff its trailing PortfolioMatcherConfigV16 has
 * `enabled == 1` — SetMatcherConfig is only ever called on the LP side (see
 * useTrade.ts's readPortfolioMatcherConfig / lib/lp-portfolio.ts's
 * isMatcherEnabled, which this mirrors byte-for-byte). Every scan whose
 * purpose is "the CALLER's own trading account" must call this AFTER fetch
 * (memcmp can't express "enabled != 1") and drop any match — BEFORE the
 * existing pubkey-sort/[0]-pick and before the owner re-verification result
 * is used. Do NOT apply this to scans that explicitly WANT the LP: useTrade's
 * accountB discovery (resolveV17TradeAccounts), lib/lp-portfolio.ts's capital
 * reads (market vault_balance display), or useCreateMarket's own LP setup.
 *
 * SERVER USE (new, 2026-07-13): POST /api/markets/[slab]/logo uses this same
 * signal, in the OPPOSITE direction, as its per-market ownership proof — a
 * wallet-signed request is accepted only if the signer owns a portfolio on
 * this slab that satisfies isLpPortfolio (i.e. IS the market's LP), because
 * that LP portfolio's owner is the durable creator marker (see that route's
 * header comment for why marketauth can't be used post-launch).
 */
import {
  V17_PORTFOLIO_IDENTITY_TRAILER_LEN,
  decodePortfolioMatcherControl,
} from "@percolatorct/sdk";
import { isPortfolioAccount } from "@/lib/portfolio-account";

export const PORTFOLIO_MATCHER_CONFIG_LEN = 104; // sizeof(PortfolioMatcherConfigV16)

/**
 * True if `data` is a v17/v18 portfolio account acting as a market's LP (its
 * PortfolioMatcherConfigV16 has enabled == 1). See the module comment above for
 * why every "this is MY trading account" scan must exclude these.
 *
 * v18: a `V17_PORTFOLIO_IDENTITY_TRAILER_LEN`-byte identity trailer follows the
 * matcher config, so it is no longer the final 104 bytes; and its trailing u64
 * is a packed control word (bit 0 = enabled), decoded via the SDK.
 */
export function isLpPortfolio(data: Buffer | Uint8Array): boolean {
  if (!isPortfolioAccount(data)) return false; // F-3
  const trailerLen = V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  if (data.length < PORTFOLIO_MATCHER_CONFIG_LEN + trailerLen) return false;
  const off = data.length - PORTFOLIO_MATCHER_CONFIG_LEN - trailerLen;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // control (u64 LE) sits at the last 8 bytes of the 104-byte config
  // (matcher_program[32] | matcher_context[32] | matcher_delegate[32] | control[8]).
  const control = dv.getBigUint64(off + 96, true);
  return decodePortfolioMatcherControl(control).enabled;
}
