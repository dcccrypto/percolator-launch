"use client";

import { useState, useCallback, useRef } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { AccountKind, isV17Account, parsePortfolioV17 } from "@percolatorct/sdk";
import { useTrade, prewarmTradeSubmission } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { getPortfolioRawSnapshot, isLpPortfolio, makePortfolioScanKey } from "@/lib/userAccountScan";
import { getLivePriceSnapshot } from "@/lib/priceStore/priceStore";
import { useSlabState } from "@/components/providers/SlabProvider";
import { humanizeError, withTransientRetry } from "@/lib/errorMessages";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import { useWalletCompat } from "@/hooks/useWalletCompat";

export interface ClosePositionResult {
  signature: string | null;
}

export interface UseClosePositionReturn {
  closePosition: (closePercent: number) => Promise<ClosePositionResult>;
  loading: boolean;
  error: string | null;
  phase: "idle" | "submitting" | "confirming";
  lastSig: string | null;
  resetPhase: () => void;
  /** Fire when the close MODAL opens (fire-and-forget): starts the fresh
   *  portfolio read + trade-account/blockhash/fee prewarms so the confirm
   *  click reaches the wallet popup with zero blocking RPC round-trips. */
  prewarmClose: () => void;
}

// ---------------------------------------------------------------------------
// v17 portfolio magic + offset constants — mirrors useDeposit/useTrade.
// Mutable owner (SDK PF_OWNER_OFF) is offset 116, NOT offset 80 (provenanceOwner,
// IMMUTABLE). MintPositionNft moves the mutable owner to the escrow PDA on wrap
// but leaves provenance pointing at the original wallet, so filtering on 80 would
// still match a wrapped (NFT-escrowed) portfolio.
// ---------------------------------------------------------------------------
const V17_PORTFOLIO_MAGIC_CP = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const V17_PF_MARKET_OFF_CP = 16;
const V17_PF_OWNER_OFF_CP = 116;

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

function freshReadKey(programId: PublicKey, slab: string, owner: PublicKey): string {
  return `${programId.toBase58()}|${slab}|${owner.toBase58()}`;
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
): Promise<Buffer | null> {
  const slabPk = new PublicKey(slabAddress);
  const cachedPk = getPortfolioRawSnapshot(
    makePortfolioScanKey(programId, slabAddress, owner),
  )?.pubkey;
  if (cachedPk) {
    const info = await connection.getAccountInfo(cachedPk, "confirmed");
    if (info) return Buffer.from(info.data);
    // account gone or unreadable → fall through to the scan
  }
  const results = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC_CP.toString("base64"), encoding: "base64" } },
      { memcmp: { offset: V17_PF_MARKET_OFF_CP, bytes: slabPk.toBase58() } },
      { memcmp: { offset: V17_PF_OWNER_OFF_CP, bytes: owner.toBase58() } },
    ],
  });
  // Drop the market's LP portfolio (owner == this wallet only when this
  // wallet is the market's CREATOR) BEFORE picking a result — closing a
  // position must never target the LP. See isLpPortfolio's doc comment.
  const nonLpResults = results.filter(({ account }) => !isLpPortfolio(account.data));
  if (nonLpResults.length === 0) return null;
  const data = nonLpResults[0].account.data;
  return data instanceof Buffer ? data : Buffer.from(data);
}

/** Cache-or-read with in-flight dedup. `maxAgeMs` bounds how old an accepted
 *  cached read may be (0 forces a live read). */
function getFreshPortfolioData(
  connection: Connection,
  programId: PublicKey,
  slabAddress: string,
  owner: PublicKey,
  maxAgeMs: number,
): Promise<Buffer | null> {
  const key = freshReadKey(programId, slabAddress, owner);
  const cached = freshReadCache.get(key);
  if (cached && Date.now() - cached.ts < maxAgeMs) {
    return Promise.resolve(cached.data);
  }
  const inflight = freshReadInflight.get(key);
  if (inflight) return inflight;
  const p = readFreshPortfolioData(connection, programId, slabAddress, owner)
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
  const { publicKey } = useWalletCompat();
  const userAccount = useUserAccount();
  const { trade } = useTrade(slabAddress);
  const { accounts, raw, programId } = useSlabState();
  const mockMode = isMockMode() && isMockSlab(slabAddress);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "submitting" | "confirming">("idle");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const inflightRef = useRef(false);

  // v12: LP index from the slab bitmap. v17: accounts is empty — lpIdx=0 is unused
  // because useTrade v17 path discovers the LP via getProgramAccounts independently.
  const lpIdx = accounts.find(({ account }) => account.kind === AccountKind.LP)?.idx ?? 0;

  const isV17Market = raw != null && raw.length > 0 && isV17Account(raw);

  const resetPhase = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const closePosition = useCallback(
    async (closePercent: number): Promise<ClosePositionResult> => {
      if (inflightRef.current) throw new Error("Close already in progress");
      if (!userAccount) throw new Error("No user account");
      if (closePercent < 1 || closePercent > 100) throw new Error("Close percent must be 1-100");

      inflightRef.current = true;
      setLoading(true);
      setError(null);
      setPhase("submitting");

      try {
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
        const freshData = await getFreshPortfolioData(
          connection, programId, slabAddress, publicKey, FRESH_READ_TTL_MS,
        );

        if (!freshData) {
          // The query completed successfully and found no current
          // portfolio for this wallet and market.
          freshPositionSize = 0n;
        } else {
          const portfolio = parsePortfolioV17(freshData);

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
          freshPositionSize = activeLeg ? activeLeg.basisPosQ : 0n;
        }
      } catch (cause) {
        console.warn(
          "[useClosePosition] v17 fresh portfolio verification failed",
          cause,
        );

        throw new Error(
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
          userAccount.idx,
        );

        freshPositionSize = freshAccount.positionSize;
      } catch (cause) {
        console.warn(
          "[useClosePosition] v12 fresh position verification failed",
          cause,
        );

        throw new Error(
          "Could not verify current on-chain position. Please try again.",
        );
      }
    }

    if (freshPositionSize === null) {
      throw new Error(
        "Could not verify current on-chain position. Please try again.",
      );
    }

    if (freshPositionSize === 0n) {
          setPhase("idle");
          inflightRef.current = false;
          setLoading(false);
          return { signature: null };
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
          setPhase("idle");
          inflightRef.current = false;
          setLoading(false);
          return { signature: null };
        }

        // Read the current mark price NON-reactively, at call time — not via
        // the useLivePrice() hook (same rationale as useTrade.ts: this hook
        // is called from PositionPanel/ClosePositionModal at top level, so a
        // reactive subscription here would re-render those components on
        // every price tick just to source a value only used inside this
        // callback). useTrade derives limit_price_e6 from livePriceE6 and
        // throws SlippageError when the live mark is unavailable —
        // short-circuit here so the user sees the real reason immediately.
        const { priceE6: livePriceE6 } = getLivePriceSnapshot(slabAddress);
        if (livePriceE6 == null) {
          throw new Error(
            "Live mark price unavailable — wait for the price feed to reconnect, then try again.",
          );
        }

        // v17: pass lpIdx=0, userIdx=0 — useTrade v17 path ignores both and
        // resolves accountA via findV17Portfolio + accountB via GPA scan.
        // v12: pass the real lpIdx and userAccount.idx as before.
        const sig = await withTransientRetry(
          async () => trade({ lpIdx, userIdx: userAccount.idx, size: closeSize }),
          { maxRetries: 2, delayMs: 3000 },
        );

        setLastSig(sig ?? null);
        setPhase("confirming");
        setTimeout(() => setPhase("idle"), 2000);
        return { signature: sig ?? null };
      } catch (e) {
        // Drop any prewarmed read — whatever failed, the next attempt should
        // start from a live view of the chain.
        if (programId && publicKey) {
          freshReadCache.delete(freshReadKey(programId, slabAddress, publicKey));
        }
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[useClosePosition] error:", msg);
        setError(humanizeError(msg));
        setPhase("idle");
        throw e;
      } finally {
        inflightRef.current = false;
        setLoading(false);
      }
    },
    [connection, publicKey, userAccount, trade, lpIdx, slabAddress, mockMode, isV17Market, programId],
  );

  const prewarmClose = useCallback(() => {
    if (mockMode || !isV17Market || !programId || !publicKey) return;
    prewarmTradeSubmission(connection, programId, slabAddress, publicKey);
    // maxAge 1.5s: dedupes a double-fire (open + re-render) without letting a
    // seconds-old read masquerade as a prewarm of THIS modal-open.
    void getFreshPortfolioData(connection, programId, slabAddress, publicKey, 1_500).catch(() => {});
  }, [connection, programId, publicKey, slabAddress, mockMode, isV17Market]);

  return { closePosition, loading, error, phase, lastSig, resetPhase, prewarmClose };
}
