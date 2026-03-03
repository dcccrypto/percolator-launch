/**
 * PERC-376: Devnet faucet hook
 *
 * Manages a multi-step faucet flow for devnet:
 *   Step 1: Airdrop SOL (via Solana devnet requestAirdrop)
 *   Step 2: Airdrop USDC (via /api/faucet mint endpoint)
 *   Step 3: Auto-deposit into Percolator account
 *
 * Target: wallet connect → trading in <60 seconds.
 * Rate limit: 1 claim per wallet per 24h (enforced server-side).
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";

export type FaucetStep = "idle" | "sol" | "usdc" | "deposit" | "done" | "error";

export interface DevnetFaucetState {
  /** Whether the faucet modal should be shown */
  shouldShow: boolean;
  /** Current step in the flow */
  step: FaucetStep;
  /** Whether any step is in progress */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** SOL balance (human-readable) */
  solBalance: number | null;
  /** USDC balance (human-readable) */
  usdcBalance: number | null;
  /** Whether SOL airdrop completed */
  solDone: boolean;
  /** Whether USDC airdrop completed */
  usdcDone: boolean;
  /** Whether deposit completed */
  depositDone: boolean;
  /** Whether rate-limited */
  rateLimited: boolean;
  /** Next claim time if rate-limited */
  nextClaimAt: string | null;
  /** Dismiss the modal */
  dismiss: () => void;
  /** Airdrop SOL */
  airdropSol: () => Promise<void>;
  /** Airdrop USDC */
  airdropUsdc: () => Promise<void>;
  /** Do all steps in one click */
  fundAll: () => Promise<void>;
  /** Refresh balances */
  refreshBalances: () => Promise<void>;
}

const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";
const SOL_THRESHOLD = 0.05 * LAMPORTS_PER_SOL;
const USDC_THRESHOLD = 1_000_000n; // 1 USDC (6 decimals)
const DISMISSED_KEY = "percolator:faucet-dismissed";

export function useDevnetFaucet(): DevnetFaucetState {
  const { publicKey, connected } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { config: mktConfig } = useSlabState();
  const userAccount = useUserAccount();
  const isDevnet = process.env.NEXT_PUBLIC_SOLANA_NETWORK === "devnet";

  const [step, setStep] = useState<FaucetStep>("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [solDone, setSolDone] = useState(false);
  const [usdcDone, setUsdcDone] = useState(false);
  // depositDone is intentionally never set to true here — the actual deposit
  // completion is tracked by AutoDepositProvider. This flag exists in the
  // return type for UI consumers that need a unified status interface.
  const [depositDone, setDepositDone] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [nextClaimAt, setNextClaimAt] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true); // default true to avoid flash
  const [checked, setChecked] = useState(false);

  const airdropConnection = useRef(new Connection(PUBLIC_DEVNET_RPC, "confirmed"));

  // Check if previously dismissed for this wallet
  useEffect(() => {
    if (!publicKey) return;
    const key = `${DISMISSED_KEY}:${publicKey.toBase58()}`;
    const stored = typeof window !== "undefined" ? localStorage.getItem(key) : null;
    if (stored) {
      // Check if stored timestamp is within 24h
      const ts = parseInt(stored, 10);
      if (Date.now() - ts < 24 * 60 * 60 * 1000) {
        setDismissed(true);
      } else {
        setDismissed(false);
      }
    } else {
      setDismissed(false);
    }
  }, [publicKey]);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) return;
    try {
      const bal = await connection.getBalance(publicKey);
      setSolBalance(bal / LAMPORTS_PER_SOL);

      if (bal >= SOL_THRESHOLD) setSolDone(true);
    } catch {
      // non-fatal
    }

    if (mktConfig?.collateralMint) {
      try {
        const ata = getAssociatedTokenAddressSync(mktConfig.collateralMint, publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        const amount = BigInt(info.value.amount);
        setUsdcBalance(Number(amount) / 1_000_000);
        if (amount >= USDC_THRESHOLD) setUsdcDone(true);
      } catch {
        setUsdcBalance(0);
      }
    }
  }, [publicKey, connection, mktConfig]);

  // Initial balance check after connect
  useEffect(() => {
    if (!connected || !publicKey || !isDevnet || checked) return;
    setChecked(true);
    refreshBalances();
  }, [connected, publicKey, isDevnet, checked, refreshBalances]);

  // Determine whether to show the modal
  const shouldShow =
    isDevnet &&
    connected &&
    !!publicKey &&
    !dismissed &&
    !userAccount && // No existing Percolator account
    checked &&
    solBalance !== null &&
    (solBalance < 0.05 || (usdcBalance !== null && usdcBalance < 1));

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (publicKey) {
      const key = `${DISMISSED_KEY}:${publicKey.toBase58()}`;
      localStorage.setItem(key, Date.now().toString());
    }
  }, [publicKey]);

  const airdropSol = useCallback(async () => {
    if (!publicKey) return;
    setStep("sol");
    setLoading(true);
    setError(null);
    try {
      const sig = await airdropConnection.current.requestAirdrop(
        publicKey,
        2 * LAMPORTS_PER_SOL,
      );
      // Poll for confirmation
      const start = Date.now();
      while (Date.now() - start < 60_000) {
        const { value } = await airdropConnection.current.getSignatureStatuses([sig]);
        const s = value?.[0];
        if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
          if (s.err) throw new Error("SOL airdrop transaction failed");
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      setSolDone(true);
      await refreshBalances();
    } catch (e) {
      setError(e instanceof Error ? e.message : "SOL airdrop failed — devnet may be rate-limiting. Try the Solana Faucet.");
    } finally {
      setLoading(false);
    }
  }, [publicKey, refreshBalances]);

  const airdropUsdc = useCallback(async () => {
    if (!publicKey) return;
    setStep("usdc");
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });
      const data = await resp.json();
      if (resp.status === 429) {
        setRateLimited(true);
        setNextClaimAt(data.nextClaimAt ?? null);
        setError("Already claimed in the last 24 hours");
        return;
      }
      if (!resp.ok) {
        throw new Error(data.error ?? "USDC airdrop failed");
      }
      setUsdcDone(true);
      await refreshBalances();
    } catch (e) {
      setError(e instanceof Error ? e.message : "USDC airdrop failed");
    } finally {
      setLoading(false);
    }
  }, [publicKey, refreshBalances]);

  const fundAll = useCallback(async () => {
    if (!publicKey) return;
    setError(null);

    // Step 1: SOL (if needed)
    if (!solDone && (solBalance === null || solBalance < 0.05)) {
      await airdropSol();
      // If SOL airdrop failed, try to continue anyway (user might already have some)
    }

    // Step 2: USDC (if needed)
    if (!usdcDone && (usdcBalance === null || usdcBalance < 1)) {
      await airdropUsdc();
    }

    // Step 3: Mark done — auto-deposit is handled by AutoDepositProvider
    if (!error) {
      setStep("done");
    }
  }, [publicKey, solDone, usdcDone, solBalance, usdcBalance, airdropSol, airdropUsdc, error]);

  return {
    shouldShow,
    step,
    loading,
    error,
    solBalance,
    usdcBalance,
    solDone,
    usdcDone,
    depositDone,
    rateLimited,
    nextClaimAt,
    dismiss,
    airdropSol,
    airdropUsdc,
    fundAll,
    refreshBalances,
  };
}
