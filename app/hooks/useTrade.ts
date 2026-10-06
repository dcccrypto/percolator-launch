"use client";

import { tradeCuCap } from "@/lib/compute-budget";
import { useCallback, useEffect, useRef, useState } from "react";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import {
  encodeTradeCpi,
  encodePermissionlessCrank,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  buildIx,
  deriveLpPda,
  derivePythPushOraclePDA,
  deriveMatcherDelegate,
  isV17Account,
  parsePortfolioV17,
} from "@percolatorct/sdk";
// TODO(oracle-migration): encodePushOraclePrice/ACCOUNTS_PUSH_ORACLE_PRICE removed in beta.29.
// The DEX oracle inline push path needs to migrate to /api/oracle/advance-phase.
import {
  encodePushOraclePrice,
  ACCOUNTS_PUSH_ORACLE_PRICE,
} from "@/lib/sdk-compat";
import {
  sendTx,
  sendTxWaiting,
  prewarmTxLanding,
  simulateForGate,
  SimulationRefusal,
  buildBatchTx,
  signAllCompat,
  broadcastSignedTx,
  getPriorityFee,
} from "@/lib/tx";
import { planTakerCrank } from "@/lib/taker-crank";
import { isAllocateRefusal, planAllocatePrefix } from "@/lib/v21/allocate-prefix";
import { isDevnetV21Enabled } from "@/lib/v21/flag";
import { getMaintenanceConfig, MaintenanceError } from "@/lib/maintenance";
import { PartialLegSendError, SINGLE_TX_MAX_LEGS, sendLegGroups } from "@/lib/trade-leg-groups";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { resolveMarketLp } from "@/lib/market-lp";
import { applyConfirmedFill, getPortfolioRawSnapshot, makePortfolioScanKey } from "@/lib/userAccountScan";
import { limitsFlags } from "@/lib/limits/flags";
import { decodeMarketEngineView, signedPositionForAsset } from "@/lib/limits/decode";
import { measureFill, recordFillResult } from "@/lib/limits/fill-check";
import { tradeFeeBpsToSign } from "@/lib/limits/fee-channel";
import { useSlabState } from "@/components/providers/SlabProvider";
import { detectOracleMode, resolveMarketPriceE6 } from "@/lib/oraclePrice";
import { assertKnownProgram, assertCanonicalMatcher } from "@/lib/programAllowlist";
import { invalidateMatcherCaps } from "@/lib/matcherCaps";
import { getLivePriceSnapshot } from "@/lib/priceStore/priceStore";
import { computeLimitPriceE6, assertFeedAgreesWithChain } from "@/lib/slippage";
import { fetchPortfolioIdentity, fetchAssetMarketId, defaultCrankObservations } from "@/lib/v18-wire";
import { buildTradeIxs } from "@/lib/trade-ix";
import { isPortfolioAccount } from "@/lib/portfolio-account";
import { findOwnerPortfolio } from "@/lib/owner-portfolio";

// ---------------------------------------------------------------------------
// v17 portfolio account layout constants
// (mirrored from v16_program.rs state module — update if the program layout changes)
// ---------------------------------------------------------------------------

// V17 portfolio account magic (first 8 bytes, little-endian): PERCV16\0
// Used as the memcmp filter for getProgramAccounts.
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

// Provenance header offsets (HEADER_LEN=16, then provenance at +0)
// market_group_id is at HEADER_LEN(16) + provenance.market_group_id(0) = 16
// portfolio_account_id is at HEADER_LEN(16) + 32 = 48
// provenanceOwner (IMMUTABLE — set at portfolio creation, never changes) is at
// HEADER_LEN(16) + 64 = 80 (lib/market-lp.ts reads it for the LP's delegate derivation).
const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16; // offset 16 in raw account data

// The TAKER's own-portfolio discovery (mutable owner @116, not provenanceOwner@80)
// lives in lib/owner-portfolio.ts.

// The LP side (accountB) and its matcher config are read in lib/market-lp.ts.

/**
 * Find the v17 standalone portfolio account for a given (market, owner) pair.
 * `null` ONLY when the scan completed and found none; an RPC failure is retried
 * and then thrown as PortfolioLookupError (M-4 — a swallowed 429 used to read as
 * "no account" and the first-trade flow created a duplicate portfolio). The
 * selector is the shared one in lib/owner-portfolio.ts.
 *
 * Shared with useFirstTrade / useClosePosition.
 */
export async function findV17Portfolio(
  connection: Connection,
  programId: PublicKey,
  marketPk: PublicKey,
  ownerPk: PublicKey,
): Promise<PublicKey | null> {
  return findOwnerPortfolio(connection, programId, marketPk, ownerPk);
}

// ============================================================================
// v17 trade-account resolution — cached + prewarmable
// ============================================================================
//
// Resolving the 5 non-obvious TradeCpi accounts used to happen INLINE at
// submit time: a getProgramAccounts scan over every portfolio on the market
// (LP discovery) plus a second owner-filtered scan (taker portfolio) — two
// heavy RPC round-trips between the user clicking confirm and the wallet
// popup appearing. All five values are stable for a given (market, taker):
// portfolio addresses never change, and the LP's matcher config only changes
// on an explicit SetMatcherConfig. So they're resolved once, cached briefly
// (TTL below), prewarmed the moment the confirmation modal opens (the user's
// reading time absorbs the scans), and invalidated on any trade failure so a
// retry re-resolves fresh.
//
// SECURITY: assertCanonicalMatcher runs inside the resolver — cached values
// have passed the same gate as inline-resolved ones.

interface V17TradeAccounts {
  accountA: PublicKey;
  accountB: PublicKey;
  matcherProg: PublicKey;
  matcherCtx: PublicKey;
  matcherDelegate: PublicKey;
}

/** Short TTL: matcherCtx/matcherProg can in principle be rotated by the LP
 *  (SetMatcherConfig); 60s staleness at worst produces one failed tx, which
 *  invalidates the entry and the retry re-resolves fresh. */
const V17_TRADE_ACCOUNTS_TTL_MS = 60_000;
const v17TradeAccountsCache = new Map<string, { value: V17TradeAccounts; ts: number }>();
const v17TradeAccountsInflight = new Map<string, Promise<V17TradeAccounts>>();

function tradeAccountsKey(programId: PublicKey, slabPk: PublicKey, takerPk: PublicKey): string {
  return `${programId.toBase58()}|${slabPk.toBase58()}|${takerPk.toBase58()}`;
}

/** Drop a cached resolution (called when a trade fails — the failure may be a
 *  rotated matcher config or a migrated portfolio, so re-resolve next time). */
function invalidateV17TradeAccounts(programId: PublicKey, slabPk: PublicKey, takerPk: PublicKey): void {
  v17TradeAccountsCache.delete(tradeAccountsKey(programId, slabPk, takerPk));
}

/** The LP side of a trade (accountB + its matcher), without the taker (UX WP-6 first trade). */
export async function resolveLpTradeAccounts(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
): Promise<Omit<V17TradeAccounts, "accountA">> {
  // accountB is the market's LP chosen by ON-CHAIN IDENTITY (lib/market-lp.ts): the bound
  // P3 vault LP, else the portfolio owned by asset 0's asset_admin, else the launch
  // portfolio; and its matcher ctx must be bound to it (ctx.lp_pda == the derived
  // delegate). NEVER "the first portfolio with an enabled matcher": anyone can enable a
  // matcher on their own portfolio and would become every user's counterparty.
  // Curated markets may pin the address in PLAYGROUND_SLAB_META (a cheap first try that
  // must still pass every rule).
  const known = PLAYGROUND_SLAB_META[slabPk.toBase58()]?.lp_portfolio_address;
  let knownPk: PublicKey | null = null;
  try {
    knownPk = known ? new PublicKey(known) : null;
  } catch {
    knownPk = null;
  }
  let lp;
  try {
    lp = await resolveMarketLp(connection, programId, slabPk, knownPk);
  } catch (scanErr) {
    throw new Error(
      `Failed to scan LP portfolio accounts on-chain: ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
    );
  }
  if (!lp) {
    throw new Error(
      "No LP portfolio with an active matcher config found for this market. " +
      "The LP must call SetMatcherConfig before trading.",
    );
  }
  // SEC: matcherProg/matcherCtx come from the LP portfolio's on-chain matcher config —
  // attacker-controlled for an attacker-created market. The trade ix places matcherProg as
  // the executable CPI target [4] and matcherCtx as a writable account [5], so pin the
  // matcher to the canonical one before we build a signable tx around it. Runs on every
  // resolution, so cached values have passed this gate too.
  assertCanonicalMatcher(lp.matcherProg);
  return {
    accountB: lp.pubkey,
    matcherProg: lp.matcherProg,
    matcherCtx: lp.matcherCtx,
    // Bound to the ctx by resolveMarketLp (== deriveMatcherDelegate(..., lp.owner, ...)).
    matcherDelegate: lp.matcherDelegate,
  };
}

export async function resolveV17TradeAccounts(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
  takerPk: PublicKey,
): Promise<V17TradeAccounts> {
  const lp = await resolveLpTradeAccounts(connection, programId, slabPk);

  // ── accountA: the taker's own portfolio ──────────────────────────────────
  // The shared scan store (useUserAccount and friends) almost always already
  // knows it — its pubkey never changes for a (wallet, market) pair, so any
  // cached snapshot is authoritative. Fall back to the owner-filtered scan.
  let accountA: PublicKey | null = null;
  const snapshot = getPortfolioRawSnapshot(
    makePortfolioScanKey(programId, slabPk.toBase58(), takerPk),
  );
  if (snapshot && snapshot.portfolio.owner.equals(takerPk)) {
    accountA = snapshot.pubkey;
  } else {
    accountA = await findV17Portfolio(connection, programId, slabPk, takerPk);
  }
  if (!accountA) {
    throw new Error(
      "No portfolio account found for your wallet on this market. " +
      "Please deposit collateral first to create a portfolio.",
    );
  }

  return { accountA, ...lp };
}

/** Cache-or-resolve with in-flight dedup (prewarm + submit share one scan). */
function getOrResolveV17TradeAccounts(
  connection: Connection,
  programId: PublicKey,
  slabPk: PublicKey,
  takerPk: PublicKey,
): Promise<V17TradeAccounts> {
  const key = tradeAccountsKey(programId, slabPk, takerPk);
  const cached = v17TradeAccountsCache.get(key);
  if (cached && Date.now() - cached.ts < V17_TRADE_ACCOUNTS_TTL_MS) {
    return Promise.resolve(cached.value);
  }
  const inflight = v17TradeAccountsInflight.get(key);
  if (inflight) return inflight;
  const p = resolveV17TradeAccounts(connection, programId, slabPk, takerPk)
    .then((value) => {
      v17TradeAccountsCache.set(key, { value, ts: Date.now() });
      return value;
    })
    .finally(() => {
      v17TradeAccountsInflight.delete(key);
    });
  v17TradeAccountsInflight.set(key, p);
  return p;
}

/**
 * Prewarm the v17 trade-account resolution + the tx-landing caches
 * (blockhash, priority fee, clock drift) so a subsequent trade() reaches the
 * wallet popup with zero blocking RPC round-trips. Call when the trade
 * confirmation modal OPENS. Fire-and-forget safe.
 */
export function prewarmTradeSubmission(
  connection: Connection,
  programId: PublicKey | null,
  slabAddress: string,
  takerPk: PublicKey | null,
): void {
  prewarmTxLanding(connection);
  if (!programId || !takerPk) return;
  try {
    const slabPk = new PublicKey(slabAddress);
    void getOrResolveV17TradeAccounts(connection, programId, slabPk, takerPk).catch(() => {});
  } catch {
    /* malformed address — nothing to prewarm */
  }
}

export function useTrade(slabAddress: string) {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { config: mktConfig, accounts, raw, programId: slabProgramId, wrapperConfigV17, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);
  // Guards the catch/finally setState calls below against firing after this
  // component has unmounted — trade() does several sequential on-chain
  // awaits (portfolio scans, sendTx confirmation), and OrderTicket/PositionPanel
  // can unmount (market switch, navigation) while one of those is still in
  // flight, e.g. on a slow devnet RPC round trip.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const trade = useCallback(
    async (params: {
      lpIdx: number;
      userIdx: number;
      /** Signed TOTAL size — slippage limit, store patch, and the single-leg path all use this. */
      size: bigint;
      /**
       * Optional leg split for sizes over the matcher's per-fill cap
       * (lib/closeChunks.ts). Legs must sum to `size`; >1 leg builds one
       * single-leg TradeCpi per leg in ONE transaction (lib/trade-ix.ts buildTradeIxs; a
       * same-asset BatchTradeCpi is refused on-chain) — each leg passes the
       * matcher's per-fill clamp individually, one signature for the lot.
       */
      sizes?: bigint[];
      limitPriceE6?: bigint;
      /**
       * P2 fee channel (lib/limits/fee-channel.ts): the taker-SIGNED fee cap, base +
       * the quote's requested fee, when the protocol enabled the channel for this asset.
       * Omitted => the market's base trade fee (the only value accepted without it).
       */
      feeBps?: bigint;
      /** UX WP-2: called while the app waits for the market (no prompt yet): true / false. */
      onWaiting?: (waiting: boolean) => void;
      /** UX WP-3: the ticket's "Stop" ends the wait loop (no prompt was opened). */
      abortSignal?: AbortSignal;
      /** UX WP-3: keep waiting past the schedule (with Stop) and say so after ~30 s. */
      keepWaiting?: boolean;
      onWaitingLong?: () => void;
    }) => {
      if (inflightRef.current) throw new Error("Trade already in progress");
      inflightRef.current = true;
      setLoading(true);
      setError(null);
      try {
        if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
        // Defense-in-depth: refuse to build a tx whose programId is not in
        // our deployed allowlist. See SlabProvider.parseSlab for the primary
        // gate.
        assertKnownProgram(slabProgramId);

        const programId = slabProgramId;
        const slabPk = new PublicKey(slabAddress);

        // Read the current mark price NON-reactively, at submit time — not
        // via the useLivePrice() hook. useTrade() is called from the trade
        // form's top level, so subscribing here would force that component
        // to re-render on every price tick just to source a value that's
        // only ever used inside this callback (see BUILD-LOG Phase 0
        // finding #3 / Phase 1). getLivePriceSnapshot() is a plain,
        // non-subscribing read of the same store useLivePrice() reads from
        // — same freshness guarantee (in fact fresher: read at the instant
        // of submit, not at the instant of last render), same values, zero
        // render cost. This changes only *where* the price value is read
        // from, not the tx-building logic below.
        const { priceE6: livePriceE6 } = getLivePriceSnapshot(slabAddress);

        // Slippage protection. The on-chain handler treats limit_price_e6 == 0
        // as a "no limit" sentinel and skips the slippage check entirely
        // (percolator.rs::handle_trade_cpi). Without a real limit, the only
        // remaining defense is the anti-off-market band (~1% by default),
        // leaving the user exposed within that band to a hostile matcher or
        // an in-band MEV race. Derive a non-zero limit from the live mark
        // when the caller omits one. An explicit `limitPriceE6: 0n` from the
        // caller is preserved as an opt-in escape hatch for keeper/bot paths
        // that intentionally skip the check.
        const effectiveLimitPriceE6: bigint =
          params.limitPriceE6 !== undefined
            ? params.limitPriceE6
            : computeLimitPriceE6({ markE6: livePriceE6 ?? 0n, size: params.size });

        // Determine oracle mode using centralised detectOracleMode (oraclePrice.ts).
        // "pyth-pinned" = Pyth feed; "admin" or "hyperp" = use slab as oracle account.
        const oracleMode = detectOracleMode({ ...mktConfig, oracleModeByte: wrapperConfigV17?.oracleMode });
        const useAdminOracle = oracleMode !== "pyth-pinned";
        const feedHex = Array.from(mktConfig.indexFeedId.toBytes()).map(b => b.toString(16).padStart(2, "0")).join("");
        const oracleAccount = useAdminOracle ? slabPk : derivePythPushOraclePDA(feedHex)[0];

        const instructions: TransactionInstruction[] = [];

        // v18 AUTH_MARK markets are priced by the off-chain keeper (which holds the
        // oracle authority and pushes a fresh mark every few seconds). The old flow
        // pushed the oracle price INLINE before trading whenever the connected wallet
        // WAS the oracle authority — but that instruction was removed on-chain in
        // beta.29, and throwing here blocked the authority wallet from trading at all
        // (which is exactly the wallet a market creator / operator tests with). There
        // is nothing to push inline: the keeper keeps the mark fresh, so the trade
        // proceeds like any other wallet's. If the mark is genuinely stale (keeper
        // down), the program returns OracleStale(27), surfaced as a "try again" hint.

        // GH#2525 (item 1): the binding on-chain slippage limit is derived from
        // the OFF-CHAIN feed, so check that feed against the ON-CHAIN oracle —
        // the price the trade actually settles against.
        //
        // Sanitisation used to be an ABSOLUTE band only (reject <= 0, reject
        // > $1,000,000), with nothing relative to the chain. A feed biased high
        // therefore widened the band an adversarial matcher or LP could fill
        // inside, and the "worst fill price" on the confirm screen was only as
        // honest as the feed: the user believes they set a 0.5% limit, but it is
        // 0.5% around a number someone else chose.
        //
        // DELIBERATELY placed here, after the oracle-mode and inline-push guards,
        // rather than next to the limit derivation above. This is defence in
        // depth, and it must not pre-empt a more specific primary error — an
        // earlier draft ran it first and made "inline oracle push was removed"
        // surface as a price-disagreement message instead, which is a worse
        // diagnosis for the same underlying misconfiguration.
        //
        // Only guards the DERIVED limit. An explicit `limitPriceE6` is the user's
        // own number and passes through untouched.
        if (params.limitPriceE6 === undefined) {
          const onChainRefE6 = resolveMarketPriceE6({
            ...mktConfig,
            oracleModeByte: wrapperConfigV17?.oracleMode,
          });
          assertFeedAgreesWithChain({
            feedE6: livePriceE6 ?? 0n,
            onChainE6: onChainRefE6 > 0n ? onChainRefE6 : null,
          });
        }

        // ── v17 TradeCpi account resolution ──────────────────────────────────
        // v17 TradeCpi (tag 10) requires 7 accounts:
        //   [0] signerA       signer (taker wallet)
        //   [1] market        writable (market group account = slabPk)
        //   [2] accountA      writable (taker's standalone v17 portfolio)
        //   [3] accountB      writable (LP's standalone v17 portfolio)
        //   [4] matcherProg   readonly executable (external matcher program)
        //   [5] matcherCtx    writable (matcher context account)
        //   [6] matcherDelegate readonly (PDA: deriveMatcherDelegate)
        //
        // v12 stale accounts removed: lpOwner (signer), clock, oracle, lpPda.
        // See v16_program.rs::handle_trade_cpi (line ~7338).

        // B-6: Detect v17 using the same SDK isV17Account check as useClosePosition,
        // rather than the `accounts.length === 0` heuristic which misidentifies v12
        // markets with no LP yet (empty bitmap) as v17 markets.
        const isV17Market = raw != null && raw.length > 0 && isV17Account(raw);

        let accountA: PublicKey;
        let accountB: PublicKey;
        let matcherProg: PublicKey;
        let matcherCtx: PublicKey;
        let matcherDelegate: PublicKey;

        if (!isV17Market) {
          // ── v12 market path ────────────────────────────────────────────────
          // LP account data comes from the parsed slab bitmap.
          // accountB = deriveLpPda (the LP's portfolio PDA in v12)
          // matcherProg/matcherCtx from the parsed LP account entry
          const lpAccount = accounts.find((a) => a.idx === params.lpIdx);
          if (!lpAccount) throw new Error(`LP at index ${params.lpIdx} not found`);

          const [lpPda] = deriveLpPda(programId, slabPk, params.lpIdx);
          accountA = wallet.publicKey; // v12: taker wallet; program validates via signer check
          accountB = lpPda;
          matcherProg = lpAccount.account.matcherProgram;
          matcherCtx = lpAccount.account.matcherContext;
          // NOTE: the canonical-matcher assertion is applied on the v17 path
          // below (every current playground market is v17). It is deliberately
          // NOT added to this legacy v12 branch — v12's matcher invariants
          // aren't verifiable from the client here, and no current market
          // takes this path, so guarding it risks changing legacy behavior for
          // no live benefit.
          const [delegatePk] = deriveMatcherDelegate(
            programId, slabPk, accountB, lpAccount.account.owner, matcherProg, matcherCtx,
          );
          matcherDelegate = delegatePk;
        } else {
          // ── v17 market path ────────────────────────────────────────────────
          // Full resolution logic (LP-portfolio discovery + matcher config +
          // canonical-matcher assertion + delegate derivation + taker
          // portfolio lookup) lives in resolveV17TradeAccounts above — cached
          // 60s and prewarmed when the confirmation modal opens, so this is
          // normally an instant cache hit instead of two program scans
          // between the confirm click and the wallet popup.
          const resolved = await getOrResolveV17TradeAccounts(connection, programId, slabPk, wallet.publicKey);
          accountA = resolved.accountA;
          accountB = resolved.accountB;
          matcherProg = resolved.matcherProg;
          matcherCtx = resolved.matcherCtx;
          matcherDelegate = resolved.matcherDelegate;
        }

        // Leg split (defaults to the single full-size leg). The sum invariant
        // is enforced here, not trusted: a split that doesn't reproduce
        // params.size exactly would silently close the wrong amount.
        const legs: bigint[] =
          params.sizes && params.sizes.length > 0 ? params.sizes : [params.size];
        if (legs.reduce((a, b) => a + b, 0n) !== params.size) {
          throw new Error("Trade leg split does not sum to the requested size");
        }
        // BatchTradeCpi is a v17 instruction (tag 67); the v12 wrapper has no
        // such tag. Unreachable today (caps never resolve on v12 slabs, so
        // callers can't produce legs), but nothing structural stops a future
        // caller — fail loudly rather than send v12 a tx it can't decode.
        if (legs.length > 1 && !isV17Market) {
          throw new Error("Multi-leg trades are only supported on v17 markets");
        }

        // v18 wire: live-read BOTH portfolios' identity + the asset marketId right
        // before building the trade — these anti-replay/CAS fields are rejected
        // on-chain if stale. accountA = taker, accountB = LP maker. TradeCpi reads
        // accountB's matcher-sequence but does NOT advance it (gate test/03).
        // Ported from newmarkets.ts buildTradeCpiIx.
        const [takerId, lpId, tradeMarketId] = await Promise.all([
          fetchPortfolioIdentity(connection, accountA),
          fetchPortfolioIdentity(connection, accountB),
          fetchAssetMarketId(connection, slabPk, 0),
        ]);

        // v18: TradeCpi/BatchTradeCpi bind both portfolios' identity + accountB's matcher
        // sequence + the asset marketId (lib/trade-ix.ts; shared with the first-trade flow).
        const tradeIxParams = {
          programId,
          signer: wallet.publicKey,
          market: slabPk,
          accountA,
          accountB,
          matcherProg,
          matcherCtx,
          matcherDelegate,
          takerId,
          lpId,
          marketId: tradeMarketId,
          legs,
          size: params.size,
          limitPriceE6: effectiveLimitPriceE6,
          feeBps: params.feeBps,
          marketTradeFeeBps: wrapperConfigV17?.tradeFeeBps,
        };
        const tradeIxs = buildTradeIxs(tradeIxParams);
        // v17 PermissionlessCrank (tag 5) on the TAKER's portfolio: [owner(s,w), market(w),
        // portfolio(w)] + oracle tail. NEVER in the trade's own transaction: crank + trade in
        // one tx fails the trade with Custom(21) EngineLockActive most of the time while the
        // trade alone is clean (lib/taker-crank.ts has the measurements). Only when the trade
        // alone is refused and the crank alone is clean is it sent, as a separate prior tx.
        // Cranking an empty portfolio returns EngineNonProgress (0x16), so it is only
        // considered when the taker already has active legs.
        let hasActiveLegs = false;
        // P1 (flag-gated): a confirmed TradeCpi can be a partial or ZERO fill.
        const limitsMarketId =
          isV17Market && limitsFlags().p1 && raw ? decodeMarketEngineView(raw)?.marketId ?? null : null;
        let beforePosQ: bigint | null = null;
        // Devnet v2.1 only: the taker's signed position on asset 0, read from the same portfolio
        // read below, so tag 103 rides only with risk-increasing orders (never a close).
        let v21BeforeQ: bigint | null = null;
        if (isV17Market) {
          try {
            const portInfo = await connection.getAccountInfo(accountA, "confirmed");
            if (portInfo) {
              const pf = parsePortfolioV17(new Uint8Array(portInfo.data));
              hasActiveLegs = pf.legs.some((l) => l.active);
              if (isDevnetV21Enabled() && raw) {
                const mid = decodeMarketEngineView(raw)?.marketId ?? null;
                if (mid !== null) v21BeforeQ = signedPositionForAsset(new Uint8Array(portInfo.data), 0, mid);
              }
              // P1 zero-fill check: the taker's position BEFORE the trade (same read).
              if (limitsMarketId !== null) {
                beforePosQ = signedPositionForAsset(new Uint8Array(portInfo.data), 0, limitsMarketId);
              }
            }
          } catch {
            // If the portfolio read fails, skip the crank rather than aborting the trade.
            hasActiveLegs = false;
          }
        }

        if (hasActiveLegs) {
          const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
            wallet.publicKey, slabPk, accountA,
          ]);
          // For Pyth mode, append oracle feed account as tail
          if (!useAdminOracle) {
            crankKeys.push({ pubkey: oracleAccount, isSigner: false, isWritable: false });
          }
          const crankIx = buildIx({
            programId,
            keys: crankKeys,
            // v18: PermissionlessCrank payload is { nowSlot, observations }. A plain
            // maintenance crank passes one asset-0 hint with no oracle-account push.
            data: encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) }),
          });
          const takerWallet = wallet.publicKey;
          const plan = await planTakerCrank(
            (ixs) => simulateForGate(connection, takerWallet, ixs),
            // M-2: a split over one tx's budget is judged on what fits ONE tx (the first legs).
            legs.length > SINGLE_TX_MAX_LEGS ? tradeIxs.slice(0, SINGLE_TX_MAX_LEGS) : tradeIxs,
            crankIx,
            2, // simulateForGate's heap-frame + CU-limit prefix
          );
          if (plan === "separate-tx") {
            console.info("[useTrade] taker portfolio needs a maintenance crank first; sending it as its own tx");
            await sendTx({ connection, wallet, instructions: [crankIx], computeUnitsFromSim: { cap: 200_000 } });
          }
        } else if (!isV17Market) {
          // v12: the crank is on the slab, not the portfolio (legacy path, unchanged).
          const crankKeys = buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, [
            wallet.publicKey, slabPk, slabPk,
          ]);
          if (!useAdminOracle) {
            crankKeys.push({ pubkey: oracleAccount, isSigner: false, isWritable: false });
          }
          instructions.unshift(buildIx({
            programId,
            keys: crankKeys,
            data: encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) }),
          }));
        }
        let sig: string;
        if (isV17Market && legs.length > SINGLE_TX_MAX_LEGS) {
          // M-2: more legs than one transaction's 1.4M CU can carry. Pack them into as many
          // transactions as the budget needs, simulate every one before signing (re-planning
          // with fewer legs per tx on compute exhaustion), sign ALL with one approval, then
          // broadcast in order (lib/trade-leg-groups.ts). `instructions` holds nothing on v17
          // (the taker crank never shares the trade's tx, lib/taker-crank.ts); kept generic.
          if (getMaintenanceConfig().blockWrites) throw new MaintenanceError();
          const owner = wallet.publicKey;
          const prepend = [...instructions];
          const [{ blockhash }, priorityFee] = await Promise.all([
            connection.getLatestBlockhash("confirmed"),
            getPriorityFee(connection),
          ]);
          const sent = await sendLegGroups(
            {
              legs,
              buildGroupIxs: (group, i) => [
                ...(i === 0 ? prepend : []),
                ...buildTradeIxs({ ...tradeIxParams, legs: group, size: group.reduce((a, b) => a + b, 0n) }),
              ],
            },
            {
              simulate: (ixs) => simulateForGate(connection, owner, ixs),
              refusal: (sim) => new SimulationRefusal(sim.err, sim.logs, sim.simulated),
              buildTx: (ixs, computeUnits) =>
                buildBatchTx({ instructions: ixs, computeUnits, priorityFeeMicroLamports: priorityFee, blockhash, feePayer: owner }),
              signAll: (txs) => signAllCompat(wallet, txs),
              broadcast: (tx) => broadcastSignedTx(connection, tx, { abortSignal: params.abortSignal }),
            },
          );
          sig = sent.signatures[sent.signatures.length - 1];
        } else {
          // Devnet v2.1 (flag-gated, sim-gated, risk-increasing only): bound markets carry tag 103
          // in front so the vault LP's capital follows Earn. See lib/v21/allocate-prefix.ts.
          const allocateIxs =
            isV17Market && isDevnetV21Enabled()
              ? await planAllocatePrefix(
                  { connection, simulate: (ixs) => simulateForGate(connection, wallet.publicKey!, ixs) },
                  { programId, market: slabPk, cranker: wallet.publicKey, beforeQ: v21BeforeQ, signedSizeQ: params.size },
                )
              : [];
          instructions.push(...allocateIxs, ...tradeIxs);

          // Explicit limit sized from a simulation of THIS tx (P1: CPI trades cost ~13k more CU;
          // a single-leg batch on asset 1 is 216k > the 200k default), capped at 400k per leg
          // (lib/compute-budget.ts). Also used by closes (useClosePosition calls trade()).
          const sendTrade = (ixs: TransactionInstruction[]) => sendTxWaiting({
            connection, wallet, instructions: ixs,
            onWaiting: params.onWaiting,
            abortSignal: params.abortSignal,
            keepWaiting: params.keepWaiting,
            onWaitingLong: params.onWaitingLong,
            computeUnitsFromSim: { cap: tradeCuCap(legs.length) },
            // P0b: prepend ExpireBackingBucket / FinalizeResetSide only if this
            // trade/close would otherwise revert 19/21 on them (lib/self-heal.ts).
            // UX WP-2 (SH-2): a lagging engine clock is caught up by cranking the market's LP
            // (accountB; the vault LP on P3) inside THIS tx — never "ask a maintainer".
            selfHeal: isV17Market
              ? {
                  programId,
                  market: slabPk,
                  catchUp: {
                    portfolio: accountB,
                    oracleTail: useAdminOracle ? [] : [{ pubkey: oracleAccount, isSigner: false, isWritable: false }],
                  },
                }
              : undefined,
          });
          try {
            sig = await sendTrade(instructions);
          } catch (e) {
            // Devnet v2.1: the allocation refused (Custom 100) after the pre-check passed (state moved).
            // It is never needed for the trade: send the trade without it, once.
            if (allocateIxs.length > 0 && isAllocateRefusal(e)) sig = await sendTrade(instructions.filter((ix) => !allocateIxs.includes(ix)));
            else throw e;
          }
        }

        // Immediate local application of the confirmed fill: sendTx's
        // pollConfirmation has ALREADY verified this tx landed on-chain by
        // this point, so params.size's effect on position size is a known
        // fact, not speculation — only the shared scan store's cached READ
        // hasn't caught up yet (same /api/rpc cache the refresh burst below
        // is timed around). Patch the store's cached position size right
        // now so OrderTicket/PositionsDock/ChartPnlBadge (every subscriber)
        // reflect the new size on THIS render instead of waiting 1-3.5s for
        // the burst. Capital/pnl/fees are intentionally left untouched (not
        // deterministic client-side) — those fields still wait on the
        // refresh burst exactly as before. See applyConfirmedFill's doc.
        if (isV17Market && limitsMarketId !== null) {
          // P1: patch only by the MEASURED delta. A zero fill changes nothing; an
          // unknown result waits for the refresh burst (never assumes params.size).
          const fill = await measureFill(connection, accountA, sig, beforePosQ, params.size, limitsMarketId);
          recordFillResult(sig, fill);
          if ((fill.kind === "full" || fill.kind === "partial") && fill.filledQ !== null) {
            applyConfirmedFill(makePortfolioScanKey(programId, slabAddress, wallet.publicKey), fill.filledQ);
          }
        } else if (isV17Market) {
          applyConfirmedFill(makePortfolioScanKey(programId, slabAddress, wallet.publicKey), params.size);
        }

        // Re-fetch the slab so useUserAccount re-scans: a trade opens/closes a
        // leg AND changes capital, and the order-ticket balance reads
        // userAccount.account.capital. sendTx already waited for confirmation,
        // so the settled state is on-chain — but the /api/rpc account-data cache
        // (~1-1.5s) means a single immediate refresh reads the pre-trade cached
        // balance. Fire a short burst so one lands just past the cache window;
        // the balance/position reflect the trade within ~1-2s instead of waiting
        // on the (30s when WS-active) background poll. Fixes "balance doesn't
        // update after I trade". Mirrors useDeposit/useWithdraw.
        refreshSlab?.();
        [1200, 2200, 3500].forEach((ms) => setTimeout(() => refreshSlab?.(), ms));
        return sig;
      } catch (e) {
        // Invalidate the cached v17 account resolution — the failure may be a
        // rotated matcher config or a migrated portfolio; the retry (or the
        // next attempt) re-resolves fresh instead of re-failing off the cache.
        if (wallet.publicKey && slabProgramId) {
          try {
            invalidateV17TradeAccounts(slabProgramId, new PublicKey(slabAddress), wallet.publicKey);
            // Same reasoning for the caps/ctx cache: the failure may be a
            // re-pointed matcher config, and a stale cap re-fails every
            // retry with the same wrong leg split.
            invalidateMatcherCaps(slabProgramId, new PublicKey(slabAddress));
          } catch { /* malformed address — nothing cached */ }
        }
        // M-2: part of a multi-transaction order landed — re-read so the position is current.
        if (e instanceof PartialLegSendError) {
          refreshSlab?.();
          [1200, 2200, 3500].forEach((ms) => setTimeout(() => refreshSlab?.(), ms));
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (mountedRef.current) setError(msg);
        throw e;
      } finally {
        inflightRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [connection, wallet, mktConfig, accounts, raw, slabAddress, slabProgramId, refreshSlab, wrapperConfigV17]
  );

  return { trade, loading, error };
}
