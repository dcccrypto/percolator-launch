'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import { PublicKey } from '@solana/web3.js';
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
  encodeDepositToLpVault,
  encodeRequestRedeemLpShares,
  encodeExecuteRedemption,
  ACCOUNTS_CREATE_LP_VAULT,
  ACCOUNTS_LP_VAULT_DEPOSIT,
  buildAccountMetas,
  buildIx,
  WELL_KNOWN,
  deriveVaultAuthority,
  deriveLpBackingLedger,
  parseLpVaultRegistry,
  parseLpRedemption,
} from '@percolatorct/sdk';
import { sendTx } from '@/lib/tx';
import { useSlabState } from '../components/providers/SlabProvider';
import { assertKnownProgram } from '@/lib/programAllowlist';
import { useParams } from 'next/navigation';
import { sanitizeOnChainValue } from '@/lib/health';

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
  /** User's collateral ATA balance (available to deposit), in raw atoms. */
  userCollateralBalance: bigint;
  /** Total atoms currently backing the LP vault: shares outstanding + distributed fee atoms. */
  vaultTotalAtoms: bigint;
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
}

export function useInsuranceLP() {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;
  const programId = slabState.programId;

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
    userCollateralBalance: 0n,
    vaultTotalAtoms: 0n,
    vaultSharePriceE6: 1_000_000n,
    userVaultValueAtoms: 0n,
    redemptionCooldownSlots: 0n,
    hasPendingRedemption: false,
    pendingRedemptionShares: 0n,
    cooldownRemainingSlots: 0n,
    cooldownElapsed: true,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stabilize wallet.publicKey reference — PublicKey is not referentially stable
  const walletPubkeyStr = wallet.publicKey?.toBase58() ?? null;

  // Derive the insurance LP mint PDA
  const lpMintInfo = useMemo(() => {
    if (!slabAddress || !programId) return null;
    try {
      const slabPubkey = new PublicKey(slabAddress);
      const progPubkey = new PublicKey(programId);
      const [mintPda, bump] = deriveInsuranceLpMint(progPubkey, slabPubkey);
      return { mintPda, bump };
    } catch {
      return null;
    }
  }, [slabAddress, programId]);

  // Derive the LP Vault Registry PDA (and, once a wallet is connected, the
  // redemption-ticket PDA for that wallet). Kept separate from lpMintInfo above
  // so a failure deriving one never blocks the other.
  const registryInfo = useMemo(() => {
    if (!slabAddress || !programId) return null;
    try {
      const slabPubkey = new PublicKey(slabAddress);
      const progPubkey = new PublicKey(programId);
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
  }, [slabAddress, programId, walletPubkeyStr]);

  // Poll insurance state
  const refreshState = useCallback(async () => {
    if (!slabState || !lpMintInfo || !connection) return;

    try {
      // Check if LP mint exists on-chain first — needed to sanitize insuranceBalance
      const mintInfo = await connection.getAccountInfo(lpMintInfo.mintPda);
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
      let userLpBalance = 0n;

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
            if (ataInfo) {
              const account = unpackAccount(userLpAta, ataInfo);
              userLpBalance = account.amount;
            }
          } catch {
            // ATA doesn't exist yet — user has 0 LP tokens
          }
        }
      }

      // Calculate derived values
      const redemptionRateE6 = lpSupply > 0n
        ? (insuranceBalance * 1_000_000n) / lpSupply
        : 1_000_000n; // 1:1 if no supply

      const userSharePct = lpSupply > 0n
        ? Number((userLpBalance * 10000n) / lpSupply) / 100
        : 0;

      const userRedeemableValue = lpSupply > 0n
        ? (userLpBalance * insuranceBalance) / lpSupply
        : 0n;

      // User's collateral ATA balance (available to deposit into the LP vault).
      let userCollateralBalance = 0n;
      if (walletPubkeyStr && slabState.config) {
        try {
          const walletPk = new PublicKey(walletPubkeyStr);
          const collateralAta = await getAssociatedTokenAddress(
            slabState.config.collateralMint,
            walletPk,
          );
          const collateralAtaInfo = await connection.getAccountInfo(collateralAta);
          if (collateralAtaInfo) {
            userCollateralBalance = unpackAccount(collateralAta, collateralAtaInfo).amount;
          }
        } catch {
          // ATA doesn't exist yet — user has 0 collateral available
        }
      }

      // ─── LP Vault Registry (v17 "Earn" vault) ───────────────────────────────
      // Separate on-chain account from the engine insuranceFund read above.
      // Wrapped in its own try/catch so a failure here (registry not yet
      // created, RPC hiccup, or an SDK without this export) never blocks the
      // insuranceBalance/lpSupply/userLpBalance state already computed above.
      let registryExists = false;
      let registryAddress: PublicKey | null = null;
      let vaultTotalAtoms = 0n;
      let vaultSharePriceE6 = 1_000_000n;
      let userVaultValueAtoms = 0n;
      let redemptionCooldownSlots = 0n;
      let hasPendingRedemption = false;
      let pendingRedemptionShares = 0n;
      let cooldownRemainingSlots = 0n;
      let cooldownElapsed = true;

      try {
        if (registryInfo) {
          registryAddress = registryInfo.registryPda;
          const registryAcctInfo = await connection.getAccountInfo(registryInfo.registryPda);
          if (registryAcctInfo && registryAcctInfo.data.length > 0) {
            const registry = parseLpVaultRegistry(new Uint8Array(registryAcctInfo.data));
            registryExists = true;
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
            userVaultValueAtoms = lpSupply > 0n
              ? (userLpBalance * vaultTotalAtoms) / lpSupply
              : 0n;

            // Pending redemption ticket (RequestRedeemLpShares → cooldown → ExecuteRedemption).
            if (registryInfo.redemptionPda) {
              const redemptionAcctInfo = await connection.getAccountInfo(registryInfo.redemptionPda);
              if (redemptionAcctInfo && redemptionAcctInfo.data.length > 0) {
                const redemption = parseLpRedemption(new Uint8Array(redemptionAcctInfo.data));
                hasPendingRedemption = true;
                pendingRedemptionShares = sanitizeOnChainValue(redemption.shares);
                const requestSlot = sanitizeOnChainValue(redemption.requestSlot);
                if (redemptionCooldownSlots > 0n) {
                  try {
                    const currentSlot = BigInt(await connection.getSlot());
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
        // Registry not yet created, malformed, or RPC hiccup — leave the safe
        // defaults above (0 / not-pending) rather than showing garbage.
        console.error('Failed to refresh LP vault registry state:', registryErr);
      }

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
        userCollateralBalance,
        vaultTotalAtoms,
        vaultSharePriceE6,
        userVaultValueAtoms,
        redemptionCooldownSlots,
        hasPendingRedemption,
        pendingRedemptionShares,
        cooldownRemainingSlots,
        cooldownElapsed,
      });
    } catch (err) {
      console.error('Failed to refresh insurance LP state:', err);
    }
  }, [slabState, lpMintInfo, registryInfo, connection, walletPubkeyStr]);

  // H3: Auto-refresh every 10s — use ref to avoid stale closure
  const refreshStateRef = useRef(refreshState);
  useEffect(() => {
    refreshStateRef.current = refreshState;
  }, [refreshState]);
  
  useEffect(() => {
    // Call refreshState on mount and set up auto-refresh interval
    const doRefresh = () => refreshStateRef.current();
    doRefresh();
    const interval = setInterval(doRefresh, 10_000);
    return () => clearInterval(interval);
  }, []); // Empty deps safe now — ref always points to latest refreshState

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
   */
  const deposit = useCallback(async (amount: bigint) => {
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
      const [vaultPda] = deriveVaultAuthority(progPk, marketPk);
      const [registryPda] = deriveLpVaultRegistry(progPk, marketPk);
      const [lpMintPda] = deriveInsuranceLpMint(progPk, marketPk);
      // Domain 0 = primary insurance domain
      const [ledgerPda] = deriveLpBackingLedger(progPk, marketPk, 0);

      const collateralMint = slabState.config.collateralMint;
      const vaultTokenAta = await getAssociatedTokenAddress(collateralMint, vaultPda, true);
      const sourceTokenAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);
      const depositorLpAta = await getAssociatedTokenAddress(lpMintPda, wallet.publicKey);

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
          wallet.publicKey, depositorLpAta, wallet.publicKey, lpMintPda,
        ));
      }

      const keys = buildAccountMetas(ACCOUNTS_LP_VAULT_DEPOSIT, [
        wallet.publicKey,
        marketPk,
        registryPda,
        lpMintPda,
        depositorLpAta,
        sourceTokenAta,
        vaultTokenAta,
        ledgerPda,
        WELL_KNOWN.tokenProgram,
        WELL_KNOWN.systemProgram,
      ]);
      ixs.push(buildIx({
        programId: progPk,
        keys,
        data: encodeDepositToLpVault({ amount: amount.toString() }),
      }));
      const sig = await sendTx({ connection, wallet, instructions: ixs });
      await refreshState();
      return sig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, connection, slabAddress, programId, slabState, refreshState]);

  /**
   * RequestRedeemLpShares (tag 76) — begin LP share redemption (starts cooldown).
   * Then call withdraw() which calls ExecuteRedemption (tag 77) after cooldown.
   *
   * For simplicity the UI may call withdraw() which runs both steps in sequence
   * if the redemption is past cooldown, or just RequestRedeem if not yet requested.
   */
  const withdraw = useCallback(async (lpAmount: bigint) => {
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

      // Check if a redemption request already exists
      const redemptionInfo = await connection.getAccountInfo(redemptionPda);
      if (!redemptionInfo) {
        // Step 1: RequestRedeemLpShares (tag 76)
        // BUG FIX (devnet flow-test 2026-07-01): this account list was missing lpMint,
        // redeemerLpAta and the per-vault LP escrow PDA — and wrongly included `market`,
        // which handle_request_redeem_lp_shares never reads — causing on-chain
        // NotEnoughAccountKeys. Real account list per percolator-prog
        // src/v16_program.rs handle_request_redeem_lp_shares (L12016-12028):
        //   [redeemer(signer,w), registry(w), lpMint, redeemerLpAta(w), escrow(w),
        //    redemption(w), tokenProgram, systemProgram]
        const redeemerLpAta = await getAssociatedTokenAddress(lpMintPda, wallet.publicKey);
        const requestKeys = [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: registryPda, isSigner: false, isWritable: true },
          { pubkey: lpMintPda, isSigner: false, isWritable: false },
          { pubkey: redeemerLpAta, isSigner: false, isWritable: true },
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: redemptionPda, isSigner: false, isWritable: true },
          { pubkey: WELL_KNOWN.tokenProgram, isSigner: false, isWritable: false },
          { pubkey: WELL_KNOWN.systemProgram, isSigner: false, isWritable: false },
        ];
        const requestIx = buildIx({
          programId: progPk,
          keys: requestKeys,
          data: encodeRequestRedeemLpShares({ shares: lpAmount.toString() }),
        });
        await sendTx({ connection, wallet, instructions: [requestIx] });
      } else {
        // Step 2: ExecuteRedemption (tag 77) — collect collateral after cooldown.
        // BUG FIX (devnet flow-test 2026-07-01): this account list was missing the LP
        // escrow PDA and the per-domain backing ledger PDA, and had the remaining
        // accounts in the wrong order — causing on-chain NotEnoughAccountKeys. Real
        // account list per percolator-prog src/v16_program.rs handle_execute_redemption
        // (L12153-12163): [cranker(signer,w), market(w), registry(w), redemption(w),
        // lpMint(w), escrow(w), vaultToken(w), vaultAuthority, ledger(w), redeemerDest(w),
        // tokenProgram]. `cranker` is permissionless (anyone may execute post-cooldown,
        // and is directly credited the redemption PDA's reclaimed rent) — the UI always
        // calls it as the redeemer themselves.
        const [vaultPda] = deriveVaultAuthority(progPk, marketPk);
        // Domain 0 — matches this hook's createMint()/deposit() hardcoded primary domain.
        const [ledgerPda] = deriveLpBackingLedger(progPk, marketPk, 0);
        const collateralMint = slabState.config.collateralMint;
        const vaultTokenAta = await getAssociatedTokenAddress(collateralMint, vaultPda, true);
        const redeemerAta = await getAssociatedTokenAddress(collateralMint, wallet.publicKey);

        const executeKeys = [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: marketPk, isSigner: false, isWritable: true },
          { pubkey: registryPda, isSigner: false, isWritable: true },
          { pubkey: redemptionPda, isSigner: false, isWritable: true },
          { pubkey: lpMintPda, isSigner: false, isWritable: true },
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: vaultTokenAta, isSigner: false, isWritable: true },
          { pubkey: vaultPda, isSigner: false, isWritable: false },
          { pubkey: ledgerPda, isSigner: false, isWritable: true },
          { pubkey: redeemerAta, isSigner: false, isWritable: true },
          { pubkey: WELL_KNOWN.tokenProgram, isSigner: false, isWritable: false },
        ];
        const executeIx = buildIx({
          programId: progPk,
          keys: executeKeys,
          data: encodeExecuteRedemption(),
        });
        await sendTx({ connection, wallet, instructions: [executeIx] });
      }
      await refreshState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [wallet, connection, slabAddress, programId, slabState, refreshState]);

  return {
    state,
    loading,
    error,
    createMint,
    deposit,
    withdraw,
    refreshState,
  };
}
