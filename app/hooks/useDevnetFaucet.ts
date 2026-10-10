/**
 * PERC-376: Devnet faucet hook
 * PERC-808: Decoupled from SlabProvider — can run on any page (global placement)
 *
 * Manages a multi-step faucet flow for devnet:
 *   Step 1: Airdrop SOL (via Solana devnet requestAirdrop)
 *   Step 2: Airdrop USDC (via /api/faucet mint endpoint)
 *   Step 3: Account setup + user-chosen starter deposit (order ticket "Start Trading")
 *
 * Target: wallet connect → trading in <60 seconds.
 * Rate limit: 1 claim per wallet per 24h (enforced server-side).
 *
 * PERC-808: Threshold raised to 1,000 USDC so users with small leftover
 * balances still see the welcome modal and get a proper top-up.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getConfig } from "@/lib/config";
import { invalidateWalletBalance } from "@/lib/wallet-balance-invalidation";
import { keepAppMessage, plainMessage } from "@/lib/limits/user-message";

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
const USDC_THRESHOLD = 1_000_000_000n; // 1,000 USDC (6 decimals) — PERC-808
const DISMISSED_KEY = "percolator:faucet-dismissed";

/**
 * PERC-808: Helius devnet faucet for SOL airdrop (more reliable than Solana's).
 * Falls back to Solana devnet faucet if Helius is unavailable.
 */
const HELIUS_API_KEY = process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? "";
const HELIUS_DEVNET_RPC = HELIUS_API_KEY
  ? `https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "";

export function useDevnetFaucet(): DevnetFaucetState {
  const { publicKey, connected } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const isDevnet =
    (process.env.NEXT_PUBLIC_DEFAULT_NETWORK ?? process.env.NEXT_PUBLIC_SOLANA_NETWORK) === "devnet";

  // PERC-808: Use global config testUsdcMint instead of SlabProvider — works on all pages
  const usdcMintPk = (() => {
    try {
      const cfg = getConfig() as Record<string, unknown>;
      const mint = cfg.testUsdcMint as string | undefined;
      return mint ? new PublicKey(mint) : null;
    } catch {
      return null;
    }
  })();

  const [step, setStep] = useState<FaucetStep>("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [solDone, setSolDone] = useState(false);
  const [usdcDone, setUsdcDone] = useState(false);
  // depositDone is intentionally never set to true here — account setup +
  // deposit now happen via the order ticket CTA. This flag exists in the
  // return type for UI consumers that need a unified status interface.
  const [depositDone] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [nextClaimAt, setNextClaimAt] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(true); // default true to avoid flash
  const [checked, setChecked] = useState(false);

  // Lazily construct the fallback airdrop Connection on first use instead of
  // on every render — `useRef(new Connection(...))` evaluates the initializer
  // (and throws away the result) on every single render, not just the first.
  const airdropConnectionRef = useRef<Connection | null>(null);
  const getAirdropConnection = useCallback((): Connection => {
    if (!airdropConnectionRef.current) {
      airdropConnectionRef.current = new Connection(PUBLIC_DEVNET_RPC, "confirmed");
    }
    return airdropConnectionRef.current;
  }, []);

  // Tracks whether the most recent airdropSol/airdropUsdc call failed, set
  // synchronously (unlike `error` state, which is only visible on the NEXT
  // render). fundAll reads this instead of the stale `error` closure.
  const lastOpFailedRef = useRef(false);
  // The SOL step's message: fundAll's USDC step clears the shared error, which erased it.
  const solErrorRef = useRef<string | null>(null);
  // An airdrop this modal just made, not yet visible in a balance read (the RPC can lag the
  // airdrop by a few seconds). Keeps the step done until a read shows the funds, then the step
  // follows the balance again.
  const solAirdropPendingRef = useRef(false);
  const usdcAirdropPendingRef = useRef(false);

  // Check if previously dismissed for this wallet
  useEffect(() => {
    if (!publicKey) return;
    const key = `${DISMISSED_KEY}:${publicKey.toBase58()}`;
    const stored = typeof window !== "undefined" ? localStorage.getItem(key) : null;
    if (stored) {
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

  // The wallet's address, not the PublicKey object: a refreshed wallet list hands back a new
  // object for the same wallet, which is not a wallet change.
  const walletAddress = publicKey?.toBase58() ?? null;
  const walletAddressRef = useRef(walletAddress);
  walletAddressRef.current = walletAddress;

  // Bug #34: reset per-wallet check/balance state when the connected wallet
  // changes. Without this, switching from wallet A (already `checked`) to
  // wallet B left `checked` (and solDone/usdcDone/balances) at wallet A's
  // values — the "Initial balance check after connect" effect below is
  // gated on `!checked`, so wallet B's balances were never (re-)fetched.
  useEffect(() => {
    setChecked(false);
    setSolDone(false);
    setUsdcDone(false);
    solAirdropPendingRef.current = false;
    usdcAirdropPendingRef.current = false;
    setSolBalance(null);
    setUsdcBalance(null);
  }, [walletAddress]);

  const refreshBalances = useCallback(async () => {
    if (!publicKey) return;
    // A read that resolves after the wallet changed belongs to the previous wallet: drop it.
    const forWallet = publicKey.toBase58();
    const stale = () => walletAddressRef.current !== forWallet;
    try {
      const bal = await connection.getBalance(publicKey);
      if (stale()) return;
      setSolBalance(bal / LAMPORTS_PER_SOL);
      if (bal >= SOL_THRESHOLD) solAirdropPendingRef.current = false;
      setSolDone(bal >= SOL_THRESHOLD || solAirdropPendingRef.current);
    } catch {
      // non-fatal
    }

    if (usdcMintPk) {
      try {
        const ata = getAssociatedTokenAddressSync(usdcMintPk, publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        if (stale()) return;
        const amount = BigInt(info.value.amount);
        setUsdcBalance(Number(amount) / 1_000_000);
        if (amount >= USDC_THRESHOLD) usdcAirdropPendingRef.current = false;
        setUsdcDone(amount >= USDC_THRESHOLD || usdcAirdropPendingRef.current);
      } catch (e) {
        // Distinguish "no ATA yet" (definitive — this wallet has never
        // received USDC, so 0 is correct) from a transient RPC hiccup.
        // Solana JSON-RPC reports a missing account as "could not find
        // account"; anything else (timeout, 5xx, rate limit) must NOT reset
        // the balance to 0 — that would pop the faucet modal over an
        // already-funded wallet.
        const msg = e instanceof Error ? e.message : String(e);
        if (stale()) return;
        if (/could not find account/i.test(msg)) {
          setUsdcBalance(0);
          setUsdcDone(usdcAirdropPendingRef.current);
        } else {
          console.warn("[useDevnetFaucet] transient USDC balance fetch error, keeping previous balance:", msg);
        }
      }
    }
  }, [publicKey, connection, usdcMintPk]);

  // Initial balance check after connect
  useEffect(() => {
    if (!connected || !publicKey || !isDevnet || checked) return;
    setChecked(true);
    refreshBalances();
  }, [connected, publicKey, isDevnet, checked, refreshBalances]);

  // "Stale popup" fix: this hook is mounted ONCE at the root layout (see
  // WalletProvider) and lives for the whole wallet session — the initial
  // check above is the only balance read unless the user clicks THIS
  // modal's own airdrop buttons. If the wallet gets funded through any other
  // path while connected (the trade page's DevnetTokenFaucetButton, a
  // second tab, a manual faucet.solana.com airdrop), solBalance/usdcBalance
  // stayed frozen at the connect-time snapshot and the modal could keep
  // telling an already-funded user they still need to fund — mirrors
  // usePortfolio.ts's visibility+interval refresh pattern. Gated on
  // `checked && !dismissed` — no point polling before the first check lands,
  // or once the user has dismissed the modal for this wallet.
  useEffect(() => {
    if (!connected || !publicKey || !isDevnet || !checked || dismissed) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshBalances();
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refreshBalances();
    }, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
    };
  }, [connected, publicKey, isDevnet, checked, dismissed, refreshBalances]);

  // PERC-808: Show when SOL < 0.05 OR USDC < 1,000 (no longer gated on userAccount)
  const shouldShow =
    isDevnet &&
    connected &&
    !!publicKey &&
    !dismissed &&
    checked &&
    solBalance !== null &&
    (solBalance < 0.05 || (usdcBalance !== null && usdcBalance < 1000));

  const dismiss = useCallback(() => {
    setDismissed(true);
    if (publicKey) {
      const key = `${DISMISSED_KEY}:${publicKey.toBase58()}`;
      localStorage.setItem(key, Date.now().toString());
    }
    // PERC-808: Signal faucet completion so auto-deposit can trigger
    if (solDone && usdcDone) {
      markFaucetComplete();
    }
  }, [publicKey, solDone, usdcDone]);

  const airdropSol = useCallback(async () => {
    if (!publicKey) return;
    setStep("sol");
    setLoading(true);
    setError(null);
    lastOpFailedRef.current = false;
    try {
      // UX WP-10 (FA-1): the server faucet first — it sends from the playground's server wallet
      // when that is configured (the public airdrop below is usually rate-limited).
      let sig: string | null = null;
      try {
        const resp = await fetch("/api/faucet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallet: publicKey.toBase58(), type: "sol" }),
        });
        const data = (await resp.json().catch(() => ({}))) as { signature?: string };
        if (resp.ok && data.signature) sig = data.signature;
      } catch {
        sig = null;
      }
      // PERC-808: Try Helius devnet faucet next (more reliable, higher limits)
      if (!sig && HELIUS_DEVNET_RPC) {
        try {
          const heliusConn = new Connection(HELIUS_DEVNET_RPC, "confirmed");
          sig = await heliusConn.requestAirdrop(publicKey, 2 * LAMPORTS_PER_SOL);
          // Confirm via Helius
          let confirmed = false;
          const start = Date.now();
          while (Date.now() - start < 60_000) {
            const { value } = await heliusConn.getSignatureStatuses([sig]);
            const s = value?.[0];
            if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
              if (s.err) throw new Error("SOL airdrop transaction failed");
              confirmed = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 2000));
          }
          // Not confirmed in a minute: not done (it used to fall through to setSolDone).
          if (!confirmed) throw new Error("SOL airdrop not confirmed");
        } catch {
          sig = null; // Fall through to Solana faucet
        }
      }

      // Fallback: Solana devnet faucet
      if (!sig) {
        const fallbackConn = getAirdropConnection();
        sig = await fallbackConn.requestAirdrop(
          publicKey,
          2 * LAMPORTS_PER_SOL,
        );
        let confirmed = false;
        const start = Date.now();
        while (Date.now() - start < 60_000) {
          const { value } = await fallbackConn.getSignatureStatuses([sig]);
          const s = value?.[0];
          if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
            if (s.err) throw new Error("SOL airdrop transaction failed");
            confirmed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        // Not confirmed in a minute: report it rather than showing the step done. If it lands
        // later, refreshBalances marks SOL done from the balance.
        if (!confirmed) throw new Error("SOL airdrop not confirmed");
      }

      solAirdropPendingRef.current = true;
      setSolDone(true);
      await refreshBalances();
    } catch (e) {
      lastOpFailedRef.current = true;
      const msg = plainMessage(e, { surface: "faucet" }, (raw) => keepAppMessage(raw) === raw ? raw : "SOL airdrop failed — devnet may be rate-limiting. Try the Solana Faucet.");
      solErrorRef.current = msg;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [publicKey, refreshBalances, getAirdropConnection]);

  const airdropUsdc = useCallback(async () => {
    if (!publicKey) return;
    setStep("usdc");
    setLoading(true);
    setError(null);
    lastOpFailedRef.current = false;
    try {
      const resp = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), type: "usdc" }),
      });
      const data = await resp.json();
      if (resp.status === 429) {
        lastOpFailedRef.current = true;
        setRateLimited(true);
        setNextClaimAt(data.nextClaimAt ?? null);
        // GH#1798: distinguish per-wallet DB gate from RPC rate limit
        setError(
          data.rpcRateLimited
            ? "SOL airdrop rate limit reached — try again tomorrow or use faucet.solana.com"
            : "Already claimed in the last 24 hours",
        );
        return;
      }
      if (!resp.ok) {
        throw new Error(data.error ?? "USDC airdrop failed");
      }
      usdcAirdropPendingRef.current = true;
      setUsdcDone(true);
      invalidateWalletBalance();
      await refreshBalances();
    } catch (e) {
      lastOpFailedRef.current = true;
      setError(e instanceof Error ? e.message : "USDC airdrop failed");
    } finally {
      setLoading(false);
    }
  }, [publicKey, refreshBalances]);

  const fundAll = useCallback(async () => {
    if (!publicKey) return;
    setError(null);

    // Bug: this used to check `error` (the render-time closure value) after
    // the awaits below — setError calls inside airdropSol/airdropUsdc can't
    // update that closure's binding, so a failed airdrop still flipped step
    // to "done". lastOpFailedRef is set synchronously by each call instead.
    let anyFailed = false;

    let solFailed = false;
    if (!solDone && (solBalance === null || solBalance < 0.05)) {
      await airdropSol();
      if (lastOpFailedRef.current) anyFailed = solFailed = true;
    }

    if (!usdcDone && (usdcBalance === null || usdcBalance < 1000)) {
      await airdropUsdc();
      if (lastOpFailedRef.current) anyFailed = true;
      // airdropUsdc cleared the shared error and moved step to "usdc". If only SOL failed, put
      // its message back on the SOL step so the modal shows it (and its faucet.solana.com link).
      else if (solFailed) {
        setStep("sol");
        setError(solErrorRef.current);
      }
    }

    if (!anyFailed) {
      setStep("done");
    }
  }, [publicKey, solDone, usdcDone, solBalance, usdcBalance, airdropSol, airdropUsdc]);

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

// ────────────────────────────────────────────────────────────────
// PERC-808: Faucet completion signal
// Uses sessionStorage so useAutoDeposit can detect faucet completion
// without needing shared React context across different component trees.
// ────────────────────────────────────────────────────────────────

const FAUCET_COMPLETE_KEY = "percolator:faucet-complete";
const FAUCET_COMPLETE_WINDOW_MS = 30_000; // 30s window for auto-deposit to react

/** Mark faucet as complete (called on dismiss after successful funding). */
export function markFaucetComplete(): void {
  try {
    sessionStorage.setItem(FAUCET_COMPLETE_KEY, Date.now().toString());
  } catch {
    // SSR guard
  }
}

/**
 * Returns true if faucet completed within the last 30 seconds.
 * Used by useAutoDeposit to trigger deposit after faucet modal dismiss.
 */
export function useFaucetComplete(): boolean {
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const check = () => {
      try {
        const ts = sessionStorage.getItem(FAUCET_COMPLETE_KEY);
        // Bug: this used to only ever call setComplete(true) and never
        // setComplete(false), so it latched forever once the 30s window
        // passed once — contradicting the documented window (GH#1107) and
        // letting the auto-deposit wallet-approval popup fire minutes later.
        // Always resolve to the CURRENT within-window state.
        const withinWindow = !!ts && Date.now() - parseInt(ts, 10) < FAUCET_COMPLETE_WINDOW_MS;
        setComplete(withinWindow);
      } catch {
        // SSR guard / storage unavailable
        setComplete(false);
      }
    };
    check();
    // Re-check periodically in case faucet completes while auto-deposit is mounted
    const interval = setInterval(check, 1000);
    return () => clearInterval(interval);
  }, []);

  return complete;
}
