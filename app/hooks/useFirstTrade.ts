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
import { V17_PORTFOLIO_ACCOUNT_LEN, deriveVaultAuthority, getAta } from "@percolatorct/sdk";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { assertDepositWithinBalance } from "@/lib/deposit-guard";
import { SimulationRefusal, sendTx } from "@/lib/tx";
import { tradeCuCap } from "@/lib/compute-budget";
import { fetchAssetMarketId, fetchPortfolioIdentity } from "@/lib/v18-wire";
import { findV17Portfolio, resolveLpTradeAccounts } from "@/hooks/useTrade";
import {
  buildFirstTradeInitIxs,
  buildFundAndTradeIxs,
  type FirstTradeIxParams,
  isPortfolioIdRace,
  predictPortfolioId,
  readNextPortfolioId,
} from "@/lib/first-trade";
import { generateIsolatedKeypair } from "@/lib/owner-portfolio";
import { invalidatePortfolio } from "@/lib/portfolio-invalidation";
import { readU64LE } from "@/lib/u64le";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

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

/** Shown when an isolated open is requested before the wallet has a main (cross) account. */
export const ISOLATED_NEEDS_MAIN_ACCOUNT_COPY =
  "Isolated positions open next to your main account. Make a Cross trade or a deposit first. Nothing was sent.";

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
  /** #2560 isolated margin: open in a NEW portfolio even when the wallet already
   *  owns one on this market, so the position gets its own isolated collateral.
   *  Omitted/false → today's behaviour (reuse the existing portfolio if any).
   *  Requires the wallet to already own its main (cross) portfolio on this
   *  market; the new keypair is ground to sort AFTER it (generateIsolatedKeypair)
   *  so the isolated portfolio can never become the wallet's primary/cross. */
  forceNewPortfolio?: boolean;
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
  const { config: mktConfig, programId: slabProgramId, wrapperConfigV17, refresh: refreshSlab } = useSlabState();
  const [loading, setLoading] = useState(false);

  const fundAndTrade = useCallback(
    async (p: FundAndTradeParams): Promise<FundAndTradeResult> => {
      if (!wallet.publicKey || !mktConfig || !slabProgramId) throw new Error("Wallet not connected or market not loaded");
      assertKnownProgram(slabProgramId);
      const owner = wallet.publicKey;
      const programId = slabProgramId;
      const market = new PublicKey(slabAddress);
      /** Re-run `send` while its pre-sign simulation is refused 19/21 (the wallet never opened). */
      const withPresignWait = async <T,>(send: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await send();
          } catch (e) {
            if (attempt >= PRESIGN_WAIT_ATTEMPTS || !isPresignWaitable(e, programId)) throw e;
            console.info(`[first-trade] pre-sign ${(e as SimulationRefusal).code}: market mid-update, re-checking (${attempt + 1}/${PRESIGN_WAIT_ATTEMPTS})`);
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
        assertDepositWithinBalance(p.depositAtoms, ataBalance);

        const [lp, marketId] = await Promise.all([
          resolveLpTradeAccounts(connection, programId, market),
          fetchAssetMarketId(connection, market, 0),
        ]);
        const lpId = await fetchPortfolioIdentity(connection, lp.accountB);
        const ixp = (portfolio: PublicKey): FirstTradeIxParams => ({
          programId, owner, market, portfolio, userAta, vaultTokenAta, depositAtoms: p.depositAtoms,
          lp, lpId, marketId, size: p.size, limitPriceE6: p.limitPriceE6, feeBps: p.feeBps, marketTradeFeeBps: wrapperConfigV17?.tradeFeeBps,
        });

        // ── Returning user: the account exists — [Deposit, Trade] in ONE tx (1 prompt). ──
        // #2560: an ISOLATED open skips this reuse and always creates a fresh
        // portfolio below, so the position is margined by its own collateral.
        const primary = await findV17Portfolio(connection, programId, market, owner);
        // An isolated open is only defined next to an existing cross portfolio: with none,
        // the new account would BECOME the cross account (the lowest pubkey is primary).
        if (p.forceNewPortfolio && !primary) throw new Error(ISOLATED_NEEDS_MAIN_ACCOUNT_COPY);
        const existing = p.forceNewPortfolio ? null : primary;
        if (existing) {
          const id = await fetchPortfolioIdentity(connection, existing);
          const signature = await withPresignWait(() =>
            sendTx({
              connection,
              wallet,
              instructions: buildFundAndTradeIxs(ixp(existing), { portfolioId: id.portfolioId, sequence: id.matcherSequence, positionEpoch: id.positionEpoch }),
              computeUnitsFromSim: { cap: FUND_AND_TRADE_CU_CAP },
            }),
          );
          invalidatePortfolio();
          refreshSlab();
          return { signature, portfolio: existing, prompts: 1, created: false };
        }

        // ── First trade: ONE tx [create, init, deposit, trade] at the predicted id. ──
        // sendTx simulates the whole list before the wallet opens (its CU-sizing simulation is
        // the pre-sign verdict), so a refusal of any leg is caught there and mapped to its line;
        // the portfolio keypair signs AFTER the wallet (embedded wallets strip earlier signatures).
        const rent = await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);
        let prompts: 1 | 2 = 1;
        for (let raceRetry = 0; ; raceRetry++) {
          const marketInfo = await connection.getAccountInfo(market, "confirmed");
          const next = marketInfo ? readNextPortfolioId(new Uint8Array(marketInfo.data)) : null;
          if (next === null) throw new Error("Market not loaded");
          // Isolated: grind a keypair that sorts after the cross/primary (never becomes primary).
          const kp = p.forceNewPortfolio && primary ? generateIsolatedKeypair(primary) : Keypair.generate();
          const ixs: TransactionInstruction[] = [
            ...buildFirstTradeInitIxs({ programId, owner, market, portfolio: kp.publicKey }, rent),
            ...buildFundAndTradeIxs(ixp(kp.publicKey), { portfolioId: predictPortfolioId(next), sequence: 0n, positionEpoch: 0n }),
          ];
          try {
            const signature = await withPresignWait(() =>
              sendTx({ connection, wallet, instructions: ixs, signers: [kp], computeUnitsFromSim: { cap: FIRST_TRADE_CU_CAP } }),
            );
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

  return { fundAndTrade, loading };
}
