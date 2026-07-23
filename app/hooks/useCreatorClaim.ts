"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import {
  encodeWithdrawInsuranceAsset,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
  parseMarketGroupV17OI,
  ACCOUNTS_WITHDRAW_INSURANCE,
  WELL_KNOWN,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { assertKnownProgram } from "@/lib/programAllowlist";
import {
  marketAssetCapacity,
  readInsuranceDomainBudget,
  readAssetInsuranceOperator,
} from "@/lib/insuranceDomainBudget";
import { mapCreatorClaimError } from "@/lib/creatorClaimError";

export interface CreatorClaimAsset {
  /** Asset (market slot) index within the market group. */
  assetIndex: number;
  /** Accrued creator-fee revenue for this asset = insurance_domain_budget long+short. */
  claimable: bigint;
}

export interface CreatorClaimData {
  /** True iff the connected wallet is the insurance_operator (or marketauth) of >=1 asset. */
  isOperator: boolean;
  /** Total claimable across every asset the connected wallet operates. */
  claimable: bigint;
  /** Per-asset breakdown for the operator's assets. */
  claimableAssets: CreatorClaimAsset[];
  /** Collateral-token decimals for human display. */
  decimals: number;
  /** True while the market-wide insurance-withdrawal cooldown blocks a claim. */
  cooldownActive: boolean;
  /** Slots remaining until the cooldown elapses (0 when inactive). */
  cooldownRemainingSlots: bigint;
}

const EMPTY: CreatorClaimData = {
  isOperator: false,
  claimable: 0n,
  claimableAssets: [],
  decimals: 6,
  cooldownActive: false,
  cooldownRemainingSlots: 0n,
};

/**
 * Creator fee-claim hook (audit gap #2).
 *
 * The market's accrued creator revenue lives in each asset's on-chain
 * `insurance_domain_budget`. The insurance_operator (defaults to the creator)
 * withdraws it with WithdrawInsuranceAsset (tag 57). This hook:
 *   1. reads the REAL per-asset budget + operator from the raw slab bytes (see
 *      lib/insuranceDomainBudget.ts — NOT from SlabProvider.assetProfile, which
 *      is parsed at the wrong offset for these deployed markets);
 *   2. gates on operator === wallet (or marketauth === wallet, both of which the
 *      on-chain handler authorizes);
 *   3. builds + sends the tag-57 tx and re-reads state so the displayed
 *      claimable drops to 0 after a successful claim.
 */
export function useCreatorClaim() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = (params?.slab as string | undefined) ?? slabState.slabAddress;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [currentSlot, setCurrentSlot] = useState<bigint | null>(null);

  const walletKeyStr = wallet.publicKey?.toBase58() ?? null;
  const raw = slabState.raw;
  const tokenMeta = useTokenMeta(slabState.config?.collateralMint ?? null);
  const decimals = tokenMeta?.decimals ?? 6;
  const marketauthStr = slabState.wrapperConfigV17?.marketauth?.toBase58() ?? null;

  // ── Synchronous read of the operator gate + claimable budget from raw bytes ──
  const data: CreatorClaimData = useMemo(() => {
    if (!raw || !walletKeyStr) return { ...EMPTY, decimals };
    const cap = marketAssetCapacity(raw);
    if (cap <= 0) return { ...EMPTY, decimals };

    const controlled: CreatorClaimAsset[] = [];
    for (let i = 0; i < cap; i++) {
      const op = readAssetInsuranceOperator(raw, i);
      const opStr = op?.toBase58() ?? null;
      // The on-chain handler authorizes the asset's insurance_operator OR marketauth.
      const isController = opStr === walletKeyStr || marketauthStr === walletKeyStr;
      if (!isController) continue;
      let budget = 0n;
      try {
        budget = readInsuranceDomainBudget(raw, i);
      } catch {
        budget = 0n;
      }
      controlled.push({ assetIndex: i, claimable: budget });
    }

    const total = controlled.reduce((acc, a) => acc + a.claimable, 0n);

    // Cooldown pre-check (market-wide) from the correctly-parsed WrapperConfigV17.
    const cooldownSlots = slabState.wrapperConfigV17?.insuranceWithdrawCooldownSlots ?? 0n;
    const lastSlot = slabState.wrapperConfigV17?.lastInsuranceWithdrawSlot ?? 0n;
    let cooldownActive = false;
    let cooldownRemainingSlots = 0n;
    if (cooldownSlots > 0n && lastSlot > 0n && currentSlot != null) {
      const earliest = lastSlot + cooldownSlots;
      if (currentSlot < earliest) {
        cooldownActive = true;
        cooldownRemainingSlots = earliest - currentSlot;
      }
    }

    return {
      isOperator: controlled.length > 0,
      claimable: total,
      claimableAssets: controlled,
      decimals,
      cooldownActive,
      cooldownRemainingSlots,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, walletKeyStr, marketauthStr, decimals, currentSlot, slabState.wrapperConfigV17]);

  // Fetch the current slot (only when this wallet is an operator) for the cooldown countdown.
  const isOperator = data.isOperator;
  useEffect(() => {
    if (!isOperator || !connection) return;
    let cancelled = false;
    connection
      .getSlot()
      .then((s: number) => {
        if (!cancelled) setCurrentSlot(BigInt(s));
      })
      .catch(() => {
        /* cooldown countdown is best-effort; the on-chain gate is authoritative */
      });
    return () => {
      cancelled = true;
    };
  }, [isOperator, connection, slabState.raw]);

  /**
   * Claim the accrued creator fees for one asset (default: the first operated
   * asset with a positive balance). Sends WithdrawInsuranceAsset (tag 57):
   *   wire  = tag(57) + asset_index(u16) + amount(u128)
   *   metas = [operator(signer,w), market(w), destToken(w), vaultToken(w),
   *            vaultAuthority(ro), tokenProgram(ro)]  (ACCOUNTS_WITHDRAW_INSURANCE)
   * amount is clamped to the group insurance balance so a healthy single-asset
   * market never over-requests; the on-chain handler is the final cap.
   */
  const claim = useCallback(
    async (assetIndexArg?: number) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        throw new Error("Wallet not connected");
      }
      if (!raw || !slabState.programId || !slabState.config) {
        throw new Error("Market not loaded");
      }
      assertKnownProgram(slabState.programId);

      const target =
        assetIndexArg != null
          ? data.claimableAssets.find((a) => a.assetIndex === assetIndexArg)
          : data.claimableAssets.find((a) => a.claimable > 0n);
      if (!target) {
        throw new Error("No claimable creator fees for this market.");
      }
      if (target.claimable <= 0n) {
        throw new Error("Nothing to claim — no accrued fee revenue for this asset yet.");
      }

      setLoading(true);
      setError(null);
      setSuccess(null);
      try {
        const progPk = new PublicKey(slabState.programId);
        const marketPk = new PublicKey(slabAddress);
        const collateralMint = slabState.config.collateralMint;

        // Clamp to the group insurance balance (the on-chain handler also caps at
        // min(capacity, insurance, vault); insurance <= vault always, so this
        // avoids the most common EngineLockActive revert without misrepresenting
        // the displayed budget).
        let amount = target.claimable;
        try {
          const insuranceBalance = parseMarketGroupV17OI(raw).insuranceBalance;
          if (insuranceBalance > 0n && insuranceBalance < amount) {
            amount = insuranceBalance;
          }
        } catch {
          /* fall back to the full budget if OI parse fails */
        }

        const [vaultPda] = deriveVaultAuthority(progPk, marketPk);
        const destToken = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);
        const vaultToken = await getAssociatedTokenAddress(collateralMint, vaultPda, true);

        const data57 = encodeWithdrawInsuranceAsset({
          assetIndex: target.assetIndex,
          amount,
        });
        const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_INSURANCE, [
          wallet.publicKey, // authority (insurance_operator)
          marketPk, // market
          destToken, // destToken — operator's collateral ATA
          vaultToken, // vaultToken — market vault ATA
          vaultPda, // vaultAuthority PDA
          WELL_KNOWN.tokenProgram, // tokenProgram
        ]);
        const ix = buildIx({ programId: progPk, keys, data: data57 });

        const sig = await sendTx({ connection, wallet, instructions: [ix] });

        // Re-read on-chain truth so the displayed claimable drops to 0.
        slabState.refresh();
        connection
          .getSlot()
          .then((s: number) => setCurrentSlot(BigInt(s)))
          .catch(() => {});
        setSuccess(typeof sig === "string" ? sig : "Claim submitted");
        return sig;
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const friendly = mapCreatorClaimError(rawMsg);
        setError(friendly);
        throw new Error(friendly);
      } finally {
        setLoading(false);
      }
    },
    [wallet, raw, slabState, slabAddress, data.claimableAssets, connection],
  );

  const refresh = useCallback(() => {
    slabState.refresh();
    if (connection) {
      connection
        .getSlot()
        .then((s: number) => setCurrentSlot(BigInt(s)))
        .catch(() => {});
    }
  }, [slabState, connection]);

  // Keep a stable ref so callers can clear transient status.
  const clearStatus = useRef(() => {
    setError(null);
    setSuccess(null);
  }).current;

  return { ...data, loading, error, success, claim, refresh, clearStatus };
}
