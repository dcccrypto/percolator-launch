"use client";

/**
 * UX WP-6 (audit §3.2): fund and trade in one approval.
 *  - No trading account yet: tx A = [CreateAccount, InitPortfolio], tx B = [Deposit, Trade] with
 *    the PREDICTED portfolio id (lib/first-trade.ts); both signed in ONE prompt; A lands, then B.
 *    A race on the id (someone initialised in between) rebuilds B with the real id: one more
 *    prompt, labelled. A failed deposit leg is surfaced (FirstTradeDepositError), never swallowed.
 *  - Account exists but short of margin: one tx [Deposit, Trade] (1 prompt).
 */
import { useCallback, useState } from "react";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN, deriveVaultAuthority, getAta } from "@percolatorct/sdk";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { assertDepositWithinBalance } from "@/lib/deposit-guard";
import {
  SimulationRefusal,
  broadcastSignedTx,
  buildBatchTx,
  getPriorityFee,
  sendTx,
  signAllCompat,
  simulateForGate,
} from "@/lib/tx";
import { tradeCuCap } from "@/lib/compute-budget";
import { fetchAssetMarketId, fetchPortfolioIdentity } from "@/lib/v18-wire";
import { findV17Portfolio, resolveLpTradeAccounts } from "@/hooks/useTrade";
import {
  buildFirstTradeInitIxs,
  buildFundAndTradeIxs,
  type FirstTradeIxParams,
  FirstTradeDepositError,
  failedFirstTradeLeg,
  isPortfolioIdRace,
  predictPortfolioId,
  readNextPortfolioId,
} from "@/lib/first-trade";
import { invalidatePortfolio } from "@/lib/portfolio-invalidation";
import { readU64LE } from "@/lib/u64le";
import { healedListUsable, isRepairableFailure } from "@/lib/self-heal";
import {
  STALE_REFRESH_CU,
  buildStaleRefreshIx,
  decodeStaleCohort,
  findStalePortfolios,
  hasStaleCohort,
} from "@/lib/stale-refresh";

/** Thrown before the wallet opens when the pre-sign simulation could not reach Solana. */
export const PRESIGN_SIM_UNREACHABLE = "Couldn't reach Solana to check this order. Nothing was sent.";

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
}

export interface FundAndTradeResult {
  signature: string;
  portfolio: PublicKey;
  prompts: 1 | 2;
  created: boolean;
}

/** GH#2953: stale-cohort refresh attempts before the first trade gives up (lib/stale-refresh.ts). */
export const STALE_REFRESH_ATTEMPTS = 3;
export const STALE_REFRESH_RETRY_MS = 1_500;

/** Budget prefix sendTx/buildBatchTx put in front (heap frame + CU limit + CU price). */
const BUDGET_PREFIX = 3;

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
        const existing = await findV17Portfolio(connection, programId, market, owner);
        if (existing) {
          const id = await fetchPortfolioIdentity(connection, existing);
          const signature = await sendTx({
            connection,
            wallet,
            instructions: buildFundAndTradeIxs(ixp(existing), { portfolioId: id.portfolioId, sequence: id.matcherSequence, positionEpoch: id.positionEpoch }),
            computeUnitsFromSim: { cap: tradeCuCap(1) + 60_000 },
            selfHeal: { programId, market, staleRefresh: true },
          });
          invalidatePortfolio();
          refreshSlab();
          return { signature, portfolio: existing, prompts: 1, created: false };
        }

        // ── First trade: A = [create, init]; B = [deposit, trade] at the predicted id. ──
        const marketInfo = await connection.getAccountInfo(market, "confirmed");
        const next = marketInfo ? readNextPortfolioId(new Uint8Array(marketInfo.data)) : null;
        if (next === null) throw new Error("Market not loaded");
        const predicted = predictPortfolioId(next);
        const kp = Keypair.generate();
        const rent = await connection.getMinimumBalanceForRentExemption(V17_PORTFOLIO_ACCOUNT_LEN);
        const aIxs: TransactionInstruction[] = buildFirstTradeInitIxs({ programId, owner, market, portfolio: kp.publicKey }, rent);
        // A is simulated alone (its CU sizing), then A+B as ONE simulated list: B's portfolio
        // does not exist until A lands, but inside one simulated tx it does, so a refusal of the
        // trade leg (SameOwnerTrade 67, exec band 66, caps 68-70, ...) is caught here, before the
        // wallet opens, attributed to the program that raised it, and mapped to its line.
        const simA = await simulateForGate(connection, owner, aIxs);
        if (simA.err) throw new SimulationRefusal(simA.err, simA.logs, simA.simulated);
        let bIxs = buildFundAndTradeIxs(ixp(kp.publicKey), { portfolioId: predicted, sequence: 0n, positionEpoch: 0n });
        let simAB = await simulateForGate(connection, owner, [...aIxs, ...bIxs]);
        // GH#2953: a stale K/F cohort the keeper could not refresh refuses every new position
        // Custom(21). Refresh those portfolios at the front of B (the trade's own tx) and keep
        // them only when that clears the 19/21 (lib/stale-refresh.ts).
        // A refresh is refused (22) while a newer mark is pending, so a few short retries.
        let refreshes = 0;
        for (let attempt = 0; attempt < STALE_REFRESH_ATTEMPTS && refreshes === 0; attempt++) {
          if (!simAB.err || !isRepairableFailure(simAB.err, simAB.simulated, programId)) break;
          if (attempt > 0) await new Promise((r) => setTimeout(r, STALE_REFRESH_RETRY_MS));
          const now = await connection.getAccountInfo(market, "confirmed");
          const cohort = now ? decodeStaleCohort(new Uint8Array(now.data)) : null;
          if (!cohort || !hasStaleCohort(cohort)) break;
          const stale = await findStalePortfolios(connection, programId, market, cohort).catch(() => []);
          if (stale.length === 0) break;
          const refreshIxs = stale.map((pf) => buildStaleRefreshIx(programId, owner, market, pf));
          const healed = await simulateForGate(connection, owner, [...aIxs, ...refreshIxs, ...bIxs]);
          console.info(`[first-trade] stale-cohort refresh x${refreshIxs.length} (attempt ${attempt + 1}): ${healed.err ? JSON.stringify(healed.err) : "clean"}`);
          if (!healed.rpcFailed && healedListUsable(healed.err, healed.simulated, programId, healed.simulated.length - bIxs.length)) {
            bIxs = [...refreshIxs, ...bIxs];
            simAB = healed;
            refreshes = refreshIxs.length;
          }
        }
        if (simAB.err) throw new SimulationRefusal(simAB.err, simAB.logs, simAB.simulated);
        // A simulation that could not RUN (RPC error) is not a pass: signing on it would let A
        // (create + init) land and B fail on chain, the "Something went wrong" path. Stop first.
        if (simA.rpcFailed || simAB.rpcFailed) throw new Error(PRESIGN_SIM_UNREACHABLE);
        const [{ blockhash }, fee] = await Promise.all([connection.getLatestBlockhash("confirmed"), getPriorityFee(connection)]);
        const txA = buildBatchTx({ instructions: aIxs, computeUnits: Math.max(60_000, Math.ceil((simA.consumed ?? 50_000) * 1.3)), priorityFeeMicroLamports: fee, blockhash, feePayer: owner });
        const txB = buildBatchTx({ instructions: bIxs, computeUnits: tradeCuCap(1) + 60_000 + STALE_REFRESH_CU * refreshes, priorityFeeMicroLamports: fee, blockhash, feePayer: owner });
        const [signedA, signedB] = await signAllCompat(wallet, [txA, txB]);
        // The portfolio keypair co-signs AFTER the wallet (embedded wallets strip earlier signatures).
        signedA.partialSign(kp);
        await broadcastSignedTx(connection, signedA);
        try {
          const signature = await broadcastSignedTx(connection, signedB);
          invalidatePortfolio();
          refreshSlab();
          return { signature, portfolio: kp.publicKey, prompts: 1, created: true };
        } catch (e) {
          if (isPortfolioIdRace(e)) {
            p.onRace?.();
            const id = await fetchPortfolioIdentity(connection, kp.publicKey);
            const signature = await sendTx({
              connection,
              wallet,
              instructions: buildFundAndTradeIxs(ixp(kp.publicKey), { portfolioId: id.portfolioId, sequence: id.matcherSequence, positionEpoch: id.positionEpoch }),
              computeUnitsFromSim: { cap: tradeCuCap(1) + 60_000 },
              selfHeal: { programId, market, staleRefresh: true },
            });
            invalidatePortfolio();
            refreshSlab();
            return { signature, portfolio: kp.publicKey, prompts: 2, created: true };
          }
          invalidatePortfolio();
          refreshSlab();
          if (failedFirstTradeLeg(e, BUDGET_PREFIX + refreshes) === "deposit") throw new FirstTradeDepositError(p.amountLabel, e);
          throw e;
        }
      } finally {
        setLoading(false);
      }
    },
    [wallet, connection, mktConfig, slabProgramId, wrapperConfigV17, slabAddress, refreshSlab],
  );

  return { fundAndTrade, loading };
}
