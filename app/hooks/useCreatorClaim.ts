"use client";

import { errorText } from "@/lib/error-text";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { sendTx } from "@/lib/tx";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { assertKnownProgram } from "@/lib/programAllowlist";
import {
  isCreatorFeeClaimAuthority,
  readCreatorFeeClaimable,
} from "@/lib/v17-creator-fee";
import { mapCreatorClaimError } from "@/lib/creatorClaimError";
import {
  buildCreatorFeeClaimIx,
  buildCreatorFeePayeeClaimIxs,
  creatorFeeRouteOf,
  CreatorFeeClaimError,
} from "@/lib/creator-fee-claim-ix";
import { decodeCreatorFeePayeeV22, deriveCreatorFeePayeeV22 } from "@/lib/v22/sdk/creator-fee-payee-v22";

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
 * The deployed wrapper accrues the creator fee leg per asset, into
 * `AssetOracleProfileV16.creator_fee_claimable_atoms` (GH#420,
 * `a327b4b0`) — plus, for asset 0 only, whatever sits in the legacy
 * market-level counter that predates GH#420 (`WrapperConfigV16
 * .creator_fee_claimable_atoms`, u64 LE, config byte 568 / absolute 584).
 * `WithdrawCreatorFee` (tag 90) pays out exactly that sum for `assetIndex: 0`
 * and this hook mirrors it. Tag 90 cannot touch a domain budget and tag 57
 * cannot touch either counter — they are disjoint by construction. This hook
 * therefore:
 *
 *   1. reads the balance through `lib/v17-creator-fee.ts`, which delegates both
 *      decodes to the SDK's `parseWrapperConfigV17` / `parseAssetOracleProfileV17`
 *      so neither byte offset has more than one owner in this repo (app-local
 *      copies of layout constants going stale is what caused the 496→576
 *      outage, and reading only the legacy counter is what caused the frontend
 *      to under-report post-GH#420 fees, percolator-prog#507);
 *   2. gates on asset 0's `asset_admin` and ONLY that — deliberately NOT
 *      `insurance_operator` (re-gated on-chain 2026-07-23) nor `marketauth`. The
 *      wizard's full create flow rotates `marketauth`, `insurance_authority` AND
 *      `insurance_operator` to program PDAs; `asset_admin` is the sole field that
 *      stays the creator's wallet, so it is the only gate that leaves a staked
 *      market claimable by its creator (and what the on-chain handler accepts);
 *   3. builds + sends the 17-byte tag-90 instruction and re-reads the account
 *      so the displayed claimable drops after a successful claim.
 *
 * SHAPE: this hook only ever targets asset 0 — the claim flow hardcodes
 * `assetIndex: 0` (`lib/creator-fee-claim-ix.ts`) — so there is still no
 * per-asset breakdown surfaced here even though the on-chain accrual is now
 * per-asset. A multi-asset market's assets 1..N accrue their own claimable
 * balances that this hook does not read or expose.
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

  // prog #587: asset 0's admin burned AFTER recording a payee -> anyone may send the fees to that payee (tag 90 payee route).
  const payeeRoute = useMemo(() => (raw ? creatorFeeRouteOf(raw) === "Payee" : false), [raw]);
  const owedToPayee = payeeRoute && parsed ? parsed.atoms : 0n;
  const [payee, setPayee] = useState<PublicKey | null>(null);
  const programIdStr = slabState.programId ? String(slabState.programId) : null;
  useEffect(() => {
    if (!payeeRoute || !programIdStr || !slabAddress) { setPayee(null); return; }
    let live = true;
    const market = new PublicKey(slabAddress);
    const [pda] = deriveCreatorFeePayeeV22(new PublicKey(programIdStr), market, 0);
    connection.getAccountInfo(pda, "confirmed").then(
      (info) => {
        if (!live) return;
        try {
          const rec = info ? decodeCreatorFeePayeeV22(new Uint8Array(info.data)) : null;
          setPayee(rec && rec.market.equals(market) ? rec.payee : null);
        } catch {
          setPayee(null);
        }
      },
      () => { if (live) setPayee(null); },
    );
    return () => { live = false; };
  }, [payeeRoute, programIdStr, slabAddress, connection]);

  const tokenMeta = useTokenMeta(gated.collateralMint ?? (payeeRoute ? parsed?.collateralMint ?? null : null));
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

      setLoading(true);
      setError(null);
      setSuccess(null);
      try {
        // Guards AND encoding live in lib/creator-fee-claim-ix.ts so this panel
        // and the dashboard's per-market / claim-all buttons cannot drift into
        // disagreeing about what a valid claim is. It re-reads `raw` at send
        // time, so the amount on the wire matches the counter it debits and the
        // CAS-bound authority_epoch is live.
        const built = await buildCreatorFeeClaimIx({
          programId: new PublicKey(slabState.programId),
          market: new PublicKey(slabAddress),
          raw,
          claimant: wallet.publicKey,
          amount: amountArg,
        });

        const sig = await sendTx({ connection, wallet, instructions: [built.instruction] });

        // Re-read on-chain truth so the displayed claimable drops.
        slabState.refresh();
        setSuccess(typeof sig === "string" ? sig : "Claim submitted");
        return sig;
      } catch (err) {
        const rawMsg = errorText(err);
        // A guard message is already a sentence written for the creator; only
        // on-chain/RPC failures need the code-to-sentence mapper.
        const friendly = err instanceof CreatorFeeClaimError ? rawMsg : mapCreatorClaimError(rawMsg);
        setError(friendly);
        throw new Error(friendly);
      } finally {
        setLoading(false);
      }
    },
    [wallet, raw, slabState, slabAddress, connection],
  );

  /**
   * prog #587: send this market's creator fees to the recorded payee (permissionless tag 90, payee route). Any connected wallet
   * can do it; the funds go only to the payee's own token account (created in the same transaction if needed).
   */
  const claimToPayee = useCallback(async () => {
    const fail = (msg: string): never => {
      setSuccess(null);
      setError(msg);
      throw new Error(msg);
    };
    if (!wallet.publicKey || !wallet.signTransaction) return fail("Wallet not connected");
    if (!slabState.programId || !slabAddress) return fail("Market not loaded");
    assertKnownProgram(slabState.programId);
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const programId = new PublicKey(slabState.programId);
      const market = new PublicKey(slabAddress);
      // Send-time reads: the amount and the authority epoch must match what tag 90 debits / checks.
      const [mInfo, rInfo] = await connection.getMultipleAccountsInfo([market, deriveCreatorFeePayeeV22(programId, market, 0)[0]], "confirmed");
      if (!mInfo) return fail("Market not loaded");
      if (!rInfo) return fail("This market's fee payee record could not be read. Try again in a moment.");
      const built = buildCreatorFeePayeeClaimIxs({
        programId, market, raw: new Uint8Array(mInfo.data), payeeRecord: new Uint8Array(rInfo.data), caller: wallet.publicKey,
      });
      const sig = await sendTx({ connection, wallet, instructions: built.instructions });
      slabState.refresh();
      setSuccess(typeof sig === "string" ? sig : "Payout submitted");
      return sig;
    } catch (err) {
      const rawMsg = errorText(err);
      const friendly = err instanceof CreatorFeeClaimError ? rawMsg : mapCreatorClaimError(rawMsg);
      setError(friendly);
      throw new Error(friendly);
    } finally {
      setLoading(false);
    }
  }, [wallet, slabState, slabAddress, connection]);

  const refresh = useCallback(() => {
    slabState.refresh();
  }, [slabState]);

  // Keep a stable ref so callers can clear transient status.
  const clearStatus = useRef(() => {
    setError(null);
    setSuccess(null);
  }).current;

  return { ...data, payeeRoute, payee, owedToPayee, loading, error, success, claim, claimToPayee, refresh, clearStatus };
}
