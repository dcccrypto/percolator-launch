"use client";

/**
 * Getting out of a market that cannot trade any more.
 *
 *  - STALE (a Live market whose last good price is >= its stale window behind): trades, deposits and withdrawals refuse until someone
 *    resolves it. Anyone can (wrapper tag 39). The button sends [tag 39], then, if the wallet has funds there, the exit below.
 *  - SETTLED (a Resolved market): the trader's normal Close builds a trade the program refuses (21 -> 14, "Invalid engine
 *    configuration"). The exit is CloseResolved (30) until the portfolio is empty, the 46 top-up while a payout receipt is open, then
 *    ClosePortfolio (8) (lib/limits/trader-resolved-exit.ts): pre-signed copies, ONE wallet approval, the portfolio re-read before each
 *    broadcast, owner-signed so it also works in the owner-only window.
 *
 * Everything is sent only on the click. Tag 39 is simulated first; the first exit tx of each step is simulated before the wallet opens
 * and a refused chain is dropped; refusals 21 / 19 / 27 map to one calm line each.
 *
 * SEC-RC I-S1 (S1-6 a/c, engine e59aa6a6): a winner's CloseResolved refused with 21 while the losing side has not settled
 * is a WAIT, not an error. When the deployed wrapper is a known S1-6 a/c build (lib/v22/resolved-close-wait.ts), that
 * refusal shows one calm "waiting for the other side" line (`waiting`, not `error`), nothing is signed, and the button
 * stays so the user can try again later. Nothing retries on its own. On any other build the line is today's
 * "payout ready shortly".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { deriveVaultAuthority } from "@percolatorct/sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useClusterSlot } from "@/hooks/useClusterSlot";
import { useSlabState } from "@/components/providers/SlabProvider";
import { broadcastSignedTx, buildBatchTx, getFreshBlockhash, getPriorityFee, sendTx, signAllCompat, simulateForGate } from "@/lib/tx";
import { parseCustomInstructionError, computeBudgetPrefix, connectionSelfHealDeps } from "@/lib/self-heal";
import { loadOwnPortfolios, ownResolvedPayIxs, ownerClosePortfolioIx, type OwnPortfolio } from "@/lib/limits/own-portfolio-cleanup";
import { TAG_CLAIM_RESOLVED_PAYOUT_TOPUP, TAG_CLOSE_RESOLVED } from "@/lib/limits/constants";
import { TRADER_ITEM_CU, runTraderExit, traderExitItems, type TraderExitItem } from "@/lib/limits/trader-resolved-exit";
import { errorText } from "@/lib/error-text";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { formatStoppedAt, stoppedAtMs } from "@/lib/v22/market-lifecycle";
import { RESOLVED_CLOSE_WAIT_COPY, isResolvedCloseWait, resolvedCloseWaitLive } from "@/lib/v22/resolved-close-wait";
import {
  STALE_SETTLE_COPY,
  buildResolveStalePermissionlessIxV22,
  marketResolvedV22,
  showStaleSettle,
  staleMinutes,
  staleResolveRefusalCopy,
  staleResolveStatusV22,
  type StaleResolveStatusV22,
} from "@/lib/v22/stale-resolve";

export interface StaleSettleView {
  /** "stale": settle it first (tag 39). "settled": already resolved, take the funds out. */
  kind: "stale" | "settled";
  minutes: number;
  /** Local wall-clock time the last good price landed (an estimate from its age in slots); null for a settled market. */
  stoppedAtLabel: string | null;
  status: StaleResolveStatusV22;
}

export interface StaleResolveState {
  /** Non-null on a matured-stale Live market, or (with funds there) on a Resolved one; null otherwise. */
  view: StaleSettleView | null;
  /** The market is Resolved (whatever the wallet holds): the normal Close must not be offered. */
  resolved: boolean;
  busy: boolean;
  error: string | null;
  /** The one line shown after a click that worked. */
  done: string | null;
  /** S1-6 a/c: the close is waiting for the other side to settle (a calm line, not an error; the button stays). */
  waiting: string | null;
  settle: () => Promise<void>;
}

/**
 * One settle flow per market at a time, across every mounted notice (the ticket and the position row both mount the hook): two clicks
 * would otherwise open two wallet prompts and race the same CloseResolved / ClosePortfolio chain.
 */
const inFlightSlabs = new Set<string>();

/** Thrown for a refusal that already has its one calm line. */
class CalmRefusal extends Error {}

/** What the exit ended with: the line, and whether it is the S1-6 a/c wait (shown as `waiting`, not `done`). */
interface ExitOutcome {
  line: string;
  waiting: boolean;
}

function itemIxs(
  it: TraderExitItem,
  own: ReadonlyMap<string, OwnPortfolio>,
  c: { programId: PublicKey; owner: PublicKey; market: PublicKey; collateralMint: PublicKey; vaultToken: PublicKey; vaultAuthority: PublicKey },
): TransactionInstruction[] {
  const p = own.get(it.portfolio);
  if (!p) throw new Error("unknown portfolio");
  if (it.kind === "close-empty") return [ownerClosePortfolioIx(c.programId, c.owner, c.market, p)];
  return [...ownResolvedPayIxs(c, p.key, it.kind === "close-resolved" ? TAG_CLOSE_RESOLVED : TAG_CLAIM_RESOLVED_PAYOUT_TOPUP)];
}

export function useStaleResolve(slabAddress: string | null, hasFunds: boolean): StaleResolveState {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const { raw, programId, config, refresh } = useSlabState();
  const clusterSlot = useClusterSlot(isDevnetV22Enabled());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const status = useMemo(() => (isDevnetV22Enabled() ? staleResolveStatusV22(raw, clusterSlot) : null), [raw, clusterSlot]);
  const resolved = useMemo(() => isDevnetV22Enabled() && marketResolvedV22(raw), [raw]);
  const view = useMemo<StaleSettleView | null>(() => {
    if (showStaleSettle(status)) {
      const now = Date.now();
      return { kind: "stale", minutes: staleMinutes(status.ageSlots), stoppedAtLabel: formatStoppedAt(stoppedAtMs(status.ageSlots, now), now), status };
    }
    if (status !== null && resolved && hasFunds) return { kind: "settled", minutes: 0, stoppedAtLabel: null, status };
    return null;
  }, [status, resolved, hasFunds]);

  const settle = useCallback(async () => {
    if (slabAddress && inFlightSlabs.has(slabAddress)) return;
    if (!slabAddress || !programId || !config || !wallet.publicKey) {
      setError(STALE_SETTLE_COPY.generic);
      return;
    }
    inFlightSlabs.add(slabAddress);
    setBusy(true);
    setError(null);
    setDone(null);
    setWaiting(null);
    const payer = wallet.publicKey;
    const market = new PublicKey(slabAddress);
    let marketSettled = false; // tag 39 landed (or someone else's did): from here on 'nothing was sent' is not true
    try {
      // Fresh read: the cached bytes may be a poll behind, and a price push (or another settler) changes the answer.
      const [info, slot] = await Promise.all([connection.getAccountInfo(market, "confirmed"), connection.getSlot("confirmed")]);
      const fresh = info ? staleResolveStatusV22(new Uint8Array(info.data), BigInt(slot)) : null;
      if (!fresh) throw new CalmRefusal(STALE_SETTLE_COPY.generic);
      if (fresh.refusalCode === null) {
        const ix = buildResolveStalePermissionlessIxV22(programId, market, BigInt(slot));
        const sim = await simulateForGate(connection, payer, [ix]);
        if (sim.err) {
          const code = parseCustomInstructionError(sim.err)?.code;
          // 21: settled by someone else between the read and now: carry on to the exit.
          if (code === 21) marketSettled = true;
          if (code !== 21) throw new CalmRefusal((code !== undefined ? staleResolveRefusalCopy(code) : null) ?? STALE_SETTLE_COPY.generic);
        } else {
          await sendTx({ connection, wallet, instructions: [ix], computeUnits: 200_000 });
          marketSettled = true;
        }
      } else if (fresh.refusalCode !== 21) {
        throw new CalmRefusal(staleResolveRefusalCopy(fresh.refusalCode) ?? STALE_SETTLE_COPY.generic);
      } else {
        marketSettled = true;
      }
      if (!hasFunds) {
        setDone(STALE_SETTLE_COPY.settledNoFunds);
        return;
      }
      const exit = await exitFunds();
      if (exit.waiting) setWaiting(exit.line);
      else setDone(exit.line);
    } catch (e) {
      if (e instanceof CalmRefusal) setError(e.message);
      else {
        const msg = errorText(e);
        const declined = /reject|declin|cancel/i.test(msg);
        setError(declined ? (marketSettled ? STALE_SETTLE_COPY.declinedAfterSettle : STALE_SETTLE_COPY.cancelled) : STALE_SETTLE_COPY.generic);
      }
    } finally {
      inFlightSlabs.delete(slabAddress);
      if (alive.current) setBusy(false);
      refresh();
    }

    /** The wallet's own portfolios out of the Resolved market in ONE approval; the line to show. */
    async function exitFunds(): Promise<ExitOutcome> {
      const doneWith = (line: string): ExitOutcome => ({ line, waiting: false });
      if (!programId || !config || !wallet.publicKey) return doneWith(STALE_SETTLE_COPY.generic);
      const [vaultAuthority] = deriveVaultAuthority(programId, market);
      const c = {
        programId,
        owner: payer,
        market,
        collateralMint: config.collateralMint,
        vaultToken: getAssociatedTokenAddressSync(config.collateralMint, vaultAuthority, true),
        vaultAuthority,
      };
      const own = await loadOwnPortfolios(connection, programId, market, payer);
      if (own.length === 0) return doneWith(STALE_SETTLE_COPY.settled); // nothing of this wallet is left
      let items = traderExitItems(own);
      if (items.length === 0) return doneWith(STALE_SETTLE_COPY.settledPayoutSoon);
      const byKey = new Map(own.map((p) => [p.key.toBase58(), p]));
      // Simulate the FIRST item of each step now: a refused one drops its portfolio's chain BEFORE the wallet opens.
      const sim = connectionSelfHealDeps(connection, market, payer);
      const refused = new Set<string>();
      const tried = new Set<string>();
      // I-S1: a first CloseResolved refused with 21 by the CloseResolved itself may be the S1-6 a/c wait.
      let lockRefused = false;
      for (const it of items) {
        const k = `${it.kind}:${it.portfolio}`;
        if (tried.has(k)) continue;
        tried.add(k);
        if (it.kind !== "close-resolved") continue; // the top-up and the close depend on the 30 landing first
        const ixs = [...computeBudgetPrefix(TRADER_ITEM_CU[it.kind]), ...itemIxs(it, byKey, c)];
        const err = (await sim.simulate(ixs)).err ?? null;
        if (err) {
          refused.add(it.portfolio);
          // The CloseResolved is the last instruction (ownResolvedPayIxs: [create ATA, 30]).
          if (isResolvedCloseWait(parseCustomInstructionError(err), ixs.length - 1, true)) lockRefused = true;
        }
      }
      // Read the deployed build only when it could matter (a 21 was seen); any other build keeps today's line.
      const waitLive = lockRefused && (await resolvedCloseWaitLive(connection, programId));
      const pending = (): ExitOutcome => (waitLive ? { line: RESOLVED_CLOSE_WAIT_COPY, waiting: true } : doneWith(STALE_SETTLE_COPY.settledPayoutSoon));
      items = items.filter((it) => !refused.has(it.portfolio));
      if (items.length === 0) return pending();
      const [blockhash, fee] = await Promise.all([getFreshBlockhash(connection, true), getPriorityFee(connection)]);
      const txs = items.map((it, i) =>
        buildBatchTx({ instructions: itemIxs(it, byKey, c), computeUnits: TRADER_ITEM_CU[it.kind], priorityFeeMicroLamports: fee + i + 1, blockhash, feePayer: payer }),
      );
      const signed = await signAllCompat(wallet, txs);
      const run = await runTraderExit(
        items.map((item, i) => ({ item, tx: signed[i]! })),
        {
          read: async () => {
            const now = await loadOwnPortfolios(connection, programId, market, payer);
            return new Map(now.map((p) => [p.key.toBase58(), p.view]));
          },
          broadcast: (tx) => broadcastSignedTx(connection, tx),
        },
      );
      return run.remaining.length === 0 && !waitLive ? doneWith(STALE_SETTLE_COPY.settled) : pending();
    }
  }, [slabAddress, programId, config, wallet, connection, hasFunds, refresh]);

  return { view, resolved, busy, error, done, waiting, settle };
}
