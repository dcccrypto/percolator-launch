"use client";

import { useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import {
  discoverMarketsViaStaticBundle,
  parseAllAccounts,
  parseConfig,
  parseParams,
  parsePortfolioV17,
  parsePositionNftAccount,
  parseWrapperConfigV17,
  isV17Account,
  AccountKind,
  computeLiqPrice,
  computeMarkPnl,
  computePnlPercent,
  V17_HEADER_LEN,
  type DiscoveredMarket,
  type Account,
} from "@percolatorct/sdk";
import { isSentinelValue } from "@/lib/health";
import { isLpPortfolio } from "@/lib/userAccountScan";
import { computeMarkPnlCollateral, computePositionInitialMargin, estimateEntryFromPnl, resolveEntryPrice, type EntryPriceSource } from "@/lib/trading";
import { parseV17RiskParams } from "@/lib/v17-engine-config";
import {
  parseAssetAdlFactors,
  adlSideFactor,
  effectiveExposureQ,
  adlRemainingBps,
  isDeleveraged,
  type AssetAdlFactors,
} from "@/lib/v17-adl";
import { getAllProgramIds, getNetwork } from "@/lib/config";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { getEntryPrice } from "@/lib/entry-price";
import { computeLiquidationDistancePct } from "@/lib/liquidation-distance";
import { discoverMarketsViaProgramDirectory } from "@/lib/market-directory-discovery";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";

const MAINNET_STATIC_MARKETS = [
  {
    slabAddress: "AiVcTXxKfKmcpUBG3unxCdEHHtXvAq8zYpbtS6oPrV6J",
    symbol: "SOL-PERP",
    name: "SOL/USD Perpetual",
  },
];

function getApiBaseUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URL("/api", window.location.origin).toString();
}

/**
 * Fail-closed market discovery: distinguishes "a discovery source FAILED"
 * (throw, so fetchPortfolioSnapshot rejects and loadPortfolioShared keeps the
 * last-good cached snapshot) from "every source succeeded but reported zero
 * markets" (a legitimately empty market universe — return []). The old
 * `.catch(() => [])` on both sources made a directory outage
 * indistinguishable from "no markets exist", so a failed discovery cached an
 * empty-but-"successful" snapshot that blanked every mounted portfolio widget.
 * The mainnet static bundle keeps its existing role as a fallback when the
 * API directory fails or comes back empty.
 */
async function discoverPortfolioMarkets(
  connection: ReturnType<typeof useConnectionCompat>["connection"],
  programId: PublicKey,
): Promise<DiscoveredMarket[]> {
  const network = getNetwork();
  const apiBaseUrl = getApiBaseUrl();

  let anySourceSucceeded = false;
  let lastError: unknown = null;

  if (apiBaseUrl) {
    try {
      const viaApi = await discoverMarketsViaProgramDirectory(connection, programId, apiBaseUrl, {
        timeoutMs: 8_000,
      });
      if (viaApi.length > 0) return viaApi;
      anySourceSucceeded = true;
    } catch (error) {
      lastError = error;
    }
  }

  if (network === "mainnet") {
    try {
      const viaStatic = await discoverMarketsViaStaticBundle(
        connection,
        programId,
        MAINNET_STATIC_MARKETS,
      );
      if (viaStatic.length > 0) return viaStatic;
      anySourceSucceeded = true;
    } catch (error) {
      lastError = error;
    }
  }

  // Every attempted source failed → fail closed. (No sources attempted —
  // e.g. SSR with no apiBaseUrl on a non-mainnet network — keeps the
  // pre-existing "return empty" behavior: there was no failure to report.)
  if (!anySourceSucceeded && lastError !== null) {
    console.debug("[usePortfolio] market discovery failed:", lastError);
    throw lastError;
  }
  return [];
}

/**
 * P1: `DiscoveredMarket` (from discoverPortfolioMarkets, on-chain only) carries
 * no symbol — every position was falling back to the COLLATERAL token symbol
 * ("USDC/USD") for every market, since sim-USDC is the single collateral shared
 * across all playground markets (see PLAYGROUND.md). Resolve the real market
 * symbol from the app's own `/api/markets` directory (covers curated AND
 * wizard-created markets), with `PLAYGROUND_SLAB_META` as a zero-network
 * fallback for the 5 curated devnet markets. Best-effort: a failed/slow fetch
 * must never block the portfolio load — callers fall back to
 * `PLAYGROUND_SLAB_META` or `null` (existing "collateral/USD" / truncated
 * address rendering) when this returns an empty map.
 */
async function fetchSymbolBySlab(apiBaseUrl: string | undefined): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!apiBaseUrl) return map;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/markets?limit=500`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return map;
    const body = (await response.json()) as { markets?: unknown };
    const rows = Array.isArray(body.markets) ? body.markets : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const slab = typeof r.slab_address === "string" ? r.slab_address : null;
      const symbol = typeof r.symbol === "string" && r.symbol.length > 0 ? r.symbol : null;
      if (slab && symbol) map.set(slab, symbol);
    }
  } catch {
    // Best-effort — never block the portfolio load on this.
  }
  return map;
}

/** Resolve a market's display symbol: API directory first, curated static meta fallback. */
function resolveSymbol(slabAddrStr: string, symbolBySlab: Map<string, string>): string | null {
  return symbolBySlab.get(slabAddrStr) ?? PLAYGROUND_SLAB_META[slabAddrStr]?.symbol ?? null;
}

export interface PortfolioPosition {
  slabAddress: string;
  symbol: string | null;
  account: Account;
  idx: number;
  market: DiscoveredMarket;
  /**
   * Resolved collateral mint for this position's market. v17 markets return an
   * empty `market.config` from the SDK (the real value lives in
   * `market.configV17.collateralMint`) — this field is pre-resolved here so
   * callers never need to touch `market.config.collateralMint` directly and
   * risk `undefined.toBase58()`.
   */
  collateralMint: PublicKey;
  /**
   * Effective entry price in e6 format.
   * V12_1 removed entry_price from the on-chain struct; falls back to
   * localStorage (saved at trade time) when account.entryPrice is 0.
   */
  effectiveEntryPrice: bigint;
  /** Last effective oracle price in e6 format */
  oraclePriceE6: bigint;
  /** Liquidation price in e6 format */
  liquidationPriceE6: bigint;
  /** Distance to liquidation as a percentage (0 = at liq, 100 = far from liq) */
  liquidationDistancePct: number;
  /** Unrealized PnL (mark-to-market using oracle) */
  unrealizedPnl: bigint;
  /**
   * How trustworthy `effectiveEntryPrice` / `unrealizedPnl` are — see
   * `resolveEntryPrice`. When "unknown" the entry price could not be
   * recovered (no local cache, and the on-chain `pnl` is 0 on an open
   * position because the loss was crystallized out of `capital`), so
   * `unrealizedPnl` is 0 as a PLACEHOLDER, not as a real "flat" reading.
   * Display sites MUST render "--" rather than "$0.00" in that case.
   */
  entryPriceSource: EntryPriceSource;
  /**
   * Cumulative realized loss already taken out of `capital`, straight from the
   * chain (`residual_crystallized_loss_atoms_total`, v16.rs:8836). This is the
   * number that explains a shrinking balance when `unrealizedPnl` reads flat —
   * without it a drained account looks unexplained.
   */
  realizedLoss: bigint;
  /**
   * The exposure this position ACTUALLY carries, after any auto-deleveraging.
   *
   * ADL does not rewrite `basis_pos_q` — it scales a shared per-side factor on
   * the asset and leaves every leg's stored basis alone — so `account.positionSize`
   * (raw basis) over-reports a deleveraged position by up to 10x. This is
   * `basis * a_side / a_basis`; see lib/v17-adl.ts for the derivation and the
   * on-chain cross-check against `oi_eff_*`.
   *
   * Equal to `account.positionSize` on every market that has never deleveraged,
   * which is the overwhelmingly common case. Use THIS for anything the user
   * reads as "size"/"exposure"/"notional", and `account.positionSize` for
   * closing and margin (see `adlRemainingBps`).
   */
  effectiveSize: bigint;
  /**
   * How much of this leg survived ADL, in basis points (10000 = untouched).
   * 5000 means the position now moves at half its nominal basis.
   */
  adlRemainingBps: number;
  /**
   * True when this specific leg has been auto-deleveraged — the side factor has
   * fallen below the value frozen into the leg when it was opened. A leg opened
   * after someone else's ADL is NOT flagged; it carries its full exposure.
   */
  deleveraged: boolean;
  /** PnL as percentage of capital */
  pnlPercent: number;
  /** Risk leverage (position notional / slab account capital) */
  leverage: number;
  /** Maintenance margin bps for this market */
  maintenanceMarginBps: bigint;
  /** Initial margin bps for this market — consumers recomputing PnL% with a
   *  LIVE mark (portfolio PositionCard) must divide by the position's initial
   *  margin (computePositionInitialMargin), matching this hook's own
   *  pnlPercent, NOT by total account capital. */
  initialMarginBps: bigint;
  /**
   * True when this position is escrowed inside a Position NFT (v17). Minting an
   * NFT B-3-transfers `portfolio.owner` to the NFT program's escrow PDA, so the
   * owner-scan can't find it — it's recovered via the NFT last_holder scan.
   */
  nftWrapped?: boolean;
}

export type LiquidationSeverity = "safe" | "warning" | "danger";

export function getLiquidationSeverity(distancePct: number): LiquidationSeverity {
  if (distancePct <= 10) return "danger";
  if (distancePct <= 30) return "warning";
  return "safe";
}

/**
 * Map a parsed v17 portfolio into an enriched PortfolioPosition (liq price, PnL,
 * leverage). Shared by the owner-scan path and the NFT-wrapped recovery scan so
 * both surface identical rows. `nftWrapped` flags escrowed positions for the UI.
 */
function buildV17Position(
  portfolio: ReturnType<typeof parsePortfolioV17>,
  oraclePriceE6: bigint,
  maintenanceMarginBps: bigint,
  slabAddrStr: string,
  market: DiscoveredMarket,
  nftWrapped = false,
  initialMarginBps = 1000n,
  symbol: string | null = null,
  /**
   * The CONNECTED wallet's base58 pubkey — used ONLY to key the client-side
   * entry-price cache (lib/entry-price.ts). This is deliberately NOT
   * `portfolio.owner`: for an NFT-wrapped position, `portfolio.owner` is the
   * NFT program's ESCROW PDA (see the `nftWrapped` doc on PortfolioPosition),
   * not the trader's wallet — keying the cache lookup by the escrow PDA meant
   * it could never hit (the entry price was saved under the WALLET's key at
   * trade-open time), so wrapped positions always showed a cache miss.
   * BUG-HUNT-FINDINGS-2026-07-08 #4.
   */
  walletStr: string,
  /**
   * Live per-side ADL factors for this market's asset slot, read from the same
   * slab bytes the caller already fetched. `null` when unavailable (legacy
   * layout, short buffer) — the position then falls back to raw basis, i.e.
   * exactly the pre-ADL-fix behaviour.
   */
  adlFactors: AssetAdlFactors | null = null,
): PortfolioPosition {
  // v17 markets return an empty `market.config` from the SDK — the real
  // collateral mint lives in `market.configV17` (see markets/page.tsx's
  // established `v17?.collateralMint ?? d.config.collateralMint` pattern).
  const collateralMint = market.configV17?.collateralMint ?? market.config.collateralMint;
  // Map v17 portfolio to the Account shape used by the rest of usePortfolio
  const ZERO_PK = new PublicKey(new Uint8Array(32));
  const activeLeg = portfolio.legs.find((l) => l.active);
  const positionSize = activeLeg ? activeLeg.basisPosQ : 0n;

  // Auto-deleveraging leaves `basis_pos_q` untouched and scales the asset's
  // shared per-side factor instead, so raw basis over-reports a deleveraged
  // position (2x on live devnet markets today). Resolve the exposure the leg
  // actually carries; identical to `positionSize` when nothing was deleveraged.
  // NOTE: `account.positionSize` deliberately stays RAW basis below — closing
  // and margin are denominated in basis (v16.rs:12640, :9707) and the close
  // path re-reads it from a fresh scan. Only display/PnL use `effectiveSize`.
  const aSide =
    activeLeg && adlFactors ? adlSideFactor(adlFactors, activeLeg.side) : 0n;
  const aBasis = activeLeg ? activeLeg.aBasis : 0n;
  const effectiveSize =
    activeLeg && adlFactors
      ? effectiveExposureQ(positionSize, aBasis, aSide)
      : positionSize;
  const adlRemaining =
    activeLeg && adlFactors ? adlRemainingBps(aBasis, aSide) : 10000;
  const deleveraged =
    activeLeg !== undefined && adlFactors !== null && isDeleveraged(aBasis, aSide);

  const account: Account = {
    kind: AccountKind.User,
    accountId: 0n,
    capital: portfolio.capital,
    pnl: portfolio.pnl,
    reservedPnl: portfolio.reservedPnl,
    warmupStartedAtSlot: 0n,
    warmupSlopePerStep: 0n,
    positionSize,
    entryPrice: 0n,
    fundingIndex: 0n,
    matcherProgram: ZERO_PK,
    matcherContext: ZERO_PK,
    owner: portfolio.owner,
    feeCredits: portfolio.feeCredits,
    lastFeeSlot: portfolio.lastFeeSlot,
    feesEarnedTotal: 0n,
    exactReserveCohorts: null,
    exactCohortCount: null,
    overflowOlder: null,
    overflowOlderPresent: null,
    overflowNewest: null,
    overflowNewestPresent: null,
    fSnap: activeLeg ? activeLeg.fSnap : 0n,
    // See lib/userAccountScan.ts — the leg's frozen ADL factor is what lets a
    // consumer recover effective exposure from raw basis.
    adlABasis: aBasis,
    adlKSnap: activeLeg ? activeLeg.kSnap : 0n,
    adlEpochSnap: activeLeg ? activeLeg.epochSnap : 0n,
    schedPresent: null,
    schedRemainingQ: null,
    schedAnchorQ: null,
    schedStartSlot: null,
    schedHorizon: null,
    schedReleaseQ: null,
    pendingPresent: null,
    pendingRemainingQ: null,
    pendingHorizon: null,
    pendingCreatedSlot: null,
  } as Account;

  const savedEntryPrice = getEntryPrice(slabAddrStr, 0, walletStr);
  // Cache miss (no on-chain entry_price in v17, and nothing saved under this
  // wallet's key — e.g. a Position NFT received via transfer, whose recipient
  // browser never ran the trade that opened it, or the escrow-PDA-keying bug
  // above before this fix). Falling through to "entry == mark" would silently
  // imply zero PnL and clamp liq price to "N/A" while a DIFFERENT, unrelated
  // PnL figure is shown elsewhere — instead derive the effective entry from
  // the position's own on-chain unrealized PnL, mirroring PositionsDock's
  // identical fallback (`estimateEntryFromPnl(positionSize, account.pnl,
  // currentPriceE6)`).
  // E: guard the sentinel BEFORE it feeds estimateEntryFromPnl's math (the
  // isSentinelValue guard later in this function, on pnlNative's fallback
  // branch, is a separate/later use) — see PositionsDock's identical fix for
  // why an unguarded u64::MAX-class portfolio.pnl here can poison the derived
  // entry price instead of being caught by estimateEntryFromPnl's own
  // entry>0n clamp.
  //
  // 2026-07-22: that derivation is only sound while the on-chain `pnl` still
  // CARRIES the loss. It does not: a realized loss is crystallized out of
  // `capital` and `pnl` is pushed back to 0 (v16.rs:9382-9437), so a solvent
  // loser reads `pnl == 0` and the derivation collapses to "entry == mark" —
  // the exact silent-zero-PnL outcome the comment above set out to avoid.
  // `resolveEntryPrice` keeps the same numeric fallback for risk math but
  // reports source === "unknown" so display sites can print "--".
  const safePnlForEntry = isSentinelValue(account.pnl) ? 0n : account.pnl;
  // Derive against EFFECTIVE exposure: the on-chain `pnl` this back-solves from
  // was accrued at the deleveraged rate, so `pnl / basis` would understate the
  // entry offset by the ADL factor. No-op on markets that never deleveraged.
  const resolvedEntry = resolveEntryPrice(
    effectiveSize,
    savedEntryPrice,
    safePnlForEntry,
    oraclePriceE6,
  );
  const effectiveEntryPrice = resolvedEntry.entry;
  const entryPriceSource = resolvedEntry.source;
  const liquidationPriceE6 = computeLiqPrice(
    effectiveEntryPrice,
    account.capital,
    account.positionSize,
    maintenanceMarginBps,
  );
  // computeMarkPnl (and the stale account.pnl fallback below, which is in the
  // SAME native scale — see computeMarkPnlCollateral's doc comment) returns
  // PnL in coin-margined native units, not collateral/USD. Convert once via
  // computeMarkPnlCollateral before it's displayed or fed to computePnlPercent
  // — mirrors PositionsDock's pnlNative/pnlTokens split.
  // entryPriceSource === "unknown" => effectiveEntryPrice is just the mark, so
  // this evaluates to 0. That 0 is a PLACEHOLDER, not a "flat" reading — it is
  // only safe to render because `entryPriceSource` travels with it and display
  // sites show "--" instead. Never treat it as a real zero.
  // PnL moves with EFFECTIVE exposure, not raw basis: a deleveraged leg
  // realizes basis*(k_now-k_snap)/(a_basis*POS_SCALE) and k accrues scaled by
  // the side's live `a` (v16.rs:9547-9576, :10497-10502), so it gains/loses at
  // `basis * a_side / a_basis` per unit of price. Feeding raw basis here
  // overstated a deleveraged position's PnL by the same factor as its size.
  const pnlNative = oraclePriceE6 > 0n && effectiveEntryPrice > 0n
    ? computeMarkPnl(effectiveSize, effectiveEntryPrice, oraclePriceE6)
    : (isSentinelValue(account.pnl) ? 0n : account.pnl);
  const unrealizedPnl = oraclePriceE6 > 0n ? computeMarkPnlCollateral(pnlNative, oraclePriceE6) : 0n;
  // ROE: divide by this position's own locked initial margin, matching the
  // trade terminal (PositionsDock/PositionPanel/ChartPnlBadge/AccountRiskSidebar),
  // not total account capital — capital can include collateral not backing
  // this specific position. Falls back to capital when initial margin can't
  // be computed (e.g. flat position) to preserve prior behavior.
  const positionInitialMargin = computePositionInitialMargin(account.positionSize, effectiveEntryPrice, initialMarginBps);
  const pnlPercent = positionInitialMargin > 0n
    ? computePnlPercent(unrealizedPnl, positionInitialMargin)
    : computePnlPercent(unrealizedPnl, account.capital);

  const liquidationDistancePct = computeLiquidationDistancePct(
    account.positionSize,
    oraclePriceE6,
    liquidationPriceE6,
  );

  const absPos = account.positionSize < 0n ? -account.positionSize : account.positionSize;
  let leverage = 0;
  if (account.capital > 0n && oraclePriceE6 > 0n) {
    leverage = Number((absPos * oraclePriceE6 / 1_000_000n) * 100n / account.capital) / 100;
  }

  return {
    slabAddress: slabAddrStr,
    symbol,
    account,
    idx: 0,
    market,
    collateralMint,
    effectiveEntryPrice,
    oraclePriceE6,
    liquidationPriceE6,
    liquidationDistancePct,
    unrealizedPnl,
    entryPriceSource,
    realizedLoss: portfolio.residualCrystallizedLossAtomsTotal,
    effectiveSize,
    adlRemainingBps: adlRemaining,
    deleveraged,
    pnlPercent,
    leverage,
    maintenanceMarginBps,
    initialMarginBps,
    nftWrapped,
  };
}

export interface PortfolioData {
  positions: PortfolioPosition[];
  totalPnl: bigint;
  totalDeposited: bigint;
  /** Total portfolio value (capital + unrealized PnL) */
  totalValue: bigint;
  /** Total unrealized PnL across all positions */
  totalUnrealizedPnl: bigint;
  /** Number of positions at liquidation risk */
  atRiskCount: number;
  loading: boolean;
  /** True only during background refreshes (not initial load) */
  isRefreshing: boolean;
  refresh: () => void;
}

/** The aggregate result of one full portfolio scan — everything usePortfolio's
 *  effect needs to push into its component state. Separated from PortfolioData
 *  because this is the shape shared/cached across hook instances (see
 *  loadPortfolioShared below), while PortfolioData also carries per-instance
 *  UI state (`loading`, `isRefreshing`, `refresh`). */
interface PortfolioSnapshot {
  positions: PortfolioPosition[];
  totalPnl: bigint;
  totalDeposited: bigint;
  totalValue: bigint;
  totalUnrealizedPnl: bigint;
  atRiskCount: number;
}

/**
 * The actual expensive portfolio scan: market discovery, a batched slab read,
 * ONE getProgramAccounts owner-scan per v17 program, and the NFT-wrapped
 * recovery pass. Pulled out of the hook body (module scope, no React state) so
 * it can be shared across every usePortfolio() instance mounted at once via
 * loadPortfolioShared below — /dashboard alone mounts FOUR
 * (DashboardHeader.tsx, StatsBar.tsx, PnlChart.tsx, PositionSummary.tsx), each
 * of which used to run this entire cycle independently every 30s.
 *
 * Deliberately has no `cancelled` concept of its own — a component instance
 * unmounting mid-scan must not abort work that other still-mounted instances
 * (or the shared cache) may be relying on. Each hook instance's own effect
 * checks ITS `cancelled` flag only around applying the resolved snapshot to
 * local state.
 */
export async function fetchPortfolioSnapshot(
  connection: ReturnType<typeof useConnectionCompat>["connection"],
  publicKey: PublicKey,
  programIds: string[],
): Promise<PortfolioSnapshot> {
  const pkStr = publicKey.toBase58();
  const apiBaseUrl = getApiBaseUrl();
  const [marketArrays, symbolBySlab] = await Promise.all([
    Promise.all(programIds.map((id) => discoverPortfolioMarkets(connection, new PublicKey(id)))),
    fetchSymbolBySlab(apiBaseUrl),
  ]);
  const markets = marketArrays.flat();
  const allPositions: PortfolioPosition[] = [];
  // v17 markets keyed by slab address → oracle price + margin, so the
  // NFT-wrapped recovery scan below can enrich escrowed portfolios using
  // the same market context the owner-scan used.
  const marketMetaBySlab = new Map<
    string,
    {
      market: DiscoveredMarket;
      oraclePriceE6: bigint;
      maintenanceMarginBps: bigint;
      initialMarginBps: bigint;
      /** Live per-side ADL factors, so both the owner-scan and the NFT-wrapped
       *  recovery scan resolve effective exposure the same way. */
      adlFactors: AssetAdlFactors | null;
    }
  >();
  // Distinct v17 wrapper program ids actually seen while scanning slabs
  // below (keyed by base58 to dedup) — normally just one, but derived
  // from each slab's real owner rather than assumed, so the single
  // batched portfolio scan after the loop still covers every v17
  // program in play (e.g. mid-migration overlap).
  const v17ProgramIdsSeen = new Map<string, PublicKey>();
  let pnlSum = 0n;
  let depositSum = 0n;
  let unrealizedPnlSum = 0n;
  let riskCount = 0;

  // Batch fetch all slab accounts using getMultipleAccountsInfo
  // RPC limit is 100 accounts per call, so chunk into batches
  const slabAddresses = markets.map((m) => m.slabAddress);
  let slabAccountsInfo: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];

  try {
    const BATCH_SIZE = 100;
    const chunks: PublicKey[][] = [];
    for (let i = 0; i < slabAddresses.length; i += BATCH_SIZE) {
      chunks.push(slabAddresses.slice(i, i + BATCH_SIZE));
    }
    const results = await Promise.all(
      chunks.map((chunk) => connection.getMultipleAccountsInfo(chunk))
    );
    slabAccountsInfo = results.flat();
  } catch (error) {
    // Fail closed: one failed chunk (Promise.all) means the slab context is
    // incomplete — swallowing it here used to yield an empty-but-"successful"
    // snapshot that loadPortfolioShared then cached over the last-good one.
    // Reject the fetch instead so the previous complete snapshot survives.
    console.error("[usePortfolio] Failed to batch fetch slabs:", error);
    throw error;
  }

  // Process each slab to find user accounts
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    const accountInfo = slabAccountsInfo[i];

    if (!accountInfo || !accountInfo.data) {
      continue;
    }

    try {
      const slabData = accountInfo.data;
      const slabAddrStr = market.slabAddress.toBase58();

      if (isV17Account(slabData)) {
        // ── v17 market path ────────────────────────────────────────────
        // Portfolios are standalone program-owned accounts, one wallet ==
        // one portfolio per market. This pass only computes each v17
        // market's oracle price + margin context and remembers which
        // program owns it (accountInfo.owner) — the actual portfolio
        // lookup is a SINGLE batched getProgramAccounts scan per program
        // done once after this loop (see below), instead of one
        // getProgramAccounts call per market here (that N+1 was the
        // single heaviest RPC cost in the app: with N v17 markets it was
        // N serially-awaited scans on every 30s refresh cycle).
        const v17ProgramId = accountInfo.owner;

        // Oracle price: read markEwmaE6 from v17 WrapperConfigV17 (at V17_HEADER_LEN).
        let oraclePriceE6 = 0n;
        // Defaults only used if the v17 risk-params parse below fails. The
        // real on-chain maintenance margin is 600 bps, not the old 500 bps
        // v12 fallback — always prefer parseV17RiskParams (mirrors
        // SlabProvider's real-values-not-hardcoded-fallbacks comment).
        let maintenanceMarginBps = 600n;
        let initialMarginBps = 1000n;
        // Auto-deleveraging state for asset slot 0 (every playground market is
        // single-asset). Read from the slab bytes already in hand — no extra RPC.
        const adlFactors = parseAssetAdlFactors(slabData, 0);
        try {
          const wCfg = parseWrapperConfigV17(slabData, V17_HEADER_LEN);
          // markEwmaE6 is the last effective price in v17 wrapper config.
          oraclePriceE6 = sanitizePriceE6(wCfg.markEwmaE6);
          const v17Params = parseV17RiskParams(slabData, wCfg.tradeFeeBps);
          if (v17Params) {
            maintenanceMarginBps = v17Params.maintenanceMarginBps;
            initialMarginBps = v17Params.initialMarginBps;
          }
        } catch {
          // Use defaults if parse fails
        }

        // Remember this v17 market's context so both the batched
        // owner-scan phase below AND the NFT-wrapped recovery scan can
        // enrich portfolios/escrows the same way.
        marketMetaBySlab.set(slabAddrStr, { market, oraclePriceE6, maintenanceMarginBps, initialMarginBps, adlFactors });
        v17ProgramIdsSeen.set(v17ProgramId.toBase58(), v17ProgramId);
      } else {
        // ── v12.x legacy path ──────────────────────────────────────────
        const accounts = parseAllAccounts(slabData);

        // Parse config and params for this market (needed for oracle price + risk params)
        let oraclePriceE6 = 0n;
        let maintenanceMarginBps = 500n; // default 5%
        let initialMarginBps = 1000n; // default 10%
        // v17 markets return an empty `market.config` from the SDK — the real
        // collateral mint lives in `market.configV17` (see markets/page.tsx's
        // established `v17?.collateralMint ?? d.config.collateralMint` pattern).
        // This is the v12.x branch so market.configV17 is normally undefined and
        // this resolves to market.config.collateralMint, but resolving the same
        // way keeps PortfolioPosition.collateralMint consistent across both paths.
        const collateralMint = market.configV17?.collateralMint ?? market.config.collateralMint;
        try {
          const config = parseConfig(slabData);
          // GH#1990: lastEffectivePriceE6 is the raw oracle price (pre-inversion).
          // Apply invert flag so oraclePriceE6 is in the same domain as entryPrice
          // (which is stored post-inversion on-chain). Without this, PnL and
          // liquidation calculations are directionally wrong for inverted markets.
          const rawPriceE6 = config.lastEffectivePriceE6;
          oraclePriceE6 = sanitizePriceE6(applyInvert(rawPriceE6, config.invert));
          const params = parseParams(slabData);
          maintenanceMarginBps = params.maintenanceMarginBps;
          initialMarginBps = params.initialMarginBps;
        } catch {
          // If config parse fails, use defaults
        }

        for (const { idx, account } of accounts) {
          if (account.kind === AccountKind.User && account.owner.toBase58() === pkStr) {
            // V12_1: entry_price was removed from on-chain struct. Fall back to
            // localStorage (saved by TradeForm at trade time) so portfolio PnL
            // and liq-price compute correctly instead of showing 0/—.
            // Both sources here are trustworthy entry prices (the v12 on-chain
            // field, or the mark cached at open time), so either counts as a
            // cache hit. When BOTH miss, resolveEntryPrice refuses to invent a
            // number from a crystallized-to-zero `pnl` — see its doc comment.
            const knownEntryPrice =
              account.entryPrice > 0n ? account.entryPrice : getEntryPrice(slabAddrStr, idx, account.owner.toBase58());
            const resolvedEntry = resolveEntryPrice(
              account.positionSize,
              knownEntryPrice,
              isSentinelValue(account.pnl) ? 0n : account.pnl,
              oraclePriceE6,
            );
            const effectiveEntryPrice = resolvedEntry.entry;

            // Compute liquidation price
            const liquidationPriceE6 = computeLiqPrice(
              effectiveEntryPrice,
              account.capital,
              account.positionSize,
              maintenanceMarginBps,
            );

            // Compute unrealized PnL using oracle price.
            // GH#1331: account.pnl can be u64::MAX sentinel for uninitialized/flat
            // positions. Guard it with isSentinelValue to prevent billion-dollar
            // phantom PnL on the dashboard when oracle price is unavailable.
            // computeMarkPnl (and the account.pnl fallback below, in the
            // same native scale) returns coin-margined native units, not
            // collateral/USD — convert via computeMarkPnlCollateral
            // before display/computePnlPercent (mirrors PositionsDock).
            const pnlNative = oraclePriceE6 > 0n && effectiveEntryPrice > 0n
              ? computeMarkPnl(account.positionSize, effectiveEntryPrice, oraclePriceE6)
              : (isSentinelValue(account.pnl) ? 0n : account.pnl);
            const unrealizedPnl = oraclePriceE6 > 0n
              ? computeMarkPnlCollateral(pnlNative, oraclePriceE6)
              : 0n;

            // PnL percentage (ROE): divide by this position's own locked initial
            // margin, matching the trade terminal (PositionsDock/PositionPanel/
            // ChartPnlBadge/AccountRiskSidebar), not total account capital —
            // capital can include collateral not backing this specific position.
            // Falls back to capital when initial margin can't be computed (e.g.
            // flat position) to preserve prior behavior.
            const positionInitialMargin = computePositionInitialMargin(account.positionSize, effectiveEntryPrice, initialMarginBps);
            const pnlPercent = positionInitialMargin > 0n
              ? computePnlPercent(unrealizedPnl, positionInitialMargin)
              : computePnlPercent(unrealizedPnl, account.capital);

            // Liquidation distance percentage
            const liquidationDistancePct = computeLiquidationDistancePct(
              account.positionSize,
              oraclePriceE6,
              liquidationPriceE6,
            );

            // Risk leverage = notional / slab account capital.
            const absPos = account.positionSize < 0n ? -account.positionSize : account.positionSize;
            let leverage = 0;
            if (account.capital > 0n && oraclePriceE6 > 0n) {
              // notional_usd = contracts * price; leverage = notional_usd / capital
              leverage = Number((absPos * oraclePriceE6 / 1_000_000n) * 100n / account.capital) / 100;
            }

            // Track liquidation risk
            if (liquidationDistancePct <= 30 && account.positionSize !== 0n) {
              riskCount++;
            }

            allPositions.push({
              slabAddress: slabAddrStr,
              symbol: resolveSymbol(slabAddrStr, symbolBySlab),
              account,
              idx,
              market,
              collateralMint,
              effectiveEntryPrice,
              oraclePriceE6,
              liquidationPriceE6,
              liquidationDistancePct,
              unrealizedPnl,
              entryPriceSource: resolvedEntry.source,
              // v12 accounts carry no residual-loss counter (it is a v17
              // portfolio-header field), so there is nothing to surface here.
              realizedLoss: 0n,
              // The v12.x engine has no per-side `a_long`/`a_short` factor and
              // no frozen `a_basis` on a leg — `positionSize` IS the exposure,
              // so there is nothing to rescale and nothing to disclose.
              effectiveSize: account.positionSize,
              adlRemainingBps: 10000,
              deleveraged: false,
              pnlPercent,
              leverage,
              maintenanceMarginBps,
              initialMarginBps,
            });
            // Guard account.pnl against u64::MAX sentinel values before accumulating.
            // Uninitialized / flat positions store u64::MAX as a sentinel — summing them
            // raw produces septillion-dollar phantom totals (GH#1352 regression).
            pnlSum += isSentinelValue(account.pnl) ? 0n : account.pnl;
            depositSum += account.capital;
            unrealizedPnlSum += unrealizedPnl;
          }
        }
      }
    } catch {
      // Skip markets that fail to parse
    }
  }

  // ── v17 owner-scan: ONE getProgramAccounts per distinct v17 program ──
  // Previously this was one getProgramAccounts call PER v17 MARKET,
  // awaited serially inside the loop above (filters: magic + slab@16 +
  // owner@116). With N markets that's N sequential round-trips on every
  // 30s refresh — the single heaviest RPC cost in the app. Since the
  // owner filter alone already scopes results to just THIS wallet's
  // portfolios, we can drop the per-market slab@16 filter entirely and
  // run one scan per program (normally just one program), then group
  // the (typically small) result set by `portfolio.marketGroupId`
  // client-side to match it back to the market it belongs to.
  const V17_PORTFOLIO_MAGIC_P = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
  let scanResults: Awaited<ReturnType<typeof connection.getProgramAccounts>>[];
  try {
    scanResults = await Promise.all(
      Array.from(v17ProgramIdsSeen.values()).map((programId) =>
        connection.getProgramAccounts(programId, {
          filters: [
            { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_P.toString("base64"), encoding: "base64" } },
            // Mutable owner (SDK PF_OWNER_OFF) is at offset 116, NOT offset 80
            // (offset 80 is provenanceOwner — IMMUTABLE). MintPositionNft moves
            // the mutable owner to the escrow PDA on wrap but leaves provenance
            // pointing at the original wallet, so filtering on 80 would still
            // match a wrapped (NFT-escrowed) portfolio here — it would render as
            // a plain owned row whose Close then fails on-chain (owner mismatch),
            // and it would poison the seenSlabs dedup below so the NFT-recovery
            // scan skips re-adding it with nftWrapped: true. Mirrors
            // useUserAccount.ts / useDeposit.ts (commit 3ae16309).
            { memcmp: { offset: 116, bytes: pkStr } },
          ],
        }),
      ),
    );
  } catch (error) {
    // Fail closed on the RPC scan ONLY: a failed owner scan makes the
    // aggregate snapshot incomplete, so reject this fetch and let
    // loadPortfolioShared keep serving the last-good cached snapshot instead
    // of caching/publishing partial positions, balances, PnL, or totals.
    console.debug("[usePortfolio] v17 owner-scan failed:", error);
    throw error;
  }

  for (const portfolioResults of scanResults) {
    for (const { pubkey, account: portAcct } of portfolioResults) {
      // Per-account isolation (mirrors the NFT recovery pass below): the scan
      // itself succeeded, so ONE permanently-unparseable account (e.g. a
      // truncated/magic-matching account or version skew) must only lose that
      // account, NOT reject every future fetch — rethrowing parse errors here
      // would blank the portfolio forever with no self-heal.
      try {
        const portData = portAcct.data instanceof Buffer ? portAcct.data : Buffer.from(portAcct.data);
        // Skip the market's LP portfolio (owner == this wallet only when this
        // wallet is the market's CREATOR) — a creator's OWN portfolio page
        // must not list the market's seeded LP liquidity as their position.
        // See isLpPortfolio's doc comment.
        if (isLpPortfolio(portData)) continue;
        const portfolio = parsePortfolioV17(portData);
        // Defense-in-depth: re-verify the mutable owner actually matches after
        // fetch — memcmp filters are advisory server-side; don't trust them
        // blindly (same re-verify as useUserAccount.ts / useDeposit.ts).
        if (!portfolio.owner.equals(publicKey)) continue;

        // Group by the slab this portfolio belongs to (dropped from the
        // RPC filter above) — only positions on a market we actually
        // discovered have oracle/margin context to render correctly.
        const slabAddrStr = portfolio.marketGroupId?.toBase58();
        if (!slabAddrStr) continue;
        const meta = marketMetaBySlab.get(slabAddrStr);
        if (!meta) continue;

        const pos = buildV17Position(
          portfolio,
          meta.oraclePriceE6,
          meta.maintenanceMarginBps,
          slabAddrStr,
          meta.market,
          false,
          meta.initialMarginBps,
          resolveSymbol(slabAddrStr, symbolBySlab),
          pkStr,
          meta.adlFactors,
        );

        if (pos.liquidationDistancePct <= 30 && pos.account.positionSize !== 0n) {
          riskCount++;
        }

        allPositions.push(pos);
        pnlSum += isSentinelValue(pos.account.pnl) ? 0n : pos.account.pnl;
        depositSum += pos.account.capital;
        unrealizedPnlSum += pos.unrealizedPnl;
      } catch (error) {
        console.debug(
          `[usePortfolio] skipping unparseable v17 portfolio account ${pubkey?.toBase58?.() ?? "?"}:`,
          error,
        );
      }
    }
  }

  // ── NFT-wrapped position recovery (v17) ──────────────────────────────
  // Minting a Position NFT B-3-transfers `portfolio.owner` to the NFT
  // program's escrow PDA, so the owner-scan above (memcmp offset 80 ==
  // wallet) never matches a wrapped portfolio — the position vanishes from
  // /portfolio after wrapping. Recover it the only way still possible:
  // scan the NFT program for PositionNfts this wallet still holds
  // (last_holder == wallet, offset 167) and load the escrowed portfolio
  // each one wraps. Scan-level failures fail CLOSED (rethrow, see the catch
  // below); only per-NFT parse errors are skipped best-effort.
  try {
    const POSITION_NFT_V17_LEN = 199;
    const NFT_LAST_HOLDER_OFF = 167;
    // Dedup guard: markets that already surfaced a (non-wrapped) position.
    const seenSlabs = new Set(allPositions.map((p) => p.slabAddress));
    const nfts = await connection.getProgramAccounts(PERCOLATOR_NFT_PROGRAM_ID, {
      filters: [
        { dataSize: POSITION_NFT_V17_LEN },
        { memcmp: { offset: NFT_LAST_HOLDER_OFF, bytes: pkStr } },
      ],
    });

    // Parse each NFT to find the escrowed portfolio it points at, then
    // batch-fetch ALL of them in one getMultipleAccountsInfo — this used
    // to be a serial getAccountInfo call PER NFT (a wallet holding
    // several wrapped positions paid one round-trip per NFT here).
    const portfolioPks: PublicKey[] = [];
    for (const nft of nfts) {
      try {
        const parsed = parsePositionNftAccount(new Uint8Array(nft.account.data as Buffer));
        portfolioPks.push(parsed.portfolioAccount);
      } catch {
        // Skip unparseable NFT accounts — nothing to batch-fetch for them.
      }
    }

    if (portfolioPks.length > 0) {
      const BATCH_SIZE = 100;
      const pfInfos: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];
      for (let i = 0; i < portfolioPks.length; i += BATCH_SIZE) {
        const chunk = portfolioPks.slice(i, i + BATCH_SIZE);
        const results = await connection.getMultipleAccountsInfo(chunk);
        pfInfos.push(...results);
      }

      for (let i = 0; i < portfolioPks.length; i++) {
        try {
          const pfInfo = pfInfos[i];
          if (!pfInfo || !pfInfo.data) continue;
          const portfolio = parsePortfolioV17(new Uint8Array(pfInfo.data));
          // Only surface a wrapped position that still has an active leg
          // (a closed-but-unburned NFT wraps a size-0 leg).
          const activeLeg = portfolio.legs.find((l) => l.active);
          if (!activeLeg || activeLeg.basisPosQ === 0n) continue;
          const slabAddrStr = portfolio.marketGroupId?.toBase58();
          if (!slabAddrStr) continue;
          // Skip if this market already produced a position, and only surface
          // markets we actually discovered (so we have oracle/margin context).
          if (seenSlabs.has(slabAddrStr)) continue;
          const meta = marketMetaBySlab.get(slabAddrStr);
          if (!meta) continue;

          const pos = buildV17Position(
            portfolio,
            meta.oraclePriceE6,
            meta.maintenanceMarginBps,
            slabAddrStr,
            meta.market,
            true, // nftWrapped
            meta.initialMarginBps,
            resolveSymbol(slabAddrStr, symbolBySlab),
            pkStr,
            meta.adlFactors,
          );

          if (pos.liquidationDistancePct <= 30 && pos.account.positionSize !== 0n) {
            riskCount++;
          }
          allPositions.push(pos);
          seenSlabs.add(slabAddrStr);
          pnlSum += isSentinelValue(pos.account.pnl) ? 0n : pos.account.pnl;
          depositSum += pos.account.capital;
          unrealizedPnlSum += pos.unrealizedPnl;
        } catch {
          // Resilient per-NFT: skip on any parse error.
        }
      }
    }
  } catch (error) {
    // Fail closed: a wallet holding NFT-wrapped positions whose recovery scan
    // fails would otherwise cache a "successful" snapshot MISSING those
    // positions (and their capital/PnL) over the last-good one. Per-NFT parse
    // errors are already isolated by the inner try/catches above — only
    // scan/batch-level RPC failures reach here, and those reject the fetch so
    // loadPortfolioShared preserves the previous complete snapshot.
    console.debug("[usePortfolio] NFT-wrapped position recovery failed:", error);
    throw error;
  }

  // Sort: at-risk positions first, then by PnL
  allPositions.sort((a, b) => {
    // Active positions (has size) before flat/empty
    const aActive = a.account.positionSize !== 0n ? 0 : 1;
    const bActive = b.account.positionSize !== 0n ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    // Then by liquidation severity
    const aSev = getLiquidationSeverity(a.liquidationDistancePct);
    const bSev = getLiquidationSeverity(b.liquidationDistancePct);
    const sevOrder = { danger: 0, warning: 1, safe: 2 };
    if (sevOrder[aSev] !== sevOrder[bSev]) return sevOrder[aSev] - sevOrder[bSev];
    // Then by PnL — bigint compare to avoid Number() precision loss
    // (positions with PnL > Number.MAX_SAFE_INTEGER would otherwise
    // produce a garbage sign and shuffle on each refresh).
    if (b.unrealizedPnl > a.unrealizedPnl) return 1;
    if (b.unrealizedPnl < a.unrealizedPnl) return -1;
    // Stable tiebreaker: sort by slab address to prevent random reordering
    return a.slabAddress.localeCompare(b.slabAddress);
  });

  return {
    positions: allPositions,
    totalPnl: pnlSum,
    totalDeposited: depositSum,
    totalValue: depositSum + unrealizedPnlSum,
    totalUnrealizedPnl: unrealizedPnlSum,
    atRiskCount: riskCount,
  };
}

interface PortfolioCacheEntry {
  snapshot: PortfolioSnapshot;
  ts: number;
}

/** How long a cached snapshot is served to a NEW (non-forced) caller before a
 *  fresh scan is required. Short enough that the periodic 30s auto-refresh
 *  (see the visibility effect below) always ends up doing a real fetch, but
 *  long enough to collapse near-simultaneous mounts (e.g. all 4 /dashboard
 *  widgets on first paint, or a route navigation that remounts a portfolio
 *  widget) into a single scan. */
const PORTFOLIO_CACHE_TTL_MS = 12_000;

/**
 * How stale a cached snapshot may be and still be handed back SYNCHRONOUSLY
 * as a component's initial state (see `peekPortfolioSnapshot` + the lazy
 * `useState` initializers in `usePortfolio` below). This is deliberately a
 * SEPARATE, much longer window than `PORTFOLIO_CACHE_TTL_MS`: that constant
 * governs whether a NEW concurrent scan is skipped (a dedup TTL); this one
 * only governs "is this old snapshot still good enough to paint instantly
 * while a real refresh runs in the background" — a stale-while-revalidate
 * seed, not a cache-freshness guarantee. Five minutes covers the common case
 * (navigating away and back within the same session) without ever risking a
 * genuinely-stale portfolio being mistaken for the fetch effect's real,
 * always-still-running 30s refresh.
 */
const PORTFOLIO_SEED_MAX_AGE_MS = 5 * 60_000;

const portfolioSnapshotCache = new Map<string, PortfolioCacheEntry>();
const portfolioInflight = new Map<string, Promise<PortfolioSnapshot>>();

function portfolioCacheKey(walletBase58: string, network: string): string {
  return `${network}:${walletBase58}`;
}

/**
 * Read-only, synchronous peek at the last scan's snapshot for (wallet,
 * network) — no fetch, no dedup/inflight join, never mutates the cache.
 * Exists so `usePortfolio`'s `useState` calls can lazily seed from whatever
 * the LAST mounted instance already scanned, instead of always starting
 * blank/loading on every mount (e.g. a route navigation away from and back
 * to /portfolio). Returns `null` when there's no entry, or the entry is
 * older than `PORTFOLIO_SEED_MAX_AGE_MS` — a stale seed would show wrong
 * numbers for longer than "stale-while-revalidate" should tolerate.
 */
export function peekPortfolioSnapshot(key: string): PortfolioSnapshot | null {
  const cached = portfolioSnapshotCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts >= PORTFOLIO_SEED_MAX_AGE_MS) return null;
  return cached.snapshot;
}

/**
 * Dedup + short-TTL cache in front of fetchPortfolioSnapshot, keyed by
 * (wallet, network). This is what collapses N mounted usePortfolio()
 * instances into ONE actual scan cycle: concurrent callers for the same key
 * share one in-flight request instead of each firing off its own full
 * market-discovery + gPA scan.
 *
 * `force` skips the TTL cache read (but still JOINS an in-flight request if
 * one happens to already be running) — used by the hook's `refresh()` so an
 * explicit user action (e.g. closing a position) always gets a real fresh
 * read instead of silently replaying a stale cached snapshot.
 */
export function loadPortfolioShared(
  key: string,
  force: boolean,
  fetcher: () => Promise<PortfolioSnapshot>,
): Promise<PortfolioSnapshot> {
  if (!force) {
    const cached = portfolioSnapshotCache.get(key);
    if (cached && Date.now() - cached.ts < PORTFOLIO_CACHE_TTL_MS) {
      return Promise.resolve(cached.snapshot);
    }
  }

  const existing = portfolioInflight.get(key);
  if (existing) return existing;

  const p = fetcher()
    .then((snapshot) => {
      portfolioSnapshotCache.set(key, { snapshot, ts: Date.now() });
      return snapshot;
    })
    .finally(() => {
      portfolioInflight.delete(key);
    });
  portfolioInflight.set(key, p);
  return p;
}

/**
 * Fetches all markets and finds positions for the connected wallet.
 * Enriches each position with liquidation price, PnL %, and risk leverage.
 *
 * @param enabled - Gates the HOOK itself, not just what a caller does with its
 *   output. When `false`, both the fetch effect (market discovery + a batched
 *   `getMultipleAccountsInfo` + up to two `getProgramAccounts` scans per
 *   market) and the 30s auto-refresh interval are short-circuited — nothing
 *   fires and no RPC calls are made. Defaults to `true` so every existing
 *   call site (portfolio page, dashboard widgets) is unaffected. Callers
 *   that only conditionally need portfolio data — e.g. the site-wide
 *   PositionsBar strip and trade's OtherMarketPositions dock, which pass
 *   `walletConnected` so a disconnected wallet never scans — must pass
 *   `enabled` here rather than gate their render only, otherwise this hook
 *   still pays the full RPC cost even though nothing reads its output.
 *   (Concurrent ENABLED instances are cheap: `loadPortfolioShared` dedups
 *   them into one scan cycle.)
 */
export function usePortfolio(enabled: boolean = true): PortfolioData {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();

  // Synchronous seed: peek whatever the LAST scan for THIS (wallet, network)
  // already produced, so a return visit (e.g. navigating back to /portfolio,
  // or a second widget mounting after the first already scanned) paints
  // instantly instead of flashing an empty/loading UI while the fetch effect
  // below re-runs. `peekPortfolioSnapshot` itself enforces the freshness
  // window (`PORTFOLIO_SEED_MAX_AGE_MS`) — a too-old entry seeds nothing here.
  // Deliberately only read at the FIRST render of a given publicKey identity;
  // the wallet-identity-change effect below re-peeks (and this closure over
  // `publicKey` is fine for that: lazy useState initializers only ever run
  // once per mount, not once per render).
  const peekNow = (): PortfolioSnapshot | null =>
    publicKey ? peekPortfolioSnapshot(portfolioCacheKey(publicKey.toBase58(), getNetwork())) : null;

  const [positions, setPositions] = useState<PortfolioPosition[]>(() => peekNow()?.positions ?? []);
  const [totalPnl, setTotalPnl] = useState<bigint>(() => peekNow()?.totalPnl ?? 0n);
  const [totalDeposited, setTotalDeposited] = useState<bigint>(() => peekNow()?.totalDeposited ?? 0n);
  const [totalValue, setTotalValue] = useState<bigint>(() => peekNow()?.totalValue ?? 0n);
  const [totalUnrealizedPnl, setTotalUnrealizedPnl] = useState<bigint>(() => peekNow()?.totalUnrealizedPnl ?? 0n);
  const [atRiskCount, setAtRiskCount] = useState(() => peekNow()?.atRiskCount ?? 0);
  // loading = !snapshot: if we found a fresh-enough seed, skip straight past
  // the "nothing to show yet" state — the fetch effect below still runs and
  // (via `hasLoadedOnce` below, also seeded) treats it as a background
  // refresh (`isRefreshing`), not an initial load.
  const [loading, setLoading] = useState(() => peekNow() === null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasLoadedOnce = useRef(peekNow() !== null);
  const [refreshCounter, setRefreshCounter] = useState(0);
  // Set by `refresh()` just before it bumps refreshCounter, and consumed
  // (read + reset) at the start of the next fetch effect run — see that
  // effect's comment and loadPortfolioShared's `force` param.
  const forceNextLoad = useRef(false);

  // Reset (or re-seed) initial-load lifecycle when wallet identity changes
  // (CodeRabbit fix). Originally this unconditionally blanked state to
  // force a fresh "loading" UI on every wallet switch — but if the NEW
  // identity already has its own fresh-enough cached snapshot (e.g.
  // switching back to a wallet used earlier this session), re-peek and seed
  // from it instead of needlessly blanking to empty/loading.
  const prevPublicKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const pkStr = publicKey?.toBase58() ?? null;
    if (pkStr === prevPublicKeyRef.current) return;
    prevPublicKeyRef.current = pkStr;
    setIsRefreshing(false);

    const snap = pkStr ? peekPortfolioSnapshot(portfolioCacheKey(pkStr, getNetwork())) : null;
    if (snap) {
      setPositions(snap.positions);
      setTotalPnl(snap.totalPnl);
      setTotalDeposited(snap.totalDeposited);
      setTotalValue(snap.totalValue);
      setTotalUnrealizedPnl(snap.totalUnrealizedPnl);
      setAtRiskCount(snap.atRiskCount);
      setLoading(false);
      hasLoadedOnce.current = true;
      return;
    }

    // No fresh cached snapshot for the new identity — blank until the fetch
    // effect below resolves, same as the pre-existing behavior.
    setPositions([]);
    setTotalPnl(0n);
    setTotalDeposited(0n);
    setTotalValue(0n);
    setTotalUnrealizedPnl(0n);
    setAtRiskCount(0);
    setLoading(true);
    hasLoadedOnce.current = false;
  }, [publicKey]);

  useEffect(() => {
    if (!enabled || !publicKey) {
      setPositions([]);
      setTotalPnl(0n);
      setTotalDeposited(0n);
      setTotalValue(0n);
      setTotalUnrealizedPnl(0n);
      setAtRiskCount(0);
      // Only clear the loading flag when there's truly nothing to wait on.
      // `enabled` flipping false shouldn't leave a stale "loading" state
      // behind for when it flips back to true, but it also shouldn't fire
      // any of the fetch work below — the early return already prevents that.
      setLoading(false);
      setIsRefreshing(false);
      hasLoadedOnce.current = false;
      return;
    }

    let cancelled = false;
    const programIds = getAllProgramIds();
    const cacheKey = portfolioCacheKey(publicKey.toBase58(), getNetwork());
    // Consume-and-reset: a `refresh()` call sets this before bumping
    // refreshCounter, so THIS run bypasses the shared TTL cache, while the
    // periodic 30s auto-refresh (which bumps refreshCounter directly, not via
    // `refresh()`) goes through the cache like any other instance.
    const force = forceNextLoad.current;
    forceNextLoad.current = false;

    async function load() {
      try {
        if (hasLoadedOnce.current) {
          setIsRefreshing(true);
        } else {
          setLoading(true);
        }
        // The actual scan is shared across every usePortfolio() instance
        // mounted for this same (wallet, network) — see loadPortfolioShared's
        // doc comment. This hook instance only applies the result to ITS OWN
        // component state, gated on ITS OWN `cancelled` flag.
        const snapshot = await loadPortfolioShared(cacheKey, force, () =>
          // Non-null: this closure only runs inside the `!publicKey` early-return
          // guard above, same as every other publicKey! use in this file (TS
          // can't narrow a closed-over value inside a nested function).
          fetchPortfolioSnapshot(connection, publicKey!, programIds),
        );
        if (!cancelled) {
          setPositions(snapshot.positions);
          setTotalPnl(snapshot.totalPnl);
          setTotalDeposited(snapshot.totalDeposited);
          setTotalValue(snapshot.totalValue);
          setTotalUnrealizedPnl(snapshot.totalUnrealizedPnl);
          setAtRiskCount(snapshot.atRiskCount);
        }
      } catch (error) {
        // This used to be a fully silent catch — a hard failure (e.g. RPC
        // outage mid-load) left `loading: false` with an empty/stale position
        // list and NO signal anywhere that anything went wrong. PortfolioData
        // has no `error` field to surface this through today (adding one is a
        // public-API change out of scope for this fix), so at minimum this is
        // now visible in the console instead of vanishing entirely.
        console.debug("[usePortfolio] load() failed:", error);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setIsRefreshing(false);
          hasLoadedOnce.current = true;
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [enabled, connection, publicKey, refreshCounter]);

  const refresh = () => {
    forceNextLoad.current = true;
    setRefreshCounter((c) => c + 1);
    // Reconciliation burst (mirrors useTrade's [1200, 2200, 3500]): an
    // immediate refresh after a close reads back through /api/rpc's
    // account-data cache (getAccountInfo ~1s, getProgramAccounts ~1.5s) and so
    // re-publishes the PRE-close snapshot. Without a follow-up, the card kept
    // showing the old size until the 30s poll — which is exactly what tempts a
    // user into clicking Close a second time on a position that is already
    // (partially) closed.
    [1400, 2600, 4000].forEach((ms) =>
      setTimeout(() => {
        forceNextLoad.current = true;
        setRefreshCounter((c) => c + 1);
      }, ms),
    );
  };

  // Auto-refresh when tab becomes visible (e.g., after closing position on trade page)
  // and every 30s while visible. Gated on `enabled` too — otherwise a
  // disabled hook instance (e.g. PositionsBar with the wallet disconnected) would still
  // bump `refreshCounter` every 30s, which the fetch effect above depends on
  // and would just re-run (uselessly, since it early-returns) forever.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setRefreshCounter((c) => c + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        setRefreshCounter((c) => c + 1);
      }
    }, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [enabled]);

  return { positions, totalPnl, totalDeposited, totalValue, totalUnrealizedPnl, atRiskCount, loading, isRefreshing, refresh };
}
