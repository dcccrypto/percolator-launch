"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import {
  ACCOUNTS_WITHDRAW_CREATOR_FEE,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
  encodeWithdrawCreatorFee,
  WELL_KNOWN,
} from "@percolatorct/sdk";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { assertKnownProgram } from "@/lib/programAllowlist";
import {
  isCreatorFeeClaimAuthority,
  readCreatorFeeClaimable,
} from "@/lib/v17-creator-fee";
import { mapCreatorClaimError } from "@/lib/creatorClaimError";

export interface CreatorClaimData {
  /** True iff the connected wallet is asset 0's `asset_admin` — the ONLY wallet tag 90 accepts. */
  isClaimAuthority: boolean;
  /** Unclaimed creator trade-fee revenue, in collateral atoms (`creator_fee_claimable_atoms`). */
  claimable: bigint;
  /** Mint the payout is denominated in, read from the same account as `claimable`. */
  collateralMint: PublicKey | null;
  /** The wallet tag 90 will accept as the claimant, or null when it could not be resolved. */
  claimAuthority: PublicKey | null;
  /** Collateral-token decimals for human display. */
  decimals: number;
}

const EMPTY: Omit<CreatorClaimData, "decimals"> = {
  isClaimAuthority: false,
  claimable: 0n,
  collateralMint: null,
  claimAuthority: null,
};

/**
 * Creator fee-claim hook — `WithdrawCreatorFee` (tag 90).
 *
 * WHAT CHANGED AND WHY IT MATTERS
 * ───────────────────────────────
 * This hook used to display the market's `insurance_domain_budget` as the
 * creator's "claimable" balance and drain it with `WithdrawInsuranceAsset`
 * (tag 57). That budget is the LOSS BACKSTOP the engine draws down to cover
 * negative trader PnL (`consume_domain_insurance_for_negative_pnl`), and tag
 * 57's health gate only bites during active stress — so the button let a
 * creator preemptively remove the market's solvency backstop while it looked
 * healthy, and the number next to it was never creator revenue in the first
 * place.
 *
 * The deployed wrapper (`DhSkE7uTb8HBUYYWF1xkxMYBGtLYJEoDq1tfBD7SnHcj`) now
 * accrues the creator fee leg into a dedicated market-level counter,
 * `creator_fee_claimable_atoms` (u64 LE, WrapperConfig byte 568 / absolute
 * 584), and pays it out with `WithdrawCreatorFee` (tag 90). Tag 90 cannot
 * touch a domain budget and tag 57 cannot touch this counter — they are
 * disjoint by construction. This hook therefore:
 *
 *   1. reads the balance through `lib/v17-creator-fee.ts`, which delegates the
 *      decode to the SDK's `parseWrapperConfigV17` so byte 568 has exactly one
 *      owner in this repo (app-local copies of layout constants going stale is
 *      what caused the 496→576 outage);
 *   2. gates on asset 0's `asset_admin` and ONLY that — deliberately NOT
 *      `insurance_operator` (re-gated on-chain 2026-07-23) nor `marketauth`. The
 *      wizard's full create flow rotates `marketauth`, `insurance_authority` AND
 *      `insurance_operator` to program PDAs; `asset_admin` is the sole field that
 *      stays the creator's wallet, so it is the only gate that leaves a staked
 *      market claimable by its creator (and what the on-chain handler accepts);
 *   3. builds + sends the 17-byte tag-90 instruction and re-reads the account
 *      so the displayed claimable drops after a successful claim.
 *
 * SHAPE CHANGE: the old flow was PER-ASSET (it summed each asset's long+short
 * budget and looped assets). The new counter is a SINGLE MARKET-LEVEL value —
 * there is no per-asset creator revenue on-chain any more, so there is no
 * per-asset breakdown to show.
 *
 * NO COOLDOWN: tag 57's `insurance_withdraw_cooldown_slots` / ceiling gates
 * exist to rate-limit backstop withdrawals. `handle_withdraw_creator_fee`
 * deliberately has neither (see its doc comment, divergence #2) because the
 * counter is disjoint from the backstop. Surfacing a cooldown here would block
 * legitimate claims for a gate the program does not apply.
 */
export function useCreatorClaim() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const params = useParams();

  // Prefer the address the parsed bytes actually came from. On a route change
  // SlabProvider can briefly lag `params`, and sending a tag-90 whose `amount`
  // was read from a DIFFERENT market's counter would either over-claim (revert)
  // or silently under-claim. Self-consistency beats freshness here.
  const slabAddress = slabState.slabAddress ?? (params?.slab as string | undefined) ?? null;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const walletKeyStr = wallet.publicKey?.toBase58() ?? null;
  const raw = slabState.raw;

  // ── Read the claimable counter + claim authority straight from the account ──
  const parsed = useMemo(() => (raw ? readCreatorFeeClaimable(raw) : null), [raw]);

  const gated = useMemo(() => {
    if (!parsed || !walletKeyStr) return EMPTY;
    if (!isCreatorFeeClaimAuthority(parsed, wallet.publicKey ?? null)) return EMPTY;
    return {
      isClaimAuthority: true,
      claimable: parsed.atoms,
      collateralMint: parsed.collateralMint,
      claimAuthority: parsed.claimAuthority,
    };
  }, [parsed, walletKeyStr, wallet.publicKey]);

  const tokenMeta = useTokenMeta(gated.collateralMint);
  const decimals = tokenMeta?.decimals ?? 6;

  const data: CreatorClaimData = { ...gated, decimals };

  /**
   * Claim accrued creator fees. Sends `WithdrawCreatorFee` (tag 90):
   *   wire  = tag(90) + amount(u128 LE)  → EXACTLY 17 bytes
   *   metas = [authority(signer,w), market(w), destToken(w), vaultToken(w),
   *            vaultAuthority(ro), tokenProgram(ro)]  (ACCOUNTS_WITHDRAW_CREATOR_FEE)
   *
   * `amount` defaults to the full counter. It is NOT clamped against anything
   * else on-chain: the handler rejects an over-claim outright (Custom(62)
   * CreatorFeeOverClaim) rather than partial-filling, and debits nothing on
   * rejection, so silently sending less than the user asked for would be a lie
   * with no upside. `amount == 0` is likewise rejected on-chain (Custom(9)) —
   * tag 90 does NOT use tag 84's "0 means withdraw everything" convention.
   */
  const claim = useCallback(
    async (amountArg?: bigint) => {
      /** Surface the reason in the panel *and* reject, so a caller's catch{} is not silent. */
      const fail = (msg: string): never => {
        setSuccess(null);
        setError(msg);
        throw new Error(msg);
      };

      if (!wallet.publicKey || !wallet.signTransaction) {
        return fail("Wallet not connected");
      }
      if (!raw || !slabState.programId || !slabAddress) {
        return fail("Market not loaded");
      }
      assertKnownProgram(slabState.programId);

      // Re-read at send time rather than trusting the render-time snapshot: the
      // amount on the wire must match the counter this instruction will debit.
      const current = readCreatorFeeClaimable(raw);
      if (!current) {
        return fail("This market does not expose a creator fee counter.");
      }
      if (!isCreatorFeeClaimAuthority(current, wallet.publicKey)) {
        return fail(
          "Only this market's admin (the creator) can claim its fees. Connect the creator wallet.",
        );
      }
      const amount = amountArg ?? current.atoms;
      if (amount <= 0n) {
        return fail("Nothing to claim — this market has not accrued any creator fees yet.");
      }
      if (amount > current.atoms) {
        return fail(
          "Claim exceeds the accrued creator fees for this market. The claim is exact-amount — request no more than the accrued balance.",
        );
      }

      setLoading(true);
      setError(null);
      setSuccess(null);
      try {
        const progPk = new PublicKey(slabState.programId);
        const marketPk = new PublicKey(slabAddress);
        const collateralMint = current.collateralMint;

        const [vaultPda] = deriveVaultAuthority(progPk, marketPk);
        const destToken = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);
        const vaultToken = await getAssociatedTokenAddress(collateralMint, vaultPda, true);

        const data90 = encodeWithdrawCreatorFee({ amount });
        const keys = buildAccountMetas(ACCOUNTS_WITHDRAW_CREATOR_FEE, [
          wallet.publicKey, // authority — asset 0's asset_admin
          marketPk, // market
          destToken, // destToken — claimant's collateral ATA
          vaultToken, // vaultToken — market vault ATA (source)
          vaultPda, // vaultAuthority PDA
          WELL_KNOWN.tokenProgram, // tokenProgram
        ]);
        const ix = buildIx({ programId: progPk, keys, data: data90 });

        const sig = await sendTx({ connection, wallet, instructions: [ix] });

        // Re-read on-chain truth so the displayed claimable drops.
        slabState.refresh();
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
    [wallet, raw, slabState, slabAddress, connection],
  );

  const refresh = useCallback(() => {
    slabState.refresh();
  }, [slabState]);

  // Keep a stable ref so callers can clear transient status.
  const clearStatus = useRef(() => {
    setError(null);
    setSuccess(null);
  }).current;

  return { ...data, loading, error, success, claim, refresh, clearStatus };
}
