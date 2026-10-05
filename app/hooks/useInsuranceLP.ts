'use client';

import { assertV1AllowsNewFunds } from "@/lib/v21/move/close-only";
import { vaultWithdrawView } from '@/lib/limits/earn-withdrawable';
import type { BlockedBy, WithdrawStatus } from '@/lib/limits/earn-withdrawable';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  unpackMint,
  unpackAccount,
} from '@solana/spl-token';
import {
  deriveInsuranceLpMint,
  deriveLpVaultRegistry,
  deriveLpRedemption,
  deriveLpEscrow,
  encodeCreateLpVaultV17,
  encodeRequestRedeemLpShares,
  ACCOUNTS_CREATE_LP_VAULT,
  buildAccountMetas,
  buildIx,
  WELL_KNOWN,
  deriveVaultAuthority,
  deriveLpBackingLedger,
  parseLpVaultRegistry,
  parseLpRedemption,
} from '@percolatorct/sdk';
import { sendTx, broadcastSignedTx, buildBatchTx, getFreshBlockhash, getPriorityFee, signAllCompat, simulateForGate } from '@/lib/tx';
import { sizeComputeUnitLimit } from '@/lib/compute-budget';
import { useSlabState } from '../components/providers/SlabProvider';
import { assertKnownProgram } from '@/lib/programAllowlist';
import { assertDepositWithinBalance, readTokenBalance } from '@/lib/deposit-guard';
import { useParams } from 'next/navigation';
import { pythCrankAccount } from "@/lib/limits/oracle-tail";
import { isDevnetV21Enabled } from "@/lib/v21/flag";
import { EXIT_CRANK_CU_CAP, planExitCranks, readOpenPortfolios } from "@/lib/v21/exit-cranks";
import { crankOracleTail } from "@/lib/limits/vault-lp-repair";
import { MARKET_MODE_LIVE } from "@/lib/limits/constants";
import { limitsFlags } from "@/lib/limits/flags";
import { earnVaultLpRepairOption } from "@/lib/limits/vault-lp-repair";
import { buildEarnDepositIxs, buildEarnExecuteIxs, buildRequestRedeemIx, earnTxPlan, sendWithHarvestOn84, sendWithUpgradeRetry, withForcedHarvest, type EarnTxPlan } from "@/lib/limits/earn-ixs";
import { SimulationRefusal } from "@/lib/tx";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { readEarnP3Context } from "@/lib/limits/earn-p3-read";
import { readEmptyCloseIxs, readViewerTopupIxs } from "@/lib/limits/resolved-exit-load";
import { sendWithTopup } from "@/lib/limits/resolved-topup";
import { computeBudgetPrefix, connectionSelfHealDeps } from "@/lib/self-heal";
import { readTxDrawSummary, type DrawSummary } from "@/lib/limits/p3-draw-logs";
import { withdrawFlow } from "@/lib/limits/earn-withdraw";
import {
  buildCancelRedemptionIx,
  cappedShares,
  combinedVault,
  planSplitPotRedemption,
  readSplitPotState,
  readVaultPotState,
  vaultBackingNav,
  type SplitPotState,
  repairUnderwaterPot,
  splitPotPrefixIxs,
  planEarnDeposit,
  EarnDepositsPausedError,
} from "@/lib/limits/earn-split-pot";
import { TAG_DEPOSIT_TO_LP_VAULT, TAG_EXECUTE_REDEMPTION } from "@/lib/limits/constants";
import { COPY as LIMITS_COPY } from "@/lib/limits/copy";
import { sanitizeOnChainValue } from '@/lib/health';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import {
  NO_BALANCE_KNOWN,
  balanceKey,
  resolveTokenBalance,
  type KnownBalance,
  type TokenRead,
} from '@/lib/token-balance';

/**
 * Bytes left free in a bundled Earn payout for the instructions sendTx can add (review of #2721,
 * measured with the app builders): up to 8 liveness repairs (64 B) + vault-LP crank with oracle tail
 * (52 B) + senior-draw crank (20 B) + recall (30 B) = 166 B; 180 B with margin.
 */
const SELF_HEAL_RESERVE_BYTES = 180;

/**
 * Which LP-vault redemption step a `withdraw()` call actually ran:
 *  - 'requested' — RequestRedeemLpShares (tag 76) fired. This only starts the
 *    cooldown ticket; NO funds have moved yet.
 *  - 'executed' — ExecuteRedemption (tag 77) fired. Funds were sent to the
 *    caller's wallet.
 * S2 fix: callers must branch on this to avoid showing a false "Withdrawal
 * successful!" toast after a 'requested' step.
 */
export type RedemptionStep = 'requested' | 'executed';

export interface WithdrawResult {
  step: RedemptionStep;
  signature: string;
}

export interface InsuranceLPState {
  /** Insurance fund balance in base tokens (lamports) */
  insuranceBalance: bigint;
  /** Total LP token supply */
  lpSupply: bigint;
  /** User's LP token balance */
  userLpBalance: bigint;
  /** Current redemption rate (insurance_balance / lp_supply) in e6 */
  redemptionRateE6: bigint;
  /** User's share of the pool as a percentage */
  userSharePct: number;
  /** User's redeemable value in base tokens */
  userRedeemableValue: bigint;
  /** Whether insurance LP mint exists for this market */
  mintExists: boolean;
  /** The insurance LP mint address */
  lpMintAddress: PublicKey | null;
  /** Decimals of the LP token mint (NOT collateral decimals) */
  lpDecimals: number;

  // ─── LP Vault Registry (v17 "Earn" vault — CreateLpVault/DepositToLpVault,
  // tags 74-77). This is a DIFFERENT on-chain account from the engine-level
  // insurance fund read above (`insuranceBalance`, kept for back-compat with
  // existing consumers of this hook) — it's the actual backing for the Earn
  // page's per-market vault. Verified on-chain 2026-07-07: totalLpSharesOutstanding
  // == 10_000_000_000 (10,000 Sim-USDC) for all 5 curated playground markets.
  /** Whether the LP Vault Registry PDA exists on-chain for this market. */
  registryExists: boolean;
  /** The LP Vault Registry PDA address. */
  registryAddress: PublicKey | null;
  /**
   * The pot of its asset this vault was bound to at CreateLpVault
   * (`registry.domain`). v17 vaults are DUAL-DOMAIN: the vault serves BOTH pots
   * of its asset, and every LP-vault instruction names the pot it acts on, so
   * this must come off-chain rather than being assumed to be 0. Defaults to 0
   * until the registry has been read.
   */
  lpVaultDomain: number;
  /** User's collateral ATA balance (available to deposit), in raw atoms. */
  userCollateralBalance: bigint;
  /** Total atoms currently backing the LP vault: shares outstanding + distributed fee atoms. */
  vaultTotalAtoms: bigint;
  /**
   * The backing NAV the program prices 75 / 77 against (feeds the Earn previews, max-now and the
   * deposit gate). Two-pot vault: the combined NAV (== vaultTotalAtoms). BOUND (P3) vault:
   * `bound_vault_nav` over both pots (lib/limits/earn-split-pot.ts boundVaultNav), NOT the
   * shares + distributed-fees proxy. Falls back to vaultTotalAtoms when the pots are unreadable.
   */
  backingNavAtoms: bigint;
  /** Share price = vaultTotalAtoms / lpSupply, scaled by 1e6 (1_000_000n = 1:1). */
  vaultSharePriceE6: bigint;
  /** User's LP position value in underlying collateral atoms (derived from vaultTotalAtoms, not insuranceBalance). */
  userVaultValueAtoms: bigint;
  /** Redemption cooldown period from the registry, in slots. */
  redemptionCooldownSlots: bigint;
  /** Whether the connected user has an open RequestRedeemLpShares ticket. */
  hasPendingRedemption: boolean;
  /** LP shares locked in the pending redemption ticket (0 if none). */
  pendingRedemptionShares: bigint;
  /** Slots remaining until the pending redemption's cooldown elapses (0 = elapsed or none pending). */
  cooldownRemainingSlots: bigint;
  /** True when there is no pending redemption, or its cooldown has fully elapsed (ready for ExecuteRedemption). */
  cooldownElapsed: boolean;
  /**
   * Non-bound (two-pot) vault only, else null: the program's own pricing (registry shares and the
   * combined NAV 77 pays at), and what the user's whole position (wallet + pending escrow) can be
   * paid right now when that is less than all of it (lib/limits/earn-split-pot.ts).
   */
  splitPot: {
    totalShares: bigint;
    navAtoms: bigint;
    maxNowAtoms: bigint | null;
    /** NAV if every open winner claim were paid now, atoms (lib/limits/earn-withdrawable.ts). */
    claimAdjustedNavAtoms: bigint | null;
    /** The most the whole vault can pay out now (all holders), atoms. */
    vaultMaxNowAtoms: bigint | null;
    withdrawStatus: WithdrawStatus | null;
    blockedBy: BlockedBy;
  } | null;
}

/** P3: refuse (with the reason) before signing when the program would refuse the Earn op. */
function assertEarnPlan(plan: EarnTxPlan): asserts plan is Extract<EarnTxPlan, { ok: true }> {
  if (!plan.ok) throw new Error(LIMITS_COPY.earnPlanBlocked[plan.reason]);
}

export function useInsuranceLP() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  // P3-L2 (flag P3): prepend the vault-LP refresh crank to Earn 75/76/77 only when the
  // unmodified tx would revert VaultLpValuationStale (lib/limits/vault-lp-repair.ts).
  const slabOracleCfg = slabState.config;
  const slabOracleMode = slabState.wrapperConfigV17?.oracleMode;
  const earnRepairFor = useCallback(
    (progPk: PublicKey, marketPk: PublicKey) =>
      // Flag off => undefined with no work at all (no oracle-mode derivation).
      limitsFlags().p3
        ? earnVaultLpRepairOption(true, progPk, marketPk, pythCrankAccount(slabOracleCfg, slabOracleMode))
        : undefined,
    [slabOracleCfg, slabOracleMode],
  );
  /** Devnet v2.1: how many exit cranks the last built payout carries (0 = none; the common case). */
  const exitCranksRef = useRef(0);
  const params = useParams();
  // Prefer the SlabProvider's resolved slab (set from its `slabAddress` prop) so
  // this hook works BOTH on the /earn/[slab] route AND when mounted inside a
  // provider on a route without a `[slab]` param — e.g. the Earn hub's deposit
  // rail, which binds the panel to whichever vault row is selected. Falls back to
  // the route param while the provider's slab is still empty on the first render.
  const slabAddress = slabState.slabAddress || (params?.slab as string | undefined);
  const programId = slabState.programId;

  const [lastDrawSummary, setLastDrawSummary] = useState<DrawSummary | null>(null);
  const [state, setState] = useState<InsuranceLPState>({
    insuranceBalance: 0n,
    lpSupply: 0n,
    userLpBalance: 0n,
    redemptionRateE6: 0n,
    userSharePct: 0,
    userRedeemableValue: 0n,
    mintExists: false,
    lpMintAddress: null,
    lpDecimals: 6,
    registryExists: false,
    registryAddress: null,
    lpVaultDomain: 0,
    userCollateralBalance: 0n,
    vaultTotalAtoms: 0n,
    backingNavAtoms: 0n,
    vaultSharePriceE6: 1_000_000n,
    userVaultValueAtoms: 0n,
    redemptionCooldownSlots: 0n,
    hasPendingRedemption: false,
    pendingRedemptionShares: 0n,
    cooldownRemainingSlots: 0n,
    cooldownElapsed: true,
    splitPot: null,
  });
  // Starts true: this hook backs the Earn page's real data (vault TVL, LP
  // balance, redemption state) via refreshState() below. Starting at `false`
  // meant the very first render — before refreshState's first async fetch had
  // resolved — looked identical to "loaded, and everything is genuinely
  // zero," so the Earn page briefly rendered a $0 vault/empty LP position as
  // if that were confirmed on-chain truth. refreshState() clears this via its
  // early-return branches and a `finally` (see below); the dependency-change
  // effect further down re-arms it to `true` on market/wallet switch so a
  // switch doesn't keep showing the PREVIOUS market's numbers labeled as loaded.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The last vault read failed (RPC error), so `state` is the last good read, or the
  // zero defaults if none has landed. A zero there is unknown, not "no vault".
  const [readError, setReadError] = useState(false);

  // Stabilize wallet.publicKey reference — PublicKey is not referentially stable
  const walletPubkeyStr = wallet.publicKey?.toBase58() ?? null;

  // PERC-9204: stable primitive standing in for `slabState.config` in the
  // effect below. SlabProvider rebuilds `config` as a brand-new object literal
  // on every slab poll (~10s on active markets), even when nothing relevant
  // to this hook actually changed — using the object itself as a dependency
  // re-armed `loading` + re-ran the full ~6-RPC refreshState() on every one of
  // those polls, so the Earn panel kept skeleton-flickering and refetching
  // continuously. `collateralMint` is the only `config` field refreshState
  // actually reads (to derive the user's collateral ATA) — keying on its
  // string form is stable across polls and still updates on a real market
  // switch (including the null → defined transition when config first loads).
  const collateralMintStr = slabState.config?.collateralMint.toBase58() ?? null;
  const slabLoading = slabState.loading;

  // ...and the same treatment for `programId`, for the same reason. The note
  // above stabilizes `config`, but `lpMintInfo`/`registryInfo` below are memos
  // keyed on the raw `programId` OBJECT that return fresh object literals —
  // and they are in the same effect's dep array, so they re-introduced exactly
  // the churn that note is guarding against. SlabProvider rebuilds programId
  // per poll (`programId: owner ?? s.programId`), so the effect re-ran every
  // ~3s on an active market: setLoading(true) + a full 6-call refresh, which
  // shimmered every stat cell on the Earn page. Stabilizing one dependency and
  // not its siblings leaves the effect exactly as unstable as before.
  const programIdStr = programId?.toBase58() ?? null;

  // Derive the insurance LP mint PDA
  const lpMintInfo = useMemo(() => {
    if (!slabAddress || !programIdStr) return null;
    try {
      const slabPubkey = new PublicKey(slabAddress);
      const progPubkey = new PublicKey(programIdStr);
      const [mintPda, bump] = deriveInsuranceLpMint(progPubkey, slabPubkey);
      return { mintPda, bump };
    } catch {
      return null;
    }
  }, [slabAddress, programIdStr]);

  // Derive the LP Vault Registry PDA (and, once a wallet is connected, the
  // redemption-ticket PDA for that wallet). Kept separate from lpMintInfo above
  // so a failure deriving one never blocks the other.
  const registryInfo = useMemo(() => {
    if (!slabAddress || !programIdStr) return null;
    try {
      const slabPubkey = new PublicKey(slabAddress);
      const progPubkey = new PublicKey(programIdStr);
      const [registryPda] = deriveLpVaultRegistry(progPubkey, slabPubkey);
      let redemptionPda: PublicKey | null = null;
      if (walletPubkeyStr) {
        const walletPk = new PublicKey(walletPubkeyStr);
        [redemptionPda] = deriveLpRedemption(progPubkey, registryPda, walletPk);
      }
      return { registryPda, redemptionPda, progPubkey };
    } catch {
      return null;
    }
  }, [slabAddress, programIdStr, walletPubkeyStr]);

  // S-H1 fix: bumped at the start of every refreshState() call. Lets a stale
  // in-flight call detect that a newer call has since started (e.g. wallet
  // switched or slab changed mid-fetch) and bail out instead of overwriting
  // fresher state with stale data once its sequential awaits finally
  // resolve. Mirrors the equivalent guard in useStakePool.ts.
  const requestIdRef = useRef(0);
  // #2545: last balances actually OBSERVED (not "last published state"),
  // tagged with the account they came from — see lib/token-balance.ts. Lets a
  // poll whose getAccountInfo call throws (rate limit, transport hiccup) fall
  // back to the previous figure instead of asserting a confirmed zero.
  const lastLpRef = useRef<KnownBalance>(NO_BALANCE_KNOWN);
  const lastCollateralRef = useRef<KnownBalance>(NO_BALANCE_KNOWN);

  // Poll insurance state
  const refreshState = useCallback(async () => {
    if (!slabState || !lpMintInfo || !connection) {
      // Nothing to fetch yet (market/programId not resolved) — don't leave
      // the UI stuck on a loading skeleton forever. While the slab itself is
      // still loading, though, programId is just not known yet: stay loading,
      // or the zero defaults read as "this market has no Earn vault".
      if (!slabState?.loading) {
        setLoading(false);
        // The slab read itself failed on the network (SlabProvider keeps polling):
        // unknown, not "no vault". A permanent error (not found, bad address) is not.
        setReadError(!!slabState?.error?.startsWith("RPC error"));
      }
      return;
    }
    const requestId = ++requestIdRef.current;
    const stale = () => requestId !== requestIdRef.current;

    try {
      // Check if LP mint exists on-chain first — needed to sanitize insuranceBalance
      const mintInfo = await connection.getAccountInfo(lpMintInfo.mintPda);
      if (stale()) return;
      const mintExists = mintInfo != null && mintInfo.data != null && mintInfo.data.length > 0;

      // Get insurance balance from engine state.
      // Guard: Solana uninitialised u64 fields read as u64::MAX (2^64-1).
      // Only trust the value when the LP mint is live; otherwise clamp to 0.
      const U64_MAX = 18_446_744_073_709_551_615n;
      const rawBalance = slabState.engine?.insuranceFund?.balance ?? 0n;
      const insuranceBalance =
        mintExists && rawBalance <= U64_MAX / 2n ? rawBalance : 0n;

      let lpSupply = 0n;
      let lpDecimals = 6;
      // #2545: default is "no wallet / no LP mint" — genuine evidence of
      // zero. A read that actually FAILS overwrites this to `{ ok: false }`
      // below; see lib/token-balance.ts for why that distinction matters.
      let lpRead: TokenRead = { ok: true, absent: true };

      if (mintExists) {
        // Read supply and decimals from LP mint
        // IMPORTANT: LP tokens have their own decimals — do NOT use collateral decimals here.
        const mint = unpackMint(lpMintInfo.mintPda, mintInfo);
        lpSupply = mint.supply;
        lpDecimals = mint.decimals;

        // Get user's LP token balance — use stabilized string to avoid re-render loops
        if (walletPubkeyStr) {
          try {
            const walletPk = new PublicKey(walletPubkeyStr);
            const userLpAta = await getAssociatedTokenAddress(
              lpMintInfo.mintPda,
              walletPk
            );
            const ataInfo = await connection.getAccountInfo(userLpAta);
            if (stale()) return;
            lpRead = ataInfo
              ? { ok: true, amount: unpackAccount(userLpAta, ataInfo).amount }
              : { ok: true, absent: true }; // no ATA — the user genuinely holds none
          } catch {
            // The read itself failed (rate limit, transport hiccup, …) — that
            // is NOT evidence of zero. Carry the last-known balance forward
            // instead of flashing "0" (#2545).
            lpRead = { ok: false };
          }
        }
      }

      const knownLp = resolveTokenBalance(
        lastLpRef.current,
        balanceKey(walletPubkeyStr, lpMintInfo.mintPda.toBase58()),
        lpRead,
      );
      const userLpBalance = knownLp.amount;

      // Calculate derived values
      const redemptionRateE6 = lpSupply > 0n
        ? (insuranceBalance * 1_000_000n) / lpSupply
        : 1_000_000n; // 1:1 if no supply

      const userRedeemableValue = lpSupply > 0n
        ? (userLpBalance * insuranceBalance) / lpSupply
        : 0n;

      // User's collateral ATA balance (available to deposit into the LP vault).
      // #2545: no wallet is genuine evidence of zero. A connected wallet whose
      // `slabState.config` hasn't resolved yet is NOT — refreshState only
      // gates on lpMintInfo/connection above, so it can run before `config`
      // is set, and treating that as a confirmed zero would wipe a good
      // balance for the same reason a failed read would.
      let collateralRead: TokenRead = walletPubkeyStr
        ? { ok: false }
        : { ok: true, absent: true };
      if (walletPubkeyStr && slabState.config) {
        try {
          const walletPk = new PublicKey(walletPubkeyStr);
          const collateralAta = await getAssociatedTokenAddress(
            slabState.config.collateralMint,
            walletPk,
          );
          const collateralAtaInfo = await connection.getAccountInfo(collateralAta);
          if (stale()) return;
          collateralRead = collateralAtaInfo
            ? { ok: true, amount: unpackAccount(collateralAta, collateralAtaInfo).amount }
            : { ok: true, absent: true }; // no ATA — the user genuinely holds none
        } catch {
          // The read itself failed — not evidence of zero. See #2545.
          collateralRead = { ok: false };
        }
      }
      const knownCollateral = resolveTokenBalance(
        lastCollateralRef.current,
        balanceKey(walletPubkeyStr, slabState.config?.collateralMint.toBase58()),
        collateralRead,
      );
      const userCollateralBalance = knownCollateral.amount;
      // NOTE: the refs below are updated only where this run's result is
      // actually PUBLISHED (past the final `stale()` guard). A superseded
      // run must never write the cache — it would leave a value cached that
      // no rendered state ever matched, quietly disabling the carry-forward
      // for whichever run does end up publishing.

      // ─── LP Vault Registry (v17 "Earn" vault) ───────────────────────────────
      // Separate on-chain account from the engine insuranceFund read above.
      // Wrapped in its own try/catch so a failure here (registry not yet
      // created, RPC hiccup, or an SDK without this export) never blocks the
      // insuranceBalance/lpSupply/userLpBalance state already computed above.
      let registryExists = false;
      let lpVaultDomain = 0;
      let registryAddress: PublicKey | null = null;
      let vaultTotalAtoms = 0n;
      let vaultSharePriceE6 = 1_000_000n;
      let userVaultValueAtoms = 0n;
      let redemptionCooldownSlots = 0n;
      let hasPendingRedemption = false;
      let pendingRedemptionShares = 0n;
      let cooldownRemainingSlots = 0n;
      let cooldownElapsed = true;
      // A failed READ is not a missing registry: rethrown below so the outer catch
      // keeps the last good state, instead of publishing "no vault, $0".
      let registryReadFailed = false;
      const readAccount = (pk: PublicKey) =>
        connection.getAccountInfo(pk).catch((e: unknown) => {
          registryReadFailed = true;
          throw e;
        });

      try {
        if (registryInfo) {
          registryAddress = registryInfo.registryPda;
          const registryAcctInfo = await readAccount(registryInfo.registryPda);
          if (stale()) return;
          if (registryAcctInfo && registryAcctInfo.data.length > 0) {
            const registry = parseLpVaultRegistry(new Uint8Array(registryAcctInfo.data));
            registryExists = true;
            lpVaultDomain = Number(registry.domain);
            redemptionCooldownSlots = sanitizeOnChainValue(registry.redemptionCooldownSlots);

            // Total backing = shares outstanding (minted 1:1 with deposited atoms)
            // + cumulative fee atoms distributed into the vault since launch.
            const shares = sanitizeOnChainValue(registry.totalLpSharesOutstanding);
            const feeAtoms = sanitizeOnChainValue(registry.feeDistributionTotalAtoms);
            vaultTotalAtoms = shares + feeAtoms;

            // Use the freshly-read LP mint supply (lpSupply above) as the share-count
            // denominator — it's read from the same mint as userLpBalance, so the two
            // stay consistent with each other.
            vaultSharePriceE6 = lpSupply > 0n
              ? (vaultTotalAtoms * 1_000_000n) / lpSupply
              : 1_000_000n;
            // Pending redemption ticket (RequestRedeemLpShares → cooldown → ExecuteRedemption).
            if (registryInfo.redemptionPda) {
              const redemptionAcctInfo = await readAccount(registryInfo.redemptionPda);
              if (stale()) return;
              if (redemptionAcctInfo && redemptionAcctInfo.data.length > 0) {
                const redemption = parseLpRedemption(new Uint8Array(redemptionAcctInfo.data));
                hasPendingRedemption = true;
                pendingRedemptionShares = sanitizeOnChainValue(redemption.shares);
                const requestSlot = sanitizeOnChainValue(redemption.requestSlot);
                if (redemptionCooldownSlots > 0n) {
                  try {
                    const currentSlot = BigInt(await connection.getSlot());
                    if (stale()) return;
                    const unlockSlot = requestSlot + redemptionCooldownSlots;
                    if (currentSlot < unlockSlot) {
                      cooldownElapsed = false;
                      cooldownRemainingSlots = unlockSlot - currentSlot;
                    }
                  } catch {
                    cooldownElapsed = false; // conservative: can't verify, block withdrawal
                  }
                }
              }
            }
          }
        }
      } catch (registryErr) {
        if (registryReadFailed) throw registryErr;
        // Registry malformed (or an SDK without this export) — leave the safe
        // defaults above (0 / not-pending) rather than showing garbage.
        console.error('Failed to refresh LP vault registry state:', registryErr);
      }

      // The user's whole position: wallet shares plus shares escrowed by a pending withdrawal
      // (still theirs until it pays out). Counting only the wallet showed 0% / $0 for the whole
      // cooldown. The two-pot branch below prices the same `held` on its own NAV.
      const heldShares = userLpBalance + pendingRedemptionShares;
      const userSharePct = lpSupply > 0n ? Number((heldShares * 10000n) / lpSupply) / 100 : 0;
      if (registryExists && lpSupply > 0n) userVaultValueAtoms = (heldShares * vaultTotalAtoms) / lpSupply;

      // Non-bound (two-pot) vault: value positions at the program's combined NAV over the
      // registry's shares (what 77 pays), count the escrowed pending shares as the user's, and
      // work out what the whole position can be paid right now (Custom 21 / 25 before signing).
      let splitPot: InsuranceLPState['splitPot'] = null;
      let backingNavAtoms: bigint | null = null;
      if (registryExists && programId && slabAddress) {
        const vp = await readVaultPotState(connection, new PublicKey(programId), new PublicKey(slabAddress));
        if (stale()) return;
        // M-9: a BOUND (P3) vault is priced on `bound_vault_nav` (per pot min(principal, held) +
        // LP earnings), not shares + distributed fees. Its per-share pricing stays with the P3
        // tranche model (earnPanelPricing), which takes this as its backing NAV.
        if (vp?.bound) backingNavAtoms = vaultBackingNav(vp);
        // Non-bound: priced as the program will see it once the app's own repair (an underwater
        // pot, #2853) lands.
        const rawSp: SplitPotState | null = vp && !vp.bound ? vp : null;
        const sp = rawSp ? repairUnderwaterPot(rawSp)?.state ?? null : null;
        // Wrapper 7a3ac04c+ (navFloor): an over-impaired pot is worth 0 instead of unpriceable.
        const v = sp ? combinedVault(sp.own, sp.sib, sp.feeShareBps, sp.navFloor === true) : null;
        if (sp && v && sp.totalShares > 0n) {
          const held = heldShares;
          vaultTotalAtoms = v.nav;
          vaultSharePriceE6 = (v.nav * 1_000_000n) / sp.totalShares;
          userVaultValueAtoms = (held * v.nav) / sp.totalShares;
          let maxNowAtoms: bigint | null = null;
          if (held > 0n) {
            const plan = planSplitPotRedemption({ own: sp.own, sib: sp.sib, totalShares: sp.totalShares, shares: held, feeShareBps: sp.feeShareBps, navFloor: sp.navFloor });
            if (plan && !plan.payable) maxNowAtoms = (cappedShares(plan.maxShares, held) * v.nav) / sp.totalShares;
          }
          // Extra information: a failure here must never blank the vault's own state.
          let w: ReturnType<typeof vaultWithdrawView> = null;
          try {
            w = vaultWithdrawView(sp);
          } catch {
            w = null;
          }
          splitPot = {
            totalShares: sp.totalShares,
            navAtoms: v.nav,
            maxNowAtoms,
            claimAdjustedNavAtoms: w ? w.claimAdjustedNav : null,
            vaultMaxNowAtoms: w ? w.maxWithdrawableNow : null,
            withdrawStatus: w ? w.status : null,
            blockedBy: w ? w.blockedBy : null,
          };
        }
      }

      if (stale()) return;
      // This run's result is the one being published — it's also the one the
      // carry-forward cache should hold from now on.
      lastLpRef.current = knownLp;
      lastCollateralRef.current = knownCollateral;
      setState({
        insuranceBalance,
        lpSupply,
        userLpBalance,
        redemptionRateE6,
        userSharePct,
        userRedeemableValue,
        mintExists,
        lpMintAddress: mintExists ? lpMintInfo.mintPda : null,
        lpDecimals,
        registryExists,
        registryAddress,
        lpVaultDomain,
        userCollateralBalance,
        vaultTotalAtoms,
        backingNavAtoms: backingNavAtoms ?? vaultTotalAtoms,
        vaultSharePriceE6,
        userVaultValueAtoms,
        redemptionCooldownSlots,
        hasPendingRedemption,
        pendingRedemptionShares,
        cooldownRemainingSlots,
        cooldownElapsed,
        splitPot,
      });
      setReadError(false);
    } catch (err) {
      console.error('Failed to refresh insurance LP state:', err);
      if (!stale()) setReadError(true);
    } finally {
      // Covers every path through the try block above — success, each
      // `if (stale()) return;` bail-out, and the catch branch — so loading
      // never gets stuck true after this call settles. Guarded by `stale()`:
      // without it, a SUPERSEDED call's finally (e.g. the previous market's
      // slow in-flight refresh, still resolving after a market switch) could
      // clear `loading` right after the market-switch effect below just set
      // it true for the NEW market, making the UI briefly show the new
      // market's zeroed state as if it were already loaded.
      if (!stale()) setLoading(false);
    }
  }, [slabState, lpMintInfo, registryInfo, connection, walletPubkeyStr, programId, slabAddress]);

  // H3: Auto-refresh every 10s — use ref to avoid stale closure
  const refreshStateRef = useRef(refreshState);
  useEffect(() => {
    refreshStateRef.current = refreshState;
  }, [refreshState]);

  // S-H1 fix: refresh immediately whenever the derived PDAs, wallet, or slab
  // config change (wallet connect/switch, market switch) — previously this
  // only ran once on mount via the interval effect below, so a post-mount
  // wallet connect/switch left the UI showing the PREVIOUS wallet's LP
  // balance / pending-redemption state for up to the full 10s interval
  // period. Mirrors the equivalent fix in useStakePool.ts.
  useEffect(() => {
    // Re-arm loading on market/wallet switch: without this, switching markets
    // (or connecting/switching wallets) kept showing the PREVIOUS market's
    // numbers as if they were the freshly-loaded state for the new one, since
    // `loading` had already flipped false from the prior fetch.
    // Keyed on `collateralMintStr` (see its declaration above), NOT
    // `slabState.config` — the object identity changes every slab poll.
    setLoading(true);
    refreshStateRef.current();
    // slabLoading: a slab that finishes loading without a programId changes no PDA
    // above, so re-run here to clear the loading state refreshState held for it.
  }, [lpMintInfo, registryInfo, walletPubkeyStr, collateralMintStr, slabLoading]);

  useEffect(() => {
    // Set up the 10s auto-refresh interval. The initial call now happens via
    // the immediate-refresh effect above (which also re-fires on mount).
    // Visibility-gated: a backgrounded tab shouldn't keep hitting the
    // rate-limited devnet RPC every 10s for an Earn panel nobody is looking
    // at. Fires immediately on tab re-focus (catch-up refresh).
    return pollWhenVisible(() => refreshStateRef.current(), 10_000);
  }, []);

  // v17 LP Vault operations via the wrapper program.
  // CreateLpVault (tag 74), DepositToLpVault (tag 75),
  // RequestRedeemLpShares (tag 76), ExecuteRedemption (tag 77).

  /**
   * CreateLpVault (tag 74) — creates the LP vault registry PDA and LP mint.
   * Must be called by the market admin (marketauth) before any deposits.
   *
   * Account list (ACCOUNTS_CREATE_LP_VAULT):
   *   [0] admin (signer, writable)
   *   [1] market (readonly)
   *   [2] registry (writable, PDA: ["lp_vault_registry", market])
   *   [3] lpMint (writable, PDA: ["lp_vault_mint", market])
   *   [4] systemProgram
   *   [5] tokenProgram
   */
  const createMint = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      throw new Error('Wallet not connected');
    }
    if (!slabAddress || !programId) {
      throw new Error('Market not loaded');
    }
    assertKnownProgram(new PublicKey(programId));

    setLoading(true);
    setError(null);
    try {
      const marketPk = new PublicKey(slabAddress);
      const progPk = new PublicKey(programId);
      const [registryPda] = deriveLpVaultRegistry(progPk, marketPk);
      const [lpMintPda] = deriveInsuranceLpMint(progPk, marketPk);

      const keys = buildAccountMetas(ACCOUNTS_CREATE_LP_VAULT, [
        wallet.publicKey,
        marketPk,
        registryPda,
        lpMintPda,
        WELL_KNOWN.systemProgram,
        WELL_KNOWN.tokenProgram,
      ]);
      const data = encodeCreateLpVaultV17({
        feeShareBps: 2000,          // 20% of insurance earnings to LP providers
        oiReservationThresholdBps: 5000, // 50% OI reservation threshold
        redemptionCooldownSlots: 86400n, // ~1 day in slots (~2 days on devnet ~400ms/slot)
        domain: 0,                  // Primary insurance domain
      });
      const ix = buildIx({ programId: progPk, keys, data });
      await sendTx({ connection, wallet, instructions: [ix] });
      await refreshState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, connection, slabAddress, programId, refreshState]);

  /**
   * DepositToLpVault (tag 75) — deposit collateral to receive LP shares.
   *
   * Account list (ACCOUNTS_LP_VAULT_DEPOSIT):
   *   [0] depositor (signer, writable)
   *   [1] market (writable)
   *   [2] registry (writable)
   *   [3] lpMint (writable)
   *   [4] depositorLpAta (writable)
   *   [5] sourceToken (writable)
   *   [6] vaultToken (writable)
   *   [7] ledger (writable, PDA: ["lp_backing_ledger", market, domain_le])
   *   [8] tokenProgram
   *   [9] systemProgram
   *   [10] siblingLedger (writable, the OTHER pot of this asset)
   *
   * v17 DUAL-DOMAIN: the vault serves both pots of its asset and NAV is summed
   * across the two, so [10] is required even when that ledger does not exist yet
   * — omitting it understates NAV and mints the depositor free shares at
   * existing holders' expense. The `domain` argument picks which pot actually
   * receives the backing; we send it to the vault's own pot.
   */
  const deposit = useCallback(async (amount: bigint) => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      throw new Error('Wallet not connected');
    }
    if (!slabAddress || !programId || !slabState.config) {
      throw new Error('Market not loaded');
    }
    assertKnownProgram(new PublicKey(programId));
    assertV1AllowsNewFunds(programId.toString(), "earn-deposit");

    setLoading(true);
    setError(null);
    try {
      const marketPk = new PublicKey(slabAddress);
      const progPk = new PublicKey(programId);
      const [vaultPda] = deriveVaultAuthority(progPk, marketPk);
      const [registryPda] = deriveLpVaultRegistry(progPk, marketPk);
      const [lpMintPda] = deriveInsuranceLpMint(progPk, marketPk);
      // The vault's own pot, read from the registry — NOT assumed to be 0.
      const domain = state.lpVaultDomain;
      const [ledgerPda] = deriveLpBackingLedger(progPk, marketPk, domain);
      const [siblingLedgerPda] = deriveLpBackingLedger(progPk, marketPk, domain ^ 1);

      // Guard: the LP vault mint must exist (and be SPL-Token-owned) before we
      // build the depositor's LP ATA. On a market with no Earn vault — the 6
      // built-in markets by design, or a user market whose step-5 vault creation
      // failed — the mint account is absent, and
      // createAssociatedTokenAccountInstruction(lpMintPda) fails deep in the ATA
      // program with a cryptic `IncorrectProgramId` (the "mint" isn't owned by
      // the token program). Surface an accurate reason instead.
      const lpMintInfo = await connection.getAccountInfo(lpMintPda);
      if (!lpMintInfo) {
        throw new Error(
          "This market's Earn vault isn't initialized on-chain — LP deposits aren't available here.",
        );
      }

      const collateralMint = slabState.config.collateralMint;
      const vaultTokenAta = await getAssociatedTokenAddress(collateralMint, vaultPda, true);
      const sourceTokenAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);
      // Never build an LP-vault deposit above the wallet's collateral balance.
      assertDepositWithinBalance(amount, await readTokenBalance(connection, sourceTokenAta));
      const depositorLpAta = await getAssociatedTokenAddress(lpMintPda, wallet.publicKey);

      // Around the upgrade cutover a pre-sign 91 / 25 means this tx was built for the other wrapper
      // version: re-detect and rebuild once (lib/limits/earn-ixs.ts sendWithUpgradeRetry).
      const depositor = wallet.publicKey;
      const attemptDeposit = async (): Promise<string> => {
        const ixs = [];
        // Create depositor LP ATA if it doesn't exist.
        // BUG FIX (devnet flow-test 2026-07-01): connection.getAccountInfo() resolves to `null`
        // for a missing account — it does NOT throw. The previous try/catch here never entered
        // its catch branch, so the create-ATA instruction was never added, and DepositToLpVault
        // failed on-chain with Custom(11) InvalidTokenAccount for any depositor whose LP-token
        // ATA didn't already exist (i.e. every first-time depositor into a given LP vault).
        const depositorLpAtaInfo = await connection.getAccountInfo(depositorLpAta);
        if (!depositorLpAtaInfo) {
          ixs.push(createAssociatedTokenAccountInstruction(
            depositor, depositorLpAta, depositor, lpMintPda,
          ));
        }

        // P3 (vault-owned LP): a BOUND vault requires [11] vault_lp_state + [12] vault LP, and a
        // genesis deposit with harvestable LP fees needs tag 78 first (P3-L1). Assembly is shared
        // with the LiteSVM bridge (lib/limits/earn-ixs.ts), so the sim runs this exact code.
        const p3 = earnTxPlan(TAG_DEPOSIT_TO_LP_VAULT, await readEarnP3Context(connection, progPk, marketPk));
        assertEarnPlan(p3);
        // Non-bound vault. Live wrapper: an underwater pot makes every deposit fail Custom 25 until the
        // permissionless repair (91) lands, so it rides in front of the user's own deposit. Upgraded
        // wrapper (sp.navFloor): no repair, ever (it would move Earn holders' money into the impaired
        // pot, security review B-2) - `splitPotPrefixIxs` returns nothing then.
        const sp = p3.tail ? null : await readSplitPotState(connection, progPk, marketPk);
        // Never send a deposit the vault should not take: a pot over-impaired (H-1 / Custom 25) or a
        // collapsed share price (B-1). Otherwise route to the pot whose principal covers its
        // impairment. `ledger` / `siblingLedger` stay pinned; only the `domain` argument picks the pot.
        // Fail CLOSED: a non-bound vault whose pot state cannot be read (RPC error -> null) is not
        // deposited into blind - pre-upgrade the program has no collapse guard of its own.
        if (!p3.tail && !sp) throw new EarnDepositsPausedError("unpriceable");
        let targetDomain = domain;
        if (sp) {
          const plan = planEarnDeposit(sp, domain);
          if (!plan.ok) throw new EarnDepositsPausedError(plan.reason);
          targetDomain = plan.domain;
          ixs.push(...splitPotPrefixIxs({
            programId: progPk, cranker: depositor, market: marketPk, registry: registryPda, sp,
          }));
        }
        ixs.push(...buildEarnDepositIxs({
          programId: progPk,
          depositor,
          market: marketPk,
          registry: registryPda,
          lpMint: lpMintPda,
          depositorLpAta,
          sourceToken: sourceTokenAta,
          vaultToken: vaultTokenAta,
          ledger: ledgerPda,
          siblingLedger: siblingLedgerPda,
          domain: targetDomain,
          amount,
          plan: p3,
        }));
        return sendTx({ connection, wallet, instructions: ixs, selfHeal: { programId: progPk, market: marketPk }, vaultLpRepair: earnRepairFor(progPk, marketPk) });
      };
      const sig = await sendWithUpgradeRetry(attemptDeposit, isEarnVersionRefusal);
      void readTxDrawSummary(connection, sig).then(setLastDrawSummary);
      await refreshState();
      return sig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, connection, slabAddress, programId, slabState, state.lpVaultDomain, refreshState, earnRepairFor]);

  /**
   * RequestRedeemLpShares (tag 76) — begin LP share redemption (starts cooldown).
   * Then call withdraw() which calls ExecuteRedemption (tag 77) after cooldown.
   *
   * For simplicity the UI may call withdraw() which runs both steps in sequence
   * if the redemption is past cooldown, or just RequestRedeem if not yet requested.
   *
   * S2 fix: returns which step actually ran + the tx signature. Previously the
   * caller had no way to distinguish "redemption REQUESTED (cooldown just
   * started, no funds moved yet)" from "redemption EXECUTED (funds sent)" —
   * the UI showed a blanket "Withdrawal successful!" even when step 1 only
   * requested the redemption, misleading users into thinking their funds had
   * already been returned.
   */
  const withdraw = useCallback(async (lpAmount: bigint): Promise<WithdrawResult> => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      throw new Error('Wallet not connected');
    }
    if (!slabAddress || !programId || !slabState.config) {
      throw new Error('Market not loaded');
    }
    assertKnownProgram(new PublicKey(programId));

    setLoading(true);
    setError(null);
    try {
      const marketPk = new PublicKey(slabAddress);
      const progPk = new PublicKey(programId);
      const [registryPda] = deriveLpVaultRegistry(progPk, marketPk);
      const [redemptionPda] = deriveLpRedemption(progPk, registryPda, wallet.publicKey);
      const [lpMintPda] = deriveInsuranceLpMint(progPk, marketPk);
      const [escrowPda] = deriveLpEscrow(progPk, marketPk);

      let step: RedemptionStep;
      let signature: string;

      // RequestRedeemLpShares (tag 76).
      // BUG FIX (devnet flow-test 2026-07-01): this account list was missing lpMint,
      // redeemerLpAta and the per-vault LP escrow PDA — and wrongly included `market`,
      // which handle_request_redeem_lp_shares never reads — causing on-chain
      // NotEnoughAccountKeys. Real account list per percolator-prog
      // src/v16_program.rs handle_request_redeem_lp_shares (L12016-12028):
      //   [redeemer(signer,w), registry(w), lpMint, redeemerLpAta(w), escrow(w),
      //    redemption(w), tokenProgram, systemProgram]
      const buildRequestIx = async () =>
        buildRequestRedeemIx({
          programId: progPk, redeemer: wallet.publicKey!, registry: registryPda, lpMint: lpMintPda,
          redeemerLpAta: await getAssociatedTokenAddress(lpMintPda, wallet.publicKey!), escrow: escrowPda,
          redemption: redemptionPda, shares: lpAmount,
        });
      // ExecuteRedemption (tag 77) — collect collateral after cooldown.
      // BUG FIX (devnet flow-test 2026-07-01): this account list was missing the LP
      // escrow PDA and the per-domain backing ledger PDA, and had the remaining
      // accounts in the wrong order — causing on-chain NotEnoughAccountKeys. Real
      // account list per percolator-prog src/v16_program.rs handle_execute_redemption
      // (L12153-12163): [cranker(signer,w), market(w), registry(w), redemption(w),
      // lpMint(w), escrow(w), vaultToken(w), vaultAuthority, ledger(w), redeemerDest(w),
      // tokenProgram, siblingLedger(w), redeemerRentDest(w)]. `cranker` is permissionless (anyone may execute post-cooldown,
      // and is directly credited the redemption PDA's reclaimed rent) — the UI always
      // calls it as the redeemer themselves.
      // Non-bound (two-pot) vault: 77 pays across both pots by itself (wrapper 553d76f0), so it is
      // sent alone. In front of it only the underwater-pot repair (91, lib/limits/earn-split-pot.ts),
      // and a refusal before signing when the vault cannot pay `shares` now (the UI offers the max).
      const splitPotPrefix = async (shares: bigint): Promise<TransactionInstruction[]> =>
        splitPotPrefixIxs({
          programId: progPk, cranker: wallet.publicKey!, market: marketPk, registry: registryPda,
          sp: await readSplitPotState(connection, progPk, marketPk), payoutShares: shares,
        });
      const buildExecuteIxs = async (forceHarvest = false, shares: bigint | null = null) => {
        const [vaultPda] = deriveVaultAuthority(progPk, marketPk);
        // v17 DUAL-DOMAIN: [11] is the sibling pot's ledger. NAV and
        // available-principal are summed across both pots, so it is required
        // even when uninitialised, or the redeemer is underpaid by whatever sits
        // in the sibling. The `domain` argument says which pot the payout is
        // DRAWN from — the vault's own. (221cf006: on a BOUND vault both pot ledgers are
        // writable — buildEarnExecuteIxs; a senior larger than one pot redeems across both.)
        const domain = state.lpVaultDomain;
        const [ledgerPda] = deriveLpBackingLedger(progPk, marketPk, domain);
        const [siblingLedgerPda] = deriveLpBackingLedger(progPk, marketPk, domain ^ 1);
        const collateralMint = slabState.config!.collateralMint;
        const vaultTokenAta = await getAssociatedTokenAddress(collateralMint, vaultPda, true);
        const redeemerAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey!);
        // P3 (vault-owned LP): a BOUND vault requires [13] vault_lp_state + [14] vault LP, and
        // refuses 84 while LP fees are harvestable - bundle tag 78 in front (P3-K1).
        // [12] redeemerRentDest (#461 / GH#412, live in v18.2): the consumed redemption PDA's
        // rent is returned to the RECORDED redeemer - the UI only claims its own redemption.
        const p3Ctx = await readEarnP3Context(connection, progPk, marketPk);
        const p3 = withForcedHarvest(earnTxPlan(TAG_EXECUTE_REDEMPTION, p3Ctx), forceHarvest);
        assertEarnPlan(p3);
        const prefix = shares !== null && !p3.tail ? await splitPotPrefix(shares) : [];
        const executeIxs = [...prefix, ...buildEarnExecuteIxs({
          programId: progPk,
          redeemer: wallet.publicKey!,
          market: marketPk,
          registry: registryPda,
          redemption: redemptionPda,
          lpMint: lpMintPda,
          escrow: escrowPda,
          vaultToken: vaultTokenAta,
          vaultAuthority: vaultPda,
          ledger: ledgerPda,
          redeemerDest: redeemerAta,
          siblingLedger: siblingLedgerPda,
          domain,
          plan: p3,
        })];
        // Devnet v2.1, R3-M1: a Live NON-BOUND exit carries cranks of the market's positioned
        // portfolios in front, so nobody can time the payout against an untouched loser. Flag-gated,
        // sim-gated (kept only if the whole tx still simulates clean); see lib/v21/exit-cranks.ts.
        exitCranksRef.current = 0;
        if (isDevnetV21Enabled() && !p3.tail && p3Ctx.mode === MARKET_MODE_LIVE) {
          const cranks = await planExitCranks(
            {
              read: () => readOpenPortfolios(connection, progPk, marketPk),
              simulate: (ixs) => simulateForGate(connection, wallet.publicKey!, ixs),
            },
            {
              programId: progPk,
              cranker: wallet.publicKey!,
              market: marketPk,
              core: executeIxs,
              oracleTail: crankOracleTail(pythCrankAccount(slabState.config, slabState.wrapperConfigV17?.oracleMode)),
            },
          );
          exitCranksRef.current = cranks.length;
          return [...cranks, ...executeIxs];
        }
        return executeIxs;
      };
      // P3 ordering: a resolved close that ran before the vault LP settled left the viewer a
      // PARTIAL payout receipt. Once 101 has closed, its tag-46 top-up rides in front of this tx
      // (sim-gated; dropped if it would refuse, so the withdrawal itself never pays for it).
      const viewerTopup = await readViewerTopupIxs({
        connection,
        programId: progPk,
        market: marketPk,
        collateralMint: slabState.config.collateralMint,
        viewer: wallet.publicKey,
        simulate: async (ixs) =>
          (await connectionSelfHealDeps(connection, marketPk, wallet.publicKey!).simulate([...computeBudgetPrefix(TOPUP_SIM_CU), ...ixs])).err ?? null,
      });
      // Resolved bound market: a senior 77 is refused 21 while any EMPTY portfolio is still
      // materialized; the permissionless tag-8 closes ride in front (sim-gated), so the payout
      // never waits on the keeper.
      const emptyCloses = await readEmptyCloseIxs({
        connection,
        programId: progPk,
        market: marketPk,
        collateralMint: slabState.config.collateralMint,
        payer: wallet.publicKey,
        simulate: async (ixs) =>
          (await connectionSelfHealDeps(connection, marketPk, wallet.publicKey!).simulate([...computeBudgetPrefix(TOPUP_SIM_CU), ...ixs])).err ?? null,
      });
      const topup = [...emptyCloses, ...viewerTopup];
      const send = (instructions: TransactionInstruction[]) =>
        sendWithTopup({
          topup,
          base: instructions,
          isPreSignRefusal: (e) => e instanceof SimulationRefusal,
          // The closes are optional; sendTx's self-heal / vault-LP repair may add instructions.
          packet: { feePayer: wallet.publicKey!, droppable: emptyCloses.length, reserveBytes: SELF_HEAL_RESERVE_BYTES },
          send: (ixs, bundled) =>
            sendTx({
              connection,
              wallet,
              instructions: ixs,
              selfHeal: { programId: progPk, market: marketPk },
              vaultLpRepair: earnRepairFor(progPk, marketPk),
              ...(bundled ? { computeUnitsFromSim: { cap: TOPUP_BUNDLE_CU_CAP } } : {}),
              ...(exitCranksRef.current > 0 ? { computeUnitsFromSim: { cap: EXIT_CRANK_CU_CAP } } : {}),
            }),
        });

      // Check if a redemption request already exists
      const redemptionInfo = await connection.getAccountInfo(redemptionPda);
      if (redemptionInfo) {
        // Step 2 of 2: the payout. sendTx pre-simulates it and bundles the repairs (78 harvest,
        // 85/87 crank, 88 recall / other pot) before the wallet opens.
        // 5544302a: a Resolved terminal-flat 77 can need 78 first (stray pot backing); a pre-sign 84
        // rebuilds the same payout with 78 in front (lib/limits/earn-ixs.ts sendWithHarvestOn84).
        const pendingShares = parseLpRedemption(new Uint8Array(redemptionInfo.data)).shares;
        // A pre-sign 91 / 25 around the upgrade cutover = built for the other wrapper version (the
        // 91 repair prefix present / absent): re-detect and rebuild once.
        signature = await sendWithUpgradeRetry(
          () => sendWithHarvestOn84({ build: (force) => buildExecuteIxs(force, BigInt(pendingShares)), send, isHarvestPendingRefusal }),
          isEarnVersionRefusal,
        );
        step = 'executed';
        void readTxDrawSummary(connection, signature).then(setLastDrawSummary);
      } else if (state.registryExists && withdrawFlow(state.redemptionCooldownSlots) === 'one-tx') {
        // UX WP-4: only a vault whose cooldown is 0 requests AND pays out in one tx.
        signature = await sendWithUpgradeRetry(
          () =>
            sendWithHarvestOn84({
              build: async (force) => [await buildRequestIx(), ...(await buildExecuteIxs(force, lpAmount))],
              send,
              isHarvestPendingRefusal,
            }),
          isEarnVersionRefusal,
        );
        step = 'executed';
        void readTxDrawSummary(connection, signature).then(setLastDrawSummary);
      } else {
        // Step 1 of 2: the request. The cooldown protects the seniors who stay; the page counts
        // it down and opens the payout by itself (components/earn/EarnPendingWithdrawal).
        // Never request what the vault cannot pay (the payout would only fail after the cooldown).
        await splitPotPrefix(lpAmount);
        signature = await send([await buildRequestIx()]);
        step = 'requested';
      }
      await refreshState();
      return { step, signature };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, connection, slabAddress, programId, slabState, state.lpVaultDomain, state.redemptionCooldownSlots, state.registryExists, refreshState, earnRepairFor]);

  /**
   * A pending redemption the vault cannot pay in full right now (EarnPayoutCapError): cancel it
   * (81) and re-request `shares` (76) under ONE wallet approval. They are two transactions: 76
   * re-creates the redemption account 81 closes, which the program refuses inside the same
   * transaction (Custom 2 AlreadyInitialized, devnet simulation 2026-10-01). 81 is simulated
   * before the prompt, both are signed with one signAll on one blockhash, 81 is confirmed, then
   * 76 is sent. The cooldown restarts; the pending card then collects the payout by itself.
   * If 76 fails after 81 landed, the shares are back in the wallet: nothing is lost, and the
   * withdraw form offers the max available.
   */
  const resizeRedemption = useCallback(async (shares: bigint): Promise<string> => {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error('Wallet not connected');
    if (!slabAddress || !programId) throw new Error('Market not loaded');
    if (shares <= 0n) throw new Error('Nothing to withdraw');
    assertKnownProgram(new PublicKey(programId));
    setLoading(true);
    setError(null);
    try {
      const payer = wallet.publicKey;
      const marketPk = new PublicKey(slabAddress);
      const progPk = new PublicKey(programId);
      const [registryPda] = deriveLpVaultRegistry(progPk, marketPk);
      const [redemptionPda] = deriveLpRedemption(progPk, registryPda, payer);
      const [lpMintPda] = deriveInsuranceLpMint(progPk, marketPk);
      const [escrowPda] = deriveLpEscrow(progPk, marketPk);
      const lpAta = await getAssociatedTokenAddress(lpMintPda, payer);
      const cancel = buildCancelRedemptionIx({ programId: progPk, redeemer: payer, registry: registryPda, redemption: redemptionPda, lpMint: lpMintPda, redeemerLpAta: lpAta, escrow: escrowPda });
      const request = buildRequestRedeemIx({ programId: progPk, redeemer: payer, registry: registryPda, lpMint: lpMintPda, redeemerLpAta: lpAta, escrow: escrowPda, redemption: redemptionPda, shares });
      const gate = await simulateForGate(connection, payer, [cancel]);
      if (gate.err) throw gate.err instanceof Error ? gate.err : new Error(typeof gate.err === 'string' ? gate.err : JSON.stringify(gate.err));
      const [blockhash, fee] = await Promise.all([getFreshBlockhash(connection, true), getPriorityFee(connection)]);
      const txs = [
        buildBatchTx({ instructions: [cancel], computeUnits: sizeComputeUnitLimit(gate.consumed, { cap: RESIZE_CU_CAP }), priorityFeeMicroLamports: fee, blockhash, feePayer: payer }),
        buildBatchTx({ instructions: [request], computeUnits: RESIZE_CU_CAP, priorityFeeMicroLamports: fee + 1, blockhash, feePayer: payer }),
      ];
      const [signedCancel, signedRequest] = await signAllCompat(wallet, txs);
      if (!signedCancel || !signedRequest) throw new Error('the wallet returned fewer signed transactions');
      await broadcastSignedTx(connection, signedCancel);
      const sig = await broadcastSignedTx(connection, signedRequest);
      await refreshState();
      return sig;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshState().catch(() => {});
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, connection, slabAddress, programId, refreshState]);

  return {
    state,
    loading,
    error,
    readError,
    createMint,
    deposit,
    withdraw,
    resizeRedemption,
    refreshState,
    /** d119eebd: the senior draw booked / restored by the user's LAST Earn tx (its logs), or null. */
    lastDrawSummary,
  };
}

/** Simulation budget for the viewer's tag-46 top-up alone (budgeted like a CloseResolved payout). */
export const TOPUP_SIM_CU = 400_000;
/** CancelRedemption / RequestRedeemLpShares each simulate at ~10k CU; 120k is ample. */
export const RESIZE_CU_CAP = 120_000;
/** A bundled top-up + Earn payout is sized from its own simulation, up to this cap. */
export const TOPUP_BUNDLE_CU_CAP = 1_200_000;

/**
 * A pre-sign refusal (wallet not opened) with the wrapper's own 91 LpVaultTargetPotImpaired or 25
 * EngineCounterUnderflow on an Earn tx. Around the matcher-sync upgrade these are the symptom of a tx
 * built for the other wrapper version (a 91 repair the new wrapper refuses, or a missing repair the
 * old one needs), so `sendWithUpgradeRetry` re-detects and rebuilds once.
 */
export function isEarnVersionRefusal(e: unknown): boolean {
  return (
    e instanceof SimulationRefusal &&
    (e.code === WRAPPER_ERR.LpVaultTargetPotImpaired || e.code === WRAPPER_ERR.EngineCounterUnderflow) &&
    (e.programId === null || e.programId === resolveDevnetProgramIds().wrapper)
  );
}

/** A pre-sign refusal with 84 VaultLpHarvestPending raised by the wrapper (the wallet was not opened). */
export function isHarvestPendingRefusal(e: unknown): boolean {
  // Only the wrapper's own 84 (CPI callees reuse numbers; error-codes table: decode by the raiser).
  return e instanceof SimulationRefusal && e.code === WRAPPER_ERR.VaultLpHarvestPending && (e.programId === null || e.programId === resolveDevnetProgramIds().wrapper);
}
