"use client";

/**
 * UX WP-6 (audit §3.2): fund and trade in one approval.
 *  - No trading account yet: ONE transaction [CreateAccount, InitPortfolio, Deposit, Trade] with
 *    the PREDICTED portfolio id (lib/first-trade.ts); the portfolio keypair co-signs after the
 *    wallet. GH#2959: it used to be two transactions (A = create+init, B = deposit+trade) signed
 *    together with signAllTransactions; a wallet that simulates each transaction on its own
 *    (Solflare) saw B fail ({"InstructionError":[3,"IncorrectProgramId"]}: the portfolio does not
 *    exist until A lands), showed "Simulation failed" and disabled Approve. One transaction is
 *    811 bytes / ~335k CU measured live (limit 1232 / 1.4M), simulates clean in every wallet, and
 *    is atomic: a refused trade or deposit leaves nothing behind (no empty, rent-paid account).
 *    A race on the id (someone initialised in between) reverts the whole tx; it is rebuilt with
 *    the real next id: one more prompt, labelled.
 *  - Account exists but short of margin: one tx [Deposit, Trade] (1 prompt).
 *  - Both: a pre-sign refusal 19/21 while the keeper is mid-cycle (its accrual has marked the
 *    K/F cohort stale and its follow-up refresh lands ~1-4 s later) is re-checked a few times
 *    before the wallet opens, never signed into a transaction that would fail on chain.
 */
import { useCallback, useState } from "react";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { deriveVaultAuthority, getAta } from "@percolatorct/sdk";
import { portfolioAccountLen } from "@/lib/v22/layout";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { assertDepositWithinBalance } from "@/lib/deposit-guard";
import { SimulationRefusal, sendTx } from "@/lib/tx";
import { tradeCuCap } from "@/lib/compute-budget";
import { fetchAssetMarketId, fetchPortfolioIdentity } from "@/lib/v18-wire";
import { findV17Portfolio, resolveLpTradeAccounts } from "@/hooks/useTrade";
import {
  buildFirstDepositIx,
  buildFirstTradeInitIxs,
  buildFundAndTradeIxs,
  type FirstTradeIxParams,
  isPortfolioIdRace,
  predictPortfolioId,
  readNextPortfolioId,
} from "@/lib/first-trade";
import { invalidatePortfolio } from "@/lib/portfolio-invalidation";
import { measureFill, recordFillResult } from "@/lib/limits/fill-check";
import { recordFeeRaise, type FeeRaise } from "@/lib/v22/fee-raise-note";
import { signedPositionForAsset } from "@/lib/limits/decode";
import { readU64LE } from "@/lib/u64le";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { fetchTradeFeeBps, sendWithUtilFeeRetry } from "@/lib/limits/trade-fee-resolve";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { marketAssetSlots } from "@/lib/v22/trade-refresh";
import { planTradeRefresh, sendMultiAssetOrder, sendWithRefreshRetry } from "@/lib/v22/trade-refresh-wire";
import type { MultiAssetSendKind } from "@/lib/v22/trade-refresh";
import { MAX_TX_COMPUTE_UNITS } from "@/lib/compute-budget";
import { isLossStaleError } from "@/lib/v21/loss-stale-retry";
import { presignWait } from "@/lib/first-trade-wait";
import { pythCrankAccount } from "@/lib/limits/oracle-tail";
import { crankOracleTail } from "@/lib/limits/vault-lp-repair";

/** CU cap for [deposit, trade]: the trade's cap + the deposit. */
const FUND_AND_TRADE_CU_CAP = tradeCuCap(1) + 60_000;
/** CU cap for the first trade: + CreateAccount and InitPortfolio (~38k measured; 60k budgeted). */
export const FIRST_TRADE_CU_CAP = FUND_AND_TRADE_CU_CAP + 60_000;

/**
 * Pre-sign re-checks of a 19/21 refusal (nothing is signed or sent while waiting). Measured live
 * 2026-10-02 (keeper 90f0ffe, 30 markets, 7 min): 13 stale-cohort windows, 11 of them 0.8-3.9 s
 * (the keeper's follow-up refresh), 2 of ~20 s (one cycle). 3 x 1.5 s covers the common window;
 * past it the ticket shows the calm "Nothing was sent. Try again in a moment." line.
 */
export const PRESIGN_WAIT_ATTEMPTS = 3;
export const PRESIGN_WAIT_MS = 1_500;

/** A pre-sign wrapper refusal that the keeper's next step clears: EngineStale 19 / EngineLockActive 21. */
export function isPresignWaitable(e: unknown, programId: PublicKey): boolean {
  return (
    e instanceof SimulationRefusal &&
    e.programId === programId.toBase58() &&
    (e.code === WRAPPER_ERR.EngineStale || e.code === WRAPPER_ERR.EngineLockActive)
  );
}

export interface FundAndTradeParams {
  /** Signed size (base q). */
  size: bigint;
  depositAtoms: bigint;
  limitPriceE6: bigint;
  feeBps?: bigint;
  /** "12.50 USDC" for the deposit-failure line. */
  amountLabel: string;
  /** The id race happened: the UI labels the extra prompt. */
  onRace?: () => void;
  /**
   * Multi-asset market: the order needs its refresh cranks as their own transaction first, so the wallet may open
   * more than once. Called with the transaction count (2+) before the first one is sent.
   */
  onTwoTx?: (txCount: number) => void;
  /**
   * #49: called once the tx is broadcast and the app is waiting for confirmation (no wallet
   * prompt is open any more). May be called repeatedly while it waits.
   */
  onConfirming?: () => void;
  /**
   * v2.2 QA RT5b: wait through a pre-sign 19 / 21 like the plain trade path (lib/first-trade-wait.ts). Without
   * `maxWaitMs` nothing changes (three quick re-checks).
   */
  maxWaitMs?: number;
  shouldWait?: (e: SimulationRefusal) => boolean;
  onWaiting?: (waiting: boolean) => void;
  onWaitingLong?: () => void;
  abortSignal?: AbortSignal;
}

export interface FundAndTradeResult {
  signature: string;
  portfolio: PublicKey;
  prompts: 1 | 2;
  created: boolean;
}

export function useFirstTrade(slabAddress: string) {
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { config: mktConfig, programId: slabProgramId, wrapperConfigV17, refresh: refreshSlab, raw: slabRaw } = useSlabState();
  const [loading, setLoading] = useState(false);

  const fundAndTrade = useCallback(
    async (p: FundAndTradeParams): Promise<FundAndTradeResult> => {
      // Two errors, not one: the message resolver maps "Wallet not connected" to "Wallet locked", so the old
      // combined string told a connected user to unlock their wallet while the market was still loading.
      if (!wallet.publicKey) throw new Error("Wallet not connected");
      if (!mktConfig || !slabProgramId) throw new Error("Market not loaded");
      assertKnownProgram(slabProgramId);
      const owner = wallet.publicKey;
      const programId = slabProgramId;
      const market = new PublicKey(slabAddress);
      /** Re-run `send` while its pre-sign simulation is refused 19/21 (the wallet never opened). */
      // v2.2 QA RT5b: with a wait budget (the ticket passes one on v2.2) this waits like the plain trade path.
      const withPresignWait = <T,>(send: () => Promise<T>): Promise<T> =>
        presignWait(send, {
          waitable: (e) => isPresignWaitable(e, programId),
          legacyAttempts: PRESIGN_WAIT_ATTEMPTS,
          legacyDelayMs: PRESIGN_WAIT_MS,
          maxWaitMs: p.maxWaitMs,
          shouldWait: p.shouldWait,
          onWaiting: p.onWaiting,
          onWaitingLong: p.onWaitingLong,
          abortSignal: p.abortSignal,
          onRecheck: (e, n) => console.info(`[first-trade] pre-sign ${(e as SimulationRefusal).code}: market mid-update, re-checking (${n}${p.maxWaitMs === undefined ? `/${PRESIGN_WAIT_ATTEMPTS}` : ""})`),
        });
      setLoading(true);
      try {
        const userAta = await getAta(owner, mktConfig.collateralMint);
        const [vaultPda] = deriveVaultAuthority(programId, market);
        const vaultTokenAta = await getAta(vaultPda, mktConfig.collateralMint, true);
        const ataInfo = await connection.getAccountInfo(userAta);
        const ataBalance = ataInfo && ataInfo.data.length >= 72 ? readU64LE(ataInfo.data, 64) : 0n;
        assertDepositWithinBalance(p.depositAtoms, ataBalance);

        const [lp, marketId] = await Promise.all([
          resolveLpTradeAccounts(connection, programId, market),
          fetchAssetMarketId(connection, market, 0),
        ]);
        const lpId = await fetchPortfolioIdentity(connection, lp.accountB);
        // Q-1 (v2.2 QA): sign the SDK rule (base + worst-case matcher fee + 5, capped at the market
        // maximum; lib/limits/trade-fee-resolve.ts), else Custom 9 on the first fill. Flag off: unchanged.
        let feeBps = isDevnetV22Enabled()
          ? await fetchTradeFeeBps(connection, market, lp.matcherCtx, { fallback: p.feeBps ?? wrapperConfigV17?.tradeFeeBps })
          : p.feeBps;
        // v2.2 QA U-2: on a 98 the body is rebuilt ONCE with the cap that covers the utilisation fee (sendWithUtilFeeRetry).
        let feeRaise: FeeRaise | null = null;
        const raiseFee = async (): Promise<void> => {
          const before = feeBps;
          feeBps = await fetchTradeFeeBps(connection, market, lp.matcherCtx, { fallback: feeBps, withUtilMax: true });
          if (before !== undefined && feeBps !== undefined) feeRaise = { fromBps: before, toBps: feeBps };
        };
        // The same liveness repairs a normal trade gets (useTrade): a lagging engine clock or a lapsed
        // backing bucket otherwise refuses every deposit-and-trade, the path new wallets onboard on.
        // Market-level repairs + an LP catch-up crank: valid with no taker portfolio, wallet signs.
        const selfHeal = {
          programId,
          market,
          catchUp: { portfolio: lp.accountB, oracleTail: crankOracleTail(pythCrankAccount(mktConfig, wrapperConfigV17?.oracleMode)) },
        };
        const ixp = (portfolio: PublicKey): FirstTradeIxParams => ({
          programId, owner, market, portfolio, userAta, vaultTokenAta, depositAtoms: p.depositAtoms,
          lp, lpId, marketId, size: p.size, limitPriceE6: p.limitPriceE6, feeBps, marketTradeFeeBps: wrapperConfigV17?.tradeFeeBps,
        });
        // A confirmed TradeCpi is not proof the requested size filled: the matcher clips an
        // order to the LP's inventory room and the trade still returns Ok (a $100 order into a
        // market with 72 q of room landed as 0.000072 SOL). Measure the position delta with the
        // same slot-pinned read useTrade uses and hand it to the ticket (takeFillResult), so it
        // reports what filled instead of the requested size. measureFill never throws; a read
        // it cannot pin is "unknown", which leaves the ticket's legacy behaviour unchanged.
        const recordFill = async (signature: string, portfolio: PublicKey, beforeQ: bigint | null) =>
          recordFillResult(signature, await measureFill(connection, portfolio, signature, beforeQ, p.size, marketId));

        // v2.2 QA U-1 / R-1 / Q-7b (lib/v22/trade-refresh.ts): the multi-asset refresh shape when the LP or the taker
        // holds >= 3 legs, and the stale peers' refresh cranks in the SAME tx when the order is refused 121.
        const sendRefreshed = async (body: TransactionInstruction[], takerPortfolio: PublicKey | null, o: { signers?: Keypair[]; cap: number }): Promise<string> => {
          // `kind` (multi-asset markets): a refresh tx or an order carrying cranks may need up to the 1.4M maximum and
          // never gets the self-heal catch-up crank in front; the order alone keeps today's cap and self-heal. Only the
          // order carries the new portfolio's keypair signer (a refresh tx has no account to create).
          const send = (ixs: TransactionInstruction[], kind: MultiAssetSendKind = "order") =>
            sendTx({
              connection, wallet, instructions: ixs,
              ...(o.signers && kind !== "refresh" ? { signers: o.signers } : {}),
              computeUnitsFromSim: { cap: kind === "order" ? o.cap : MAX_TX_COMPUTE_UNITS },
              onProgress: p.onConfirming,
              ...(kind === "order" ? { selfHeal } : {}),
            });
          if (!isDevnetV22Enabled() || !slabRaw) return send(body);
          const multiAsset = (marketAssetSlots(slabRaw) ?? 1) > 1;
          const input = { programId, market, marketData: slabRaw, cranker: owner, takerPortfolio, lpPortfolio: lp.accountB, body };
          try {
            if (multiAsset) {
              // Multi-asset market (fresh-taker fix): the order goes ALONE; on a 121 / 19 the refresh cranks go in the
              // same tx under 1.2M CU, otherwise as their own tx first. Never an observing crank in the order's tx.
              const r = await sendMultiAssetOrder(connection, input, send, { onTwoTx: p.onTwoTx });
              console.info(`[first-trade] multi-asset order: ${r.path}, ${r.cycles} refresh cycle(s)`);
              return r.signature;
            }
            return await send(body);
          } catch (e) {
            if (!multiAsset && isLossStaleError(e, programId.toBase58())) {
              const first = await planTradeRefresh(connection, input, { withPeers: true });
              if (first.cranks.some((c) => c.role === "peer")) {
                console.info(`[first-trade] 121: refreshing ${first.cranks.filter((c) => c.role === "peer").length} stale peer(s) in the same tx`);
                let planned: TransactionInstruction[] | null = first.instructions;
                return sendWithRefreshRetry(async () => {
                  const ixs = planned ?? (await planTradeRefresh(connection, input, { withPeers: true })).instructions;
                  planned = null;
                  return ixs;
                }, send);
              }
            }
            throw e;
          }
        };

        // ── Returning user: the account exists — [Deposit, Trade] in ONE tx (1 prompt). ──
        const existing = await findV17Portfolio(connection, programId, market, owner);
        if (existing) {
          const id = await fetchPortfolioIdentity(connection, existing);
          // The position BEFORE the trade, for the fill measurement (null = unread -> "unknown").
          const beforeInfo = await connection.getAccountInfo(existing, "confirmed").catch(() => null);
          const beforeQ = beforeInfo ? signedPositionForAsset(new Uint8Array(beforeInfo.data), 0, marketId) : null;
          const signature = await withPresignWait(() =>
            sendWithUtilFeeRetry(async (raised) => {
              if (raised) await raiseFee();
              return sendRefreshed(buildFundAndTradeIxs(ixp(existing), { portfolioId: id.portfolioId, sequence: id.matcherSequence, positionEpoch: id.positionEpoch }), existing, { cap: FUND_AND_TRADE_CU_CAP });
            }),
          );
          recordFeeRaise(signature, feeRaise);
          await recordFill(signature, existing, beforeQ);
          invalidatePortfolio();
          refreshSlab();
          return { signature, portfolio: existing, prompts: 1, created: false };
        }

        // ── First trade: ONE tx [create, init, deposit, trade] at the predicted id. ──
        // sendTx simulates the whole list before the wallet opens (its CU-sizing simulation is
        // the pre-sign verdict), so a refusal of any leg is caught there and mapped to its line;
        // the portfolio keypair signs AFTER the wallet (embedded wallets strip earlier signatures).
        const rent = await connection.getMinimumBalanceForRentExemption(portfolioAccountLen());
        let prompts: 1 | 2 = 1;
        for (let raceRetry = 0; ; raceRetry++) {
          const marketInfo = await connection.getAccountInfo(market, "confirmed");
          const next = marketInfo ? readNextPortfolioId(new Uint8Array(marketInfo.data)) : null;
          if (next === null) throw new Error("Market not loaded");
          const kp = Keypair.generate();
          const buildIxs = (): TransactionInstruction[] => [
            ...buildFirstTradeInitIxs({ programId, owner, market, portfolio: kp.publicKey }, rent),
            ...buildFundAndTradeIxs(ixp(kp.publicKey), { portfolioId: predictPortfolioId(next), sequence: 0n, positionEpoch: 0n }),
          ];
          try {
            const signature = await withPresignWait(() =>
              sendWithUtilFeeRetry(async (raised) => {
                if (raised) await raiseFee();
                return sendRefreshed(buildIxs(), null, { signers: [kp], cap: FIRST_TRADE_CU_CAP });
              }),
            );
            // A brand-new portfolio holds no position before this transaction.
            recordFeeRaise(signature, feeRaise);
            await recordFill(signature, kp.publicKey, 0n);
            invalidatePortfolio();
            refreshSlab();
            return { signature, portfolio: kp.publicKey, prompts, created: true };
          } catch (e) {
            // Someone took the predicted id first. The tx is atomic, so nothing landed: rebuild
            // with the new next id. Refused before the wallet opened: no extra prompt, no note.
            if (raceRetry === 0 && isPortfolioIdRace(e)) {
              if (!(e instanceof SimulationRefusal)) {
                prompts = 2;
                p.onRace?.();
              }
              continue;
            }
            throw e;
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [wallet, connection, mktConfig, slabProgramId, wrapperConfigV17, slabAddress, refreshSlab],
  );

  /**
   * SOL-2 (v2.2 QA 2026-10-11): deposit WITHOUT trading. A new user could only fund through the first
   * trade (the Deposit / Withdraw toggles need an account), so a refused first trade left deposit,
   * add-margin and withdraw unreachable. No account: ONE transaction [CreateAccount, InitPortfolio,
   * Deposit(predicted id, sequence 0)] (the same legs and id prediction the first trade uses, minus
   * the trade); the account exists: one Deposit with its live identity.
   */
  const createAndDeposit = useCallback(
    async (depositAtoms: bigint): Promise<{ signature: string; portfolio: PublicKey; created: boolean }> => {
      // Same split as fundAndTrade above (#3366).
      if (!wallet.publicKey) throw new Error("Wallet not connected");
      if (!mktConfig || !slabProgramId) throw new Error("Market not loaded");
      if (depositAtoms <= 0n) throw new Error("Enter an amount to deposit.");
      assertKnownProgram(slabProgramId);
      const owner = wallet.publicKey;
      const programId = slabProgramId;
      const market = new PublicKey(slabAddress);
      const withPresignWait = async <T,>(send: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await send();
          } catch (e) {
            if (attempt >= PRESIGN_WAIT_ATTEMPTS || !isPresignWaitable(e, programId)) throw e;
            await new Promise((r) => setTimeout(r, PRESIGN_WAIT_MS));
          }
        }
      };
      setLoading(true);
      try {
        const userAta = await getAta(owner, mktConfig.collateralMint);
        const [vaultPda] = deriveVaultAuthority(programId, market);
        const vaultTokenAta = await getAta(vaultPda, mktConfig.collateralMint, true);
        const ataInfo = await connection.getAccountInfo(userAta);
        const ataBalance = ataInfo && ataInfo.data.length >= 72 ? readU64LE(ataInfo.data, 64) : 0n;
        assertDepositWithinBalance(depositAtoms, ataBalance);
        const legs = (portfolio: PublicKey) => ({ programId, owner, market, portfolio, userAta, vaultTokenAta, depositAtoms });

        const existing = await findV17Portfolio(connection, programId, market, owner);
        if (existing) {
          const id = await fetchPortfolioIdentity(connection, existing);
          const signature = await withPresignWait(() =>
            sendTx({ connection, wallet, instructions: [buildFirstDepositIx(legs(existing), { portfolioId: id.portfolioId, sequence: id.matcherSequence })] }),
          );
          invalidatePortfolio();
          refreshSlab();
          return { signature, portfolio: existing, created: false };
        }

        const rent = await connection.getMinimumBalanceForRentExemption(portfolioAccountLen());
        for (let raceRetry = 0; ; raceRetry++) {
          const marketInfo = await connection.getAccountInfo(market, "confirmed");
          const next = marketInfo ? readNextPortfolioId(new Uint8Array(marketInfo.data)) : null;
          if (next === null) throw new Error("Market not loaded");
          const kp = Keypair.generate();
          const ixs: TransactionInstruction[] = [
            ...buildFirstTradeInitIxs({ programId, owner, market, portfolio: kp.publicKey }, rent),
            buildFirstDepositIx(legs(kp.publicKey), { portfolioId: predictPortfolioId(next), sequence: 0n }),
          ];
          try {
            const signature = await withPresignWait(() =>
              sendTx({ connection, wallet, instructions: ixs, signers: [kp], computeUnitsFromSim: { cap: FIRST_TRADE_CU_CAP } }),
            );
            invalidatePortfolio();
            refreshSlab();
            setTimeout(() => refreshSlab(), 2000);
            return { signature, portfolio: kp.publicKey, created: true };
          } catch (e) {
            // Someone took the predicted id first: the tx is atomic, rebuild once with the real next id.
            if (raceRetry === 0 && isPortfolioIdRace(e)) continue;
            throw e;
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [wallet, connection, mktConfig, slabProgramId, slabAddress, refreshSlab],
  );

  return { fundAndTrade, createAndDeposit, loading };
}
