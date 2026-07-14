"use client";

import { FC, useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatHumanAmount } from "@/lib/parseAmount";
import { isValidBase58Pubkey } from "@/lib/createWizardUtils";
import { getNetwork } from "@/lib/config";
import type { DuplicateMarket } from "@/hooks/useDuplicateMarket";

/** Derive whether we're on devnet from the live RPC endpoint (not build-time env var). */
function isDevnetEndpoint(rpcEndpoint: string): boolean {
  return rpcEndpoint.includes("devnet") || rpcEndpoint.includes("127.0.0.1") || rpcEndpoint.includes("localhost");
}

type MintNetworkStatus = "idle" | "loading" | "valid" | "invalid";

interface StepTokenSelectProps {
  mintAddress: string;
  onMintChange: (mint: string) => void;
  onTokenResolved: (meta: { name: string; symbol: string; decimals: number } | null) => void;
  onBalanceChange: (balance: bigint | null) => void;
  onDexPoolDetected?: (pool: { priceUsd: number; pairLabel: string } | null) => void;
  onMintNetworkValidChange?: (valid: boolean) => void;
  onContinue: () => void;
  canContinue: boolean;
  /** One market per token — markets already listed for this CA (owned by the
   *  WIZARD via useDuplicateMarket, since Quick Launch auto-advances and
   *  unmounts this step; `canContinue` above is already gated on it there).
   *  Non-empty renders the blocking card. */
  duplicateMarkets?: DuplicateMarket[];
}

/**
 * Step 1 — Token Mint Input + Auto-resolve card.
 * Validates the mint, fetches metadata, shows a resolved card.
 */
export const StepTokenSelect: FC<StepTokenSelectProps> = ({
  mintAddress,
  onMintChange,
  onTokenResolved,
  onBalanceChange,
  onMintNetworkValidChange,
  onContinue,
  canContinue,
  duplicateMarkets = [],
}) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [inputValue, setInputValue] = useState(mintAddress);
  const [debounced, setDebounced] = useState(mintAddress);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [mintNetworkStatus, setMintNetworkStatus] = useState<MintNetworkStatus>("idle");
  // Token program ID resolved from on-chain account owner.
  // TOKEN_PROGRAM_ID for standard SPL mints, TOKEN_2022_PROGRAM_ID for Token-2022 mints.
  // Used by the balance effect so getAssociatedTokenAddress/getAccount target the right
  // program and don't silently return zero for Token-2022 mints. GH#1261. Only ever set
  // away from the default on mainnet now — see the validation effect below.
  const [tokenProgramId, setTokenProgramId] = useState<PublicKey>(TOKEN_PROGRAM_ID);
  // Use live RPC endpoint to detect devnet (not build-time env var which may be wrong in prod).
  const isDevnet = isDevnetEndpoint(connection.rpcEndpoint) || getNetwork() === "devnet";

  // Stable refs for all callback props so that parent re-renders (e.g. wallet connection
  // events firing immediately on ?mint= navigation) don't cancel and restart the async
  // retry loops inside validation/balance effects. GH#1258: this was the root cause —
  // unstable function references in effect deps kept resetting the 3-attempt retry from 0.
  const onTokenResolvedRef = useRef(onTokenResolved);
  useEffect(() => { onTokenResolvedRef.current = onTokenResolved; });
  const onMintNetworkValidChangeRef = useRef(onMintNetworkValidChange);
  useEffect(() => { onMintNetworkValidChangeRef.current = onMintNetworkValidChange; });
  const onBalanceChangeRef = useRef(onBalanceChange);
  useEffect(() => { onBalanceChangeRef.current = onBalanceChange; });

  // Debounce mint input.
  // GH#1263: Capture `debounced` at effect-creation time so we can skip calling
  // `onMintChange` when the value hasn't actually changed. Without this guard, mounting
  // with a pre-filled mint (e.g. /create?mint=...) fires `onMintChange(sameMint)` after
  // 400 ms, which resets `mintExistsOnNetwork` to false in the parent even though
  // validation had already succeeded — permanently disabling the Continue button.
  useEffect(() => {
    const prevDebounced = debounced; // snapshot at effect-creation (stable for this run)
    const timer = setTimeout(() => {
      const trimmed = inputValue.trim();
      if (trimmed !== prevDebounced) {
        // Mint address actually changed — notify parent so it can reset validation state.
        onMintChange(trimmed);
      }
      setDebounced(trimmed);
    }, 400);
    return () => clearTimeout(timer);
    // debounced intentionally excluded from deps: we only want the value captured at the
    // start of each debounce window, not to restart the timer whenever it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputValue, onMintChange]);

  const mintIsUrl =
    debounced.startsWith("http://") ||
    debounced.startsWith("https://") ||
    debounced.includes("://");
  const mintValid = !mintIsUrl && isValidBase58Pubkey(debounced) && debounced.length >= 32;
  const mintPk = useMemo(
    () => (mintValid ? new PublicKey(debounced) : null),
    [debounced, mintValid]
  );
  const tokenMeta = useTokenMeta(mintPk);

  // On-chain mint network validation.
  //
  // DEVNET: the playground no longer creates a per-market "mirror mint". Every devnet
  // market is collateralized in the universal Sim-USDC token (app/lib/config.ts
  // testUsdcMint) — see CreateMarketWizard.tsx's collateralMintAddress — never a mint
  // derived from whatever the user pastes here. The address entered in this step is
  // therefore just a MAINNET reference CA used for metadata + DEX pricing (Step 2 /
  // useQuickLaunch resolves its DEX pool for the actual trade price); it is not expected
  // to exist as an SPL mint on devnet, so there's nothing to check on-chain and nothing to
  // mirror-create. Validity tracks whether real token metadata resolved for it — `tokenMeta`
  // (from useTokenMeta above) already does mainnet-aware resolution via Helius DAS /
  // DexScreener / on-chain Metaplex regardless of which cluster `connection` points at (see
  // lib/tokenMeta.ts) — the "propagate token meta" effect below promotes mintNetworkStatus
  // to "valid" once it settles.
  //
  // MAINNET: unchanged — verify the pasted address is a real, on-chain SPL/Token-2022 mint.
  //
  // GH#1258 fix: dependency array contains ONLY stable values (mintPk, connection, isDevnet).
  // Callbacks are accessed via refs so parent re-renders (e.g. wallet connect events on
  // ?mint= navigation) don't cancel and restart the async retry loop mid-flight.
  useEffect(() => {
    if (!mintPk) {
      setMintNetworkStatus("idle");
      onTokenResolvedRef.current(null);
      onMintNetworkValidChangeRef.current?.(false);
      setTokenProgramId(TOKEN_PROGRAM_ID);
      return;
    }
    let cancelled = false;

    if (isDevnet) {
      // Nothing to check or create on-chain — just show "loading" until tokenMeta (from
      // useTokenMeta above) settles. The "propagate token meta" effect below flips this to
      // "valid" as soon as it does.
      setMintNetworkStatus("loading");
      return () => { cancelled = true; };
    }

    // MAINNET: Check on-chain mint existence
    setMintNetworkStatus("loading");
    (async () => {
      try {
        const accountInfo = await connection.getAccountInfo(mintPk);
        if (cancelled) return;
        if (accountInfo) {
          // Account exists — verify it's a Token program mint
          const ownerKey = accountInfo.owner.toBase58();
          const isTokenMint =
            ownerKey === TOKEN_PROGRAM_ID.toBase58() ||
            ownerKey === TOKEN_2022_PROGRAM_ID.toBase58();
          if (!isTokenMint) {
            setMintNetworkStatus("invalid");
            onMintNetworkValidChangeRef.current?.(false);
            return;
          }
          // GH#1261: record resolved program ID so balance fetch targets the right program.
          setTokenProgramId(accountInfo.owner);
          setMintNetworkStatus("valid");
          onMintNetworkValidChangeRef.current?.(true);
          return;
        }
        // Account does not exist on mainnet — block
        setMintNetworkStatus("invalid");
        onMintNetworkValidChangeRef.current?.(false);
      } catch {
        if (!cancelled) {
          setMintNetworkStatus("invalid");
          onMintNetworkValidChangeRef.current?.(false);
        }
      }
    })();
    return () => { cancelled = true; };
    // GH#1258: intentionally exclude callback props — accessed via stable refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintPk, connection, isDevnet]);

  // Propagate token meta changes, and (devnet only) drive mintNetworkStatus off it — see
  // the validation effect above, which leaves devnet in "loading" until tokenMeta settles.
  // On mainnet, validity is decided entirely by that effect's on-chain check; this just
  // forwards tokenMeta upward there.
  // GH#1258: use ref for onTokenResolved so parent re-renders don't re-fire this unnecessarily.
  useEffect(() => {
    onTokenResolvedRef.current(tokenMeta);
    if (isDevnet && mintPk && tokenMeta) {
      setMintNetworkStatus("valid");
      onMintNetworkValidChangeRef.current?.(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenMeta, isDevnet, mintPk]);

  // Check wallet token balance of the entered mint.
  // GH#1260: clear loading flag so spinner doesn't get stuck when wallet disconnects or
  // mint is cleared mid-flight.
  // GH#1258: use ref for onBalanceChange to prevent parent re-renders from cancelling
  // mid-flight. Only restart on genuine address/wallet/network changes.
  // Note: on devnet the entered mint is now always a mainnet reference CA (see the
  // validation effect above) — it doesn't exist as an SPL account on devnet, so this
  // will settle to 0 there. That's fine: CreateMarketWizard's skipTokenBalanceCheck is
  // unconditionally true on devnet now (collateral is Sim-USDC, auto-funded via
  // /api/devnet-pre-fund), so this balance is purely informational, never gating.
  useEffect(() => {
    if (!publicKey || !mintValid) {
      setBalanceLoading(false);
      setBalance(null);
      onBalanceChangeRef.current(null);
      return;
    }
    // Capture mint pubkey and resolved token program ID at effect start.
    // GH#1261: tokenProgramId is set by the validation effect from accountInfo.owner so
    // Token-2022 mints derive/query against TOKEN_2022_PROGRAM_ID instead of TOKEN_PROGRAM_ID.
    const mintPkForBalance = mintPk;
    if (!mintPkForBalance) return;
    const capturedTokenProgramId = tokenProgramId;
    let cancelled = false;
    setBalanceLoading(true);
    (async () => {
      try {
        const ata = await getAssociatedTokenAddress(mintPkForBalance, publicKey, false, capturedTokenProgramId);
        const account = await getAccount(connection, ata, undefined, capturedTokenProgramId);
        if (!cancelled) {
          setBalance(account.amount);
          onBalanceChangeRef.current(account.amount);
        }
      } catch {
        if (!cancelled) {
          setBalance(0n);
          onBalanceChangeRef.current(0n);
        }
      }
      if (!cancelled) setBalanceLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // GH#1258: onBalanceChange excluded — accessed via stable ref.
    // GH#1261: tokenProgramId added so effect re-runs when validation resolves Token-2022 owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, publicKey, mintPk, mintValid, tokenProgramId]);

  const showInvalid = debounced.length > 0 && !mintValid;
  const effectiveMeta = tokenMeta;
  const showResolved = mintValid && effectiveMeta && mintNetworkStatus === "valid";
  // Block continue if mint doesn't exist on the current network or is still being checked
  const mintNetworkBlocked = mintValid && (mintNetworkStatus === "loading" || mintNetworkStatus === "invalid");
  // One market per token — an existing market for this CA blocks Continue
  // (server enforces the same rule with a 409 at registration).
  const duplicateBlocked = mintValid && duplicateMarkets.length > 0;
  const effectiveCanContinue = canContinue && !mintNetworkBlocked && !duplicateBlocked;

  return (
    <div className="space-y-5">
      <div>
        <label
          htmlFor="token-mint"
          className="block text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text)] mb-2"
        >
          Token Mint Address
        </label>
        <input
          id="token-mint"
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onBlur={() => setInputValue(inputValue.trim())}
          placeholder="Paste mint address..."
          className={`w-full border px-3 py-3 text-[12px] font-mono transition-colors focus:outline-none ${
            showInvalid
              ? "border-[var(--short)]/40 bg-[var(--short)]/[0.04] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--short)]/60"
              : "border-[var(--border)] bg-[var(--bg)] text-[var(--text)] placeholder:text-[var(--text-dim)] focus:border-[var(--accent)]/40"
          }`}
        />
        {showInvalid && (
          <p className="mt-1.5 text-[10px] text-[var(--short)]">
            {mintIsUrl
              ? "Paste a valid Solana token address, not a URL"
              : "Invalid mint address — must be a base58 Solana token address"}
          </p>
        )}
        {/* Network-level mint validation feedback */}
        {mintValid && mintNetworkStatus === "loading" && (
          <p className="mt-1.5 text-[10px] text-[var(--text-dim)] animate-pulse">
            ⏳ Checking mint on network...
          </p>
        )}
        {mintValid && mintNetworkStatus === "invalid" && (
          <p className="mt-1.5 text-[10px] text-[var(--short)]">
            ✗ Mint not found on this network — use a token that exists on the current cluster (devnet/mainnet)
          </p>
        )}
      </div>

      {/* Loading skeleton */}
      {mintValid && !tokenMeta && (
        <div className="border border-[var(--border)] bg-[var(--panel-bg)] p-4 animate-pulse">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 bg-[var(--border)]" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-24 bg-[var(--border)]" />
              <div className="h-2.5 w-48 bg-[var(--border)]" />
            </div>
          </div>
        </div>
      )}

      {/* Resolved token card */}
      {showResolved && effectiveMeta && (
        <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4">
          <div className="flex items-center gap-3">
            {/* Token avatar */}
            <div className="flex h-8 w-8 items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] text-[11px] font-bold text-[var(--accent)]">
              {effectiveMeta.symbol.slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-[var(--text)]">
                {effectiveMeta.symbol}
                <span className="ml-2 text-[11px] font-normal text-[var(--text-secondary)]">
                  {effectiveMeta.name}
                </span>
              </p>
              <p className="text-[10px] font-mono text-[var(--text-secondary)] truncate">
                {debounced.slice(0, 6)}...{debounced.slice(-4)}
              </p>
              {isDevnet && (
                <p className="text-[9px] text-[var(--accent)]/60 mt-0.5">
                  ✓ Priced off this token&apos;s mainnet DEX pool — collateral is Sim-USDC
                </p>
              )}
            </div>
          </div>
          {effectiveMeta.decimals > 12 && (
            <div className="mt-3 border border-[var(--short)]/30 bg-[var(--short)]/[0.04] px-3 py-2">
              <p className="text-[10px] text-[var(--short)] font-medium">
                ⚠ Decimals &gt; 12 risk integer overflow. Market creation blocked.
              </p>
            </div>
          )}
        </div>
      )}

      {/* One market per token — an existing market for this CA blocks the step */}
      {duplicateBlocked && (
        <div className="border border-[var(--short)]/30 bg-[var(--short)]/[0.04] p-4">
          <p className="text-[11px] font-semibold text-[var(--short)]">
            ✗ This token already has a market — one market per token
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">
            A second market would split liquidity, positions, and pricing across two
            identical-looking listings. Trade the existing market instead:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {duplicateMarkets.slice(0, 3).map((m) => (
              <Link
                key={m.slab}
                href={`/trade/${m.slab}`}
                className="border border-[var(--accent)]/40 px-3 py-1 text-[10px] font-medium text-[var(--accent)] transition-colors hover:border-[var(--accent)]/70 hover:bg-[var(--accent)]/[0.08]"
              >
                Trade {m.symbol ?? `${m.slab.slice(0, 6)}…`} →
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Balance */}
      {mintValid && !balanceLoading && balance !== null && effectiveMeta && (
        <div className="text-[11px] font-mono text-[var(--text-secondary)]">
          Wallet balance:{" "}
          <span className={balance > 0n ? "text-[var(--text)]" : "text-[var(--short)]"}>
            {formatHumanAmount(balance, effectiveMeta.decimals)} {effectiveMeta.symbol}
          </span>
        </div>
      )}
      {balanceLoading && mintValid && (
        <p className="text-[10px] text-[var(--text-dim)]">Checking wallet balance...</p>
      )}

      {/* Continue */}
      <button
        type="button"
        onClick={onContinue}
        disabled={!effectiveCanContinue}
        className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-secondary)]"
      >
        {mintNetworkStatus === "loading" ? "VALIDATING..." : "CONTINUE →"}
      </button>
    </div>
  );
};

