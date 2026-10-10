"use client";

import { lotTradingRefusal } from "@/lib/v22/lot-coverage";
import { ensureLotExp, getLotExp } from "@/lib/v22/lot-registry";
import { useState, useCallback, useRef } from "react";
import { useSingleMarketHealth } from "@/hooks/useMarketHealth";
import { safeExplainMarketTxError } from "@/lib/market-error";
import { Connection, PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { AccountKind } from "@percolatorct/sdk";
import { useTrade, prewarmTradeSubmission } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { getPortfolioRawSnapshot, makePortfolioScanKey } from "@/lib/userAccountScan";
import { pickOwnerPortfolio, scanOwnerPortfolios } from "@/lib/owner-portfolio";
import { effectiveLeg } from "@/lib/limits/effective-quantity";
import { isPartialLegSendError } from "@/lib/trade-leg-groups";
import { getLivePriceSnapshot } from "@/lib/priceStore/priceStore";
import { useSlabState } from "@/components/providers/SlabProvider";
import { humanizeError, UserFacingError, userFacingMessage, withTransientRetry } from "@/lib/errorMessages";
import { getLpInventoryState, getMatcherCaps } from "@/lib/matcherCaps";
import { lpInventoryRoomQ } from "@/lib/limits/lp-inventory-room";
import { closeCapacityMessage } from "@/lib/marketCapacity";
import { chunkCloseSize } from "@/lib/closeChunks";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { invalidatePortfolio } from "@/lib/portfolio-invalidation";
import { diagnoseTradeRejection } from "@/lib/tradeRejectDiagnosis";
import { takeFillResult } from "@/lib/limits/fill-check";
import { ZeroFillError, closeOutcome, isZeroFillError, type FillResult } from "@/lib/limits/fill-result";
import { COPY } from "@/lib/limits/copy";
import { fmtQ } from "@/lib/limits/format";
import { decodeMarketEngineView, type MarketEngineView } from "@/lib/limits/decode";
import { closeRouteFor, isAdlReduceOnly, rebalanceReduceQ } from "@/lib/limits/adl-reduce-only";
import { closeViaRebalanceReduce } from "@/lib/limits/rebalance-close";
import { isReduceOnlyLock21 } from "@/lib/limits/reduce-only-fallback";
import { pythCrankAccount } from "@/lib/limits/oracle-tail";
import { findV17Portfolio } from "@/hooks/useTrade";
import { useWithdraw } from "@/hooks/useWithdraw";
import { readSweepableCapital, SWEEP_COPY } from "@/lib/close-sweep";
import { useOptionalToast } from "@/hooks/useToast";
import { formatTokenAmount } from "@/lib/format";
import { closeLimitFromEngine } from "@/lib/close-limit";
import { clearEntryPrice } from "@/lib/entry-price";
import { parsePortfolio, isWrapperAccount } from "@/lib/v22/layout";
import { PortfolioTargetError, TARGET_COPY, isPortfolioTargetError, verifyPortfolioTarget } from "@/lib/portfolio-target";

/** M-3: the leg is a prior-reset obligation (owns 0 effective quantity). */
export const COPY_RESET_LEG =
  "This position was already closed out when the market reset, so there's nothing left to close. It clears from your account automatically.";

export interface ClosePositionResult {
  signature: string | null;
  /** P1: measured fill of the confirmed close (null = not measured: flag off / unpinned read). */
  fill?: FillResult | null;
}

export interface ClosePositionOpts {
  /**
   * #3301: close EXACTLY this portfolio account (the one the row on screen shows). It is read fresh
   * and must be owned by the market program, by the connected wallet and on this market; the size
   * and percent come from its own leg. There is no fallback scan: a mismatch or an account with no
   * open position is an error the user sees. Omit it only where no row exists (legacy v12 / mock),
   * which keeps the old "the wallet's lowest-pubkey portfolio" resolution.
   */
  portfolioPk?: PublicKey;
  /** Skip the post-close sweep (the v2.1 MOVE executor sweeps once after its own steps). */
  skipSweep?: boolean;
}

export interface UseClosePositionReturn {
  closePosition: (closePercent: number, opts?: ClosePositionOpts) => Promise<ClosePositionResult>;
  loading: boolean;
  error: string | null;
  phase: "idle" | "submitting" | "confirming";
  lastSig: string | null;
  resetPhase: () => void;
  /** Fire when the close MODAL opens (fire-and-forget): starts the fresh
   *  portfolio read + trade-account/blockhash/fee prewarms so the confirm
   *  click reaches the wallet popup with zero blocking RPC round-trips. */
  prewarmClose: (opts?: ClosePositionOpts) => void;
}

// ---------------------------------------------------------------------------
// Prewarmable fresh-portfolio read.
//
// The authoritative pre-close position read is safety-critical (an outdated
// size can over-close and open opposite exposure), so it is NEVER replaced by
// cached UI state. But "authoritative" doesn't have to mean "started only
// after the user clicks": a direct chain read taken when the close MODAL
// opened, at most FRESH_READ_TTL_MS old, is dramatically fresher than the 30s
// UI poll this guard exists to distrust — and consuming it makes the click →
// wallet-popup gap near-zero. If the user lingers past the TTL, the click
// falls back to a live read exactly as before. Any close failure invalidates
// the entry.
// ---------------------------------------------------------------------------
/** Maximum age of a prewarmed read the close click may consume. Position size
 *  only moves via the owner's own txs, liquidation, or ADL — a ≤4s window is
 *  well inside the risk this guard was built for (stale 30s UI polls). */
const FRESH_READ_TTL_MS = 4_000;
const freshReadCache = new Map<string, { data: Buffer | null; ts: number }>();
const freshReadInflight = new Map<string, Promise<Buffer | null>>();

function freshReadKey(programId: PublicKey, slab: string, owner: PublicKey, targetPk?: PublicKey): string {
  // A targeted read is a different account from the owner's default one: never share a cache slot.
  return `${programId.toBase58()}|${slab}|${owner.toBase58()}${targetPk ? `|${targetPk.toBase58()}` : ""}`;
}

/** One direct chain read of the caller's v17 portfolio for this market:
 *  targeted getAccountInfo when the shared scan store knows the pubkey
 *  (address never changes; the DATA read is live either way), full
 *  owner-filtered scan otherwise. `null` = read succeeded, no portfolio. */
async function readFreshPortfolioData(
  connection: Connection,
  programId: PublicKey,
  slabAddress: string,
  owner: PublicKey,
  targetPk?: PublicKey,
): Promise<Buffer | null> {
  const slabPk = new PublicKey(slabAddress);
  if (targetPk) {
    // #3301: exactly the named account. Never the cached pick, never a scan.
    const info = await connection.getAccountInfo(targetPk, "confirmed");
    return verifyPortfolioTarget(info, programId, slabPk, owner);
  }
  const cachedPk = getPortfolioRawSnapshot(
    makePortfolioScanKey(programId, slabAddress, owner),
  )?.pubkey;
  if (cachedPk) {
    const info = await connection.getAccountInfo(cachedPk, "confirmed");
    if (info) return Buffer.from(info.data);
    // account gone or unreadable → fall through to the scan
  }
  // M-4: the shared scan + selector (lib/owner-portfolio.ts) — the SAME
  // portfolio trade/deposit/display pick (LP dropped, decoded owner verified,
  // lowest pubkey), never `results[0]` in RPC order. An RPC failure throws.
  const results = await scanOwnerPortfolios(connection, programId, slabPk, owner);
  return pickOwnerPortfolio(results, owner)?.data ?? null;
}

/** Cache-or-read with in-flight dedup. `maxAgeMs` bounds how old an accepted
 *  cached read may be (0 forces a live read). */
function getFreshPortfolioData(
  connection: Connection,
  programId: PublicKey,
  slabAddress: string,
  owner: PublicKey,
  maxAgeMs: number,
  targetPk?: PublicKey,
): Promise<Buffer | null> {
  const key = freshReadKey(programId, slabAddress, owner, targetPk);
  const cached = freshReadCache.get(key);
  if (cached && Date.now() - cached.ts < maxAgeMs) {
    return Promise.resolve(cached.data);
  }
  const inflight = freshReadInflight.get(key);
  if (inflight) return inflight;
  const p = readFreshPortfolioData(connection, programId, slabAddress, owner, targetPk)
    .then((data) => {
      freshReadCache.set(key, { data, ts: Date.now() });
      return data;
    })
    .finally(() => {
      freshReadInflight.delete(key);
    });
  freshReadInflight.set(key, p);
  return p;
}

export function useClosePosition(slabAddress: string): UseClosePositionReturn {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { publicKey } = wallet;
  const userAccount = useUserAccount();
  const { trade } = useTrade(slabAddress);
  const { withdraw } = useWithdraw(slabAddress);
  const toast = useOptionalToast();
  const { accounts, raw, programId, config: slabConfig, wrapperConfigV17 } = useSlabState();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  // P0b: live v18 health refines 19/21 on a failed close (lib/market-error.ts).
  const marketHealth = useSingleMarketHealth(slabAddress);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "submitting" | "confirming">("idle");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const inflightRef = useRef(false);

  // v12: LP index from the slab bitmap. v17: accounts is empty — lpIdx=0 is unused
  // because useTrade v17 path discovers the LP via getProgramAccounts independently.
  const lpIdx = accounts.find(({ account }) => account.kind === AccountKind.LP)?.idx ?? 0;

  const isV17Market = raw != null && raw.length > 0 && isWrapperAccount(raw);

  const resetPhase = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const closePosition = useCallback(
    async (closePercent: number, opts?: ClosePositionOpts): Promise<ClosePositionResult> => {
      if (inflightRef.current) throw new Error("Close already in progress");
      const targetPk = opts?.portfolioPk;
      // A named account does not need the canonical scan to have loaded; the unnamed path still does.
      if (!userAccount && !targetPk) {
        // A fresh SlabProvider (/portfolio, other markets) can still be loading it. Say so; keep the
        // throw, which keeps the modal open. The in-progress guard above stays silent on purpose.
        setError(COPY.closeNotLoaded);
        throw new Error("No user account");
      }
      if (closePercent < 1 || closePercent > 100) throw new Error("Close percent must be 1-100");
      // v2.2 (N2): a market with lots is not traded (closes included) until every surface is lot-aware.
      {
        const refusal = lotTradingRefusal(getLotExp(slabAddress));
        if (refusal) {
          ensureLotExp(slabAddress);
          setError(refusal);
          throw new UserFacingError(refusal);
        }
      }

      const userIdx = userAccount?.idx ?? 0;

      inflightRef.current = true;
      setLoading(true);
      setError(null);
      setPhase("submitting");

      try {
        // A named account only exists on v17/v18 markets; there is no legacy equivalent to target.
        if (targetPk && !mockMode && !isV17Market) throw new PortfolioTargetError(TARGET_COPY.unmatched);

        // Mock mode: simulate close
        if (mockMode) {
          await new Promise((r) => setTimeout(r, 800));
          setPhase("confirming");
          setTimeout(() => setPhase("idle"), 2000);
          inflightRef.current = false;
          setLoading(false);
          return { signature: null };
        }

        // Fetch the authoritative on-chain position size before closing.
    // Never fall back to cached UI state: an outdated size can over-close
    // the actual position and unintentionally open exposure in the
    // opposite direction.
    let freshPositionSize: bigint | null = null;
    // M-3: `freshPositionSize` is the ADL-EFFECTIVE signed quantity (what a trade acts on,
    // engine plan_delta); `freshBasisQ` is the raw signed basis the fill check compares.
    let freshBasisQ: bigint | null = null;
    let freshEngine: MarketEngineView | null = null;
    let resetLeg = false;

    if (isV17Market) {
      // v17: re-fetch via a FRESH on-chain read + parsePortfolioV17.
      // parseAccount(bitmap, idx) is a v12-only function and throws on v17 data.
      try {
        if (!programId || !publicKey) {
          throw new Error(
            "Wallet or market program is unavailable for position verification.",
          );
        }

        // Prewarm the rest of the submission path (blockhash, priority fee,
        // trade-account resolution) so it overlaps this freshness read
        // instead of running serially after it. Usually a no-op: prewarmClose
        // already fired all of this when the close modal opened.
        prewarmTradeSubmission(connection, programId, slabAddress, publicKey);

        // Consume the modal-open prewarmed read when it's ≤FRESH_READ_TTL_MS
        // old (see the cache's doc comment for why that preserves the safety
        // property); otherwise this performs a live read right now, exactly
        // as before the prewarm existed.
        const [freshData, freshSlab] = await Promise.all([
          getFreshPortfolioData(connection, programId, slabAddress, publicKey, FRESH_READ_TTL_MS, targetPk),
          connection.getAccountInfo(new PublicKey(slabAddress), "confirmed"),
        ]);
        freshEngine = freshSlab ? decodeMarketEngineView(new Uint8Array(freshSlab.data)) : null;

        if (!freshData) {
          // The query completed successfully and found no current
          // portfolio for this wallet and market.
          freshPositionSize = 0n;
        } else {
          const portfolio = parsePortfolio(freshData);

          // Re-check the mutable owner after the read — covers both the
          // RPC-side memcmp filter AND the cached-pubkey shortcut (a wrapped
          // position's owner moves to the escrow PDA; a mismatch here falls
          // back to "could not verify" rather than closing someone else's
          // account).
          if (!portfolio.owner.equals(publicKey)) {
            throw new Error(
              "Fresh portfolio owner does not match the connected wallet.",
            );
          }

          const activeLeg = portfolio.legs.find((leg) => leg.active);
          if (!activeLeg) {
            // A named account that is flat is an error, not a success (#3301).
            if (targetPk) throw new PortfolioTargetError(TARGET_COPY.flat);
            freshPositionSize = 0n;
          } else {
            const basisMag = activeLeg.basisPosQ < 0n ? -activeLeg.basisPosQ : activeLeg.basisPosQ;
            freshBasisQ = activeLeg.side === 0 ? basisMag : -basisMag;
            if (!freshEngine) {
              // Only a v18 market decodes; a legacy v17 slab has no ADL index to scale by.
              if (freshSlab) throw new Error("Market layout could not be decoded for the close.");
              throw new Error("Market account could not be read for the close.");
            }
            const eff = effectiveLeg(freshEngine, activeLeg);
            if (eff.kind === "invalid") {
              throw new Error("The engine would refuse this leg (epoch / ADL index mismatch).");
            }
            if (eff.kind === "reset") resetLeg = true;
            freshPositionSize = eff.signedQ;
          }
        }
      } catch (cause) {
        // The user must see WHY the named account was refused, not the generic "could not verify".
        if (isPortfolioTargetError(cause)) throw cause;
        console.warn(
          "[useClosePosition] v17 fresh portfolio verification failed",
          cause,
        );

        throw new UserFacingError(
          "Could not verify current on-chain position. Please try again.",
        );
      }
    } else {
      // v12: re-fetch via fetchSlab + parseAccount (bitmap-based).
      try {
        const { fetchSlab, parseAccount } =
          await import("@percolatorct/sdk");

        const freshData = await fetchSlab(
          connection,
          new PublicKey(slabAddress),
        );

        const freshAccount = parseAccount(
          freshData,
          userIdx,
        );

        freshPositionSize = freshAccount.positionSize;
      } catch (cause) {
        console.warn(
          "[useClosePosition] v12 fresh position verification failed",
          cause,
        );

        throw new UserFacingError(
          "Could not verify current on-chain position. Please try again.",
        );
      }
    }

    if (freshPositionSize === null) {
      throw new UserFacingError(
        "Could not verify current on-chain position. Please try again.",
      );
    }

    if (resetLeg) {
          // A prior-reset obligation owns no position (engine effective_abs_quantity_for_leg
          // = 0): closing it would trade nothing. It is cleared by the next refresh of the
          // account, so there is nothing for the user to sign.
          setError(COPY_RESET_LEG);
          setPhase("idle");
          inflightRef.current = false;
          setLoading(false);
          return { signature: null };
        }

    if (freshPositionSize === 0n) {
          // Nothing to close is not a success: say so and keep the caller's modal open.
          throw new PortfolioTargetError(TARGET_COPY.flat);
        }

        const freshAbs = freshPositionSize < 0n ? -freshPositionSize : freshPositionSize;
        const freshIsLong = freshPositionSize > 0n;

        // Compute partial close size
        let closeSize: bigint;
        if (closePercent >= 100) {
          // 100% always uses full size to avoid dust
          closeSize = freshIsLong ? -freshAbs : freshAbs;
        } else {
          const partialAbs = (freshAbs * BigInt(closePercent)) / 100n;
          closeSize = freshIsLong ? -partialAbs : partialAbs;
        }

        // Guard against integer-division rounding to zero: a tiny position
        // (e.g. freshAbs=1) closed at a low percent (e.g. 10%) computes
        // (1 * 10) / 100 = 0 via floor division above. A 0-size TradeCpi leg
        // is a no-op at best and a rejected/confusing on-chain tx at worst —
        // short-circuit the same way the freshPositionSize === 0n guard above
        // does, rather than sending a trade for a size the user didn't ask for.
        if (closeSize === 0n) {
          throw new PortfolioTargetError(TARGET_COPY.tooSmall);
        }

        // v17/v18: the close's slippage limit comes from the engine's effective_price
        // (lib/close-limit.ts), not the site feed — so the feed is not needed here.
        // Legacy v12 keeps the feed-derived path, which throws SlippageError
        // without a live mark — short-circuit so the user sees the real reason.
        if (!isV17Market && getLivePriceSnapshot(slabAddress).priceE6 == null) {
          throw new UserFacingError(
            "Live mark price unavailable — wait for the price feed to reconnect, then try again.",
          );
        }

        // A position can be up to 4× the matcher's per-fill cap (it was built
        // over several trades), but the matcher will NOT fill more than the
        // cap in one shot — and it doesn't partial-fill, it rejects the whole
        // trade. Split an over-cap close into batch legs (one tx, one
        // signature). A caps read failure degrades to the single-leg path —
        // exactly the pre-existing behavior — rather than blocking the close.
        let closeLegs: bigint[] | undefined;
        // F-3: tag 44 does not go through the matcher, so its caps/inventory do not apply.
        const reduceOnlyNow = isV17Market
          ? isAdlReduceOnly(freshEngine ?? (raw ? decodeMarketEngineView(raw) : null))
          : false;
        if (programId && !reduceOnlyNow) {
          try {
            const slabPk = new PublicKey(slabAddress);
            const caps = await getMatcherCaps(connection, programId, slabPk);
            if (caps) {
              // A close is not automatically inventory-safe: when the closer
              // is AGAINST the crowd (e.g. closing a long while the LP is
              // already long), the close pushes LP inventory further and the
              // matcher clamps → wrapper rejects. Check the chosen side's
              // remaining capacity and fail with the real reason instead of
              // the bare on-chain error. closeSize < 0 = user sells ("short"
              // side of the capacity math); > 0 = user buys ("long").
              // Matcher-inventory drift (2026-10-03): the ctx counter goes stale on liquidation /
              // ADL / reset. Room = min(counter, LP's real position) until the upgraded matcher is
              // detected, then the real position (lib/limits/lp-inventory-room.ts).
              const invState = await getLpInventoryState(connection, programId, slabPk);
              const side = closeSize < 0n ? "short" : "long";
              const capacity = invState
                ? lpInventoryRoomQ({ counterQ: invState.counterQ, realQ: invState.realQ, maxInventoryAbs: caps.maxInventoryAbs, syncLive: invState.syncLive }, side)
                : null;
              if (capacity !== null) {
                const sizeAbs = closeSize < 0n ? -closeSize : closeSize;
                if (sizeAbs > capacity) {
                  // The percent offered is of the WHOLE position (what the slider means), not of
                  // this close's size (lib/marketCapacity.ts closeCapacityMessage).
                  throw new UserFacingError(closeCapacityMessage(capacity, freshAbs));
                }
              }
              const legs = chunkCloseSize(closeSize, caps.maxFillAbs);
              if (legs.length > 1) closeLegs = legs;
            }
          } catch (capErr) {
            // The capacity error above is a REAL, user-facing block — rethrow.
            // Anything else (caps/inventory read failed) degrades to the
            // single-leg close exactly as before.
            if (capErr instanceof UserFacingError) {
              throw capErr;
            }
          }
        }

        // v17: pass lpIdx=0, userIdx=0 — useTrade v17 path ignores both and
        // resolves accountA via findV17Portfolio + accountB via GPA scan.
        // v12: pass the real lpIdx and userAccount.idx as before.
        // F-3 / R1: while the asset is ADL reduce-only (a_long or a_short != ADL_ONE), a
        // matcher close can revert Custom(21) (the LP's leg would grow). Route those closes to
        // the owner-signed unilateral exit, RebalanceReduce (tag 44). Also fall back to it when
        // the matcher close fails 21 and a FRESH read shows the state (the slab poll lagged).
        const rebalanceClose = async () => {
          if (!programId || !publicKey) throw new Error("Wallet or market program is unavailable.");
          const slabPk = new PublicKey(slabAddress);
          const marketBytes = new Uint8Array((await connection.getAccountInfo(slabPk, "confirmed"))?.data ?? []);
          const eng = decodeMarketEngineView(marketBytes);
          if (!eng) throw new Error("Could not read the market to route the close.");
          const portfolio =
            targetPk ??
            getPortfolioRawSnapshot(makePortfolioScanKey(programId, slabAddress, publicKey))?.pubkey ??
            (await findV17Portfolio(connection, programId, slabPk, publicKey));
          if (!portfolio) throw new Error("Could not find your portfolio on this market.");
          return closeViaRebalanceReduce({
            connection,
            wallet,
            programId,
            market: slabPk,
            owner: publicKey,
            portfolio,
            beforeQ: freshBasisQ ?? (freshPositionSize as bigint),
            reduceQ: rebalanceReduceQ(freshPositionSize as bigint, closePercent),
            marketId: eng.marketId,
            pythCrankAccount: pythCrankAccount(slabConfig, wrapperConfigV17?.oracleMode),
          });
        };
        let sig: string | null | undefined;
        let fill: FillResult | null = null;
        let routedRebalance = false;
        if (closeRouteFor(reduceOnlyNow) === "rebalance-reduce") {
          const r = await rebalanceClose();
          sig = r.signature;
          fill = r.fill;
          routedRebalance = true;
        } else {
          // v17/v18 matcher close: limit from the engine's effective_price. Attempt 1 uses the
          // fresh market read the position was verified against (no extra RPC); a retry
          // (blockhash expiry / 429) can land a minute later, so it re-reads instead of
          // reusing a limit the price may have moved past. v12 keeps useTrade's feed path.
          let closeLimitPriceE6 = isV17Market ? closeLimitFromEngine(freshEngine, closeSize) : undefined;
          let attempt = 0;
          const rereadCloseLimit = async (): Promise<bigint> => {
            const info = await connection.getAccountInfo(new PublicKey(slabAddress), "confirmed").catch(() => null);
            return closeLimitFromEngine(info ? decodeMarketEngineView(new Uint8Array(info.data)) : null, closeSize);
          };
          try {
            sig = await withTransientRetry(
              async () => {
                if (attempt++ > 0 && closeLimitPriceE6 !== undefined) {
                  closeLimitPriceE6 = await rereadCloseLimit();
                }
                return trade({
                  lpIdx,
                  userIdx,
                  size: closeSize,
                  ...(targetPk && { portfolioPk: targetPk }),
                  sizes: closeLegs,
                  ...(closeLimitPriceE6 !== undefined && { limitPriceE6: closeLimitPriceE6 }),
                });
              },
              { maxRetries: 2, delayMs: 3000 },
            );
          } catch (tradeErr) {
            const m = tradeErr instanceof Error ? tradeErr.message : String(tradeErr);
            if (isV17Market && programId && (await isReduceOnlyLock21(m, connection, new PublicKey(slabAddress), programId))) {
              const r = await rebalanceClose();
              sig = r.signature;
              fill = r.fill;
              routedRebalance = true;
            } else {
              throw tradeErr;
            }
          }
        }

        setLastSig(sig ?? null);
        // P1: a confirmed TradeCpi can be a ZERO fill (the wrapper clipped the close to
        // LP headroom 0). useTrade measured it (lib/limits/fill-check.ts); a zero fill is
        // NOT a close — throw so every caller keeps its modal open and shows the reason.
        if (!routedRebalance) fill = takeFillResult(sig);
        const outcome = closeOutcome(fill);
        if (outcome === "no-fill") {
          throw new ZeroFillError(routedRebalance ? COPY.rebalanceZeroFill : COPY.closeZeroFill);
        }
        if (outcome === "partial" && fill?.filledQ != null) {
          const f = fill.filledQ < 0n ? -fill.filledQ : fill.filledQ;
          const r = closeSize < 0n ? -closeSize : closeSize;
          setError(routedRebalance ? COPY.rebalancePartial(fmtQ(f), fmtQ(r)) : COPY.closePartial(fmtQ(f), fmtQ(r)));
        }
        // The saved entry (lib/entry-price.ts) goes only when the position is actually flat. Every
        // close surface cleared it on a 100% REQUEST, so a partial fill (LP headroom clipped the
        // close) left the rest of the position with no entry: Entry / PnL / ROE read "--".
        // The entry store is keyed per wallet+market, not per account: clearing it for a NON-canonical
        // target would erase the entry of the account the market shows by default (#3301).
        if (closePercent === 100 && outcome === "closed" && (!targetPk || userAccount?.pubkey?.equals(targetPk))) {
          clearEntryPrice(slabAddress, userIdx, publicKey?.toBase58());
        }
        // The one confirmation a close gets: every close surface (dock, ticket, portfolio rows) closes
        // its modal on resolve, so without this a partial close just vanished. A clipped fill already
        // said what filled (setError above), so it gets no success line.
        if (outcome !== "partial") {
          const closedAbs = closeSize < 0n ? -closeSize : closeSize;
          // The tx is confirmed (sendTx returns only after confirmation; a timeout throws above), but a
          // fill the app could not measure (post-trade read failed, or the position moved the other
          // way) does not prove the position is closed: say only what is known.
          if (fill?.kind === "unknown") toast(COPY.closeConfirmedUnmeasured, "info");
          else toast(closePercent >= 100 ? COPY.closeDone : COPY.closeDonePart(fmtQ(closedAbs), fmtQ(freshAbs)), "success");
        }
        setPhase("confirming");
        setTimeout(() => setPhase("idle"), 2000);
        // The site-wide PositionsBar reads its OWN usePortfolio instance, which
        // refreshes on a 30s poll and learns nothing from this page's local dock
        // refresh — so a just-closed position lingered in the header strip for up
        // to half a minute. The OPEN path already fires this (OrderTicket); every
        // close path (PositionsDock, PositionPanel, OtherMarketPositions) funnels
        // through here, so notifying once at this single choke point covers them
        // all and can't drift. usePortfolio subscribes and runs its reconcile
        // burst (PORTFOLIO_RECONCILE_MS). See lib/portfolio-invalidation.ts.
        invalidatePortfolio();
        // Full close: hand the freed collateral back to the wallet (one more approval), in the
        // BACKGROUND so the close resolves now. Never turns a landed close into a failure.
        if (closePercent === 100 && outcome === "closed" && isV17Market && programId && publicKey && !opts?.skipSweep) {
          const owner = publicKey;
          const decimals = 6; // playground collateral is sim-USDC (6 decimals) on every market
          void (async () => {
            const amount = await readSweepableCapital({
              owner,
              read: () => readFreshPortfolioData(connection, programId, slabAddress, owner, targetPk),
            }).catch(() => null);
            if (amount === null) return;
            const label = `${formatTokenAmount(amount, decimals, 2)} USDC`;
            toast(SWEEP_COPY.prompt(label), "info");
            try {
              // Sweep the account that was just closed, never "the" wallet portfolio.
              await withdraw({ userIdx, amount, ...(targetPk && { portfolioPk: targetPk, strictPortfolio: true }) });
              toast(SWEEP_COPY.done(label), "success");
            } catch {
              toast(SWEEP_COPY.kept(label), "info");
            }
            invalidatePortfolio();
          })();
        }
        return { signature: sig ?? null, fill };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isPartialLegSendError(e)) {
          // M-2: some of the close's transactions landed. Say what happened, plainly.
          setError(msg);
          invalidatePortfolio();
          setPhase("idle");
          throw e;
        }
        if (isZeroFillError(e)) {
          // Not a tx failure: the close landed and filled nothing. Plain copy, no diagnosis.
          setError(msg);
          setPhase("idle");
          throw e;
        }
        if (isPortfolioTargetError(e)) {
          // Refused before anything was sent: show the calm line as is, no diagnosis.
          setError(msg);
          setPhase("idle");
          throw e;
        }
        console.error("[useClosePosition] error:", msg);
        setError(userFacingMessage(e) ?? safeExplainMarketTxError(msg, "close", marketHealth) ?? humanizeError(msg, "trade"));
        // #2643: refine an ambiguous Custom(9) from pre-trade state (no-op for
        // any other error). The generic text above shows immediately.
        if (programId) {
          void diagnoseTradeRejection(msg, connection, programId, new PublicKey(slabAddress))
            .then((refined) => { if (refined) setError(refined); })
            .catch(() => { /* keep the generic message */ });
        }
        setPhase("idle");
        throw e;
      } finally {
        // CRITICAL: a prewarmed read is SPENT once a close consumes it — on
        // EVERY outcome, not just failure. Invalidating only in `catch` (as
        // this originally did) left the PRE-CLOSE size cached for the rest of
        // the 4s TTL after a SUCCESSFUL close, and the position had just
        // changed. A second close inside that window then read the stale size:
        // close 50% of 10 SOL (true size now 5), click Close 100% at T+2s, the
        // cached size 10 is consumed, and the "close" sends -10 — closing 5 and
        // OPENING A 5 SOL SHORT while the UI reports success. That is precisely
        // the over-close-into-opposite-exposure this fresh-read guard exists to
        // prevent; the cache had defeated the guard it was bolted onto.
        if (programId && publicKey) {
          freshReadCache.delete(freshReadKey(programId, slabAddress, publicKey, targetPk));
        }
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, publicKey, wallet, userAccount, trade, withdraw, toast, lpIdx, slabAddress, mockMode, isV17Market, programId, marketHealth, raw, slabConfig, wrapperConfigV17],
  );

  const prewarmClose = useCallback((opts?: ClosePositionOpts) => {
    if (mockMode || !isV17Market || !programId || !publicKey) return;
    prewarmTradeSubmission(connection, programId, slabAddress, publicKey);
    // maxAge 1.5s: dedupes a double-fire (open + re-render) without letting a
    // seconds-old read masquerade as a prewarm of THIS modal-open.
    void getFreshPortfolioData(connection, programId, slabAddress, publicKey, 1_500, opts?.portfolioPk).catch(() => {});
  }, [connection, programId, publicKey, slabAddress, mockMode, isV17Market]);

  return { closePosition, loading, error, phase, lastSig, resetPhase, prewarmClose };
}
