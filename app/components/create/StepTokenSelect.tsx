"use client";

import { FC, useState, useEffect, useMemo, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { formatHumanAmount } from "@/lib/parseAmount";
import { isValidBase58Pubkey } from "@/lib/createWizardUtils";
import { getNetwork } from "@/lib/config";

/** Derive whether we're on devnet from the live RPC endpoint (not build-time env var). */
function isDevnetEndpoint(rpcEndpoint: string): boolean {
  return rpcEndpoint.includes("devnet") || rpcEndpoint.includes("127.0.0.1") || rpcEndpoint.includes("localhost");
}

type MintNetworkStatus = "idle" | "loading" | "valid" | "invalid" | "mirroring" | "mirror-failed";

interface StepTokenSelectProps {
  mintAddress: string;
  onMintChange: (mint: string) => void;
  onTokenResolved: (meta: { name: string; symbol: string; decimals: number } | null) => void;
  onBalanceChange: (balance: bigint | null) => void;
  onDexPoolDetected?: (pool: { priceUsd: number; pairLabel: string } | null) => void;
  onMintNetworkValidChange?: (valid: boolean) => void;
  /** Called when a devnet mirror mint is created/found for a mainnet CA */
  onDevnetMintResolved?: (devnetMint: string, meta?: { name: string; symbol: string; decimals: number }) => void;
  onContinue: () => void;
  canContinue: boolean;
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
  onDevnetMintResolved,
  onContinue,
  canContinue,
}) => {
  const { publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [inputValue, setInputValue] = useState(mintAddress);
  const [debounced, setDebounced] = useState(mintAddress);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [mintNetworkStatus, setMintNetworkStatus] = useState<MintNetworkStatus>("idle");
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const [mirrorMeta, setMirrorMeta] = useState<{ name: string; symbol: string; decimals: number } | null>(null);
  // True when the mint is a devnet-native token (not a mainnet mirror). Used to suppress
  // the "🪞 Devnet mirror" label for tokens created directly on devnet (PERC-1093).
  const [isNativeDevnetMint, setIsNativeDevnetMint] = useState(false);
  // Token program ID resolved from on-chain account owner.
  // TOKEN_PROGRAM_ID for standard SPL mints, TOKEN_2022_PROGRAM_ID for Token-2022 mints.
  // Used by the balance effect so getAssociatedTokenAddress/getAccount target the right
  // program and don't silently return zero for Token-2022 mints. GH#1261.
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
  const onDevnetMintResolvedRef = useRef(onDevnetMintResolved);
  useEffect(() => { onDevnetMintResolvedRef.current = onDevnetMintResolved; });
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

  // On-chain mint existence validation — ensures the CA exists on the current network.
  // On devnet: if mint doesn't exist, auto-mirror the mainnet CA to devnet.
  //
  // GH#1258 fix: dependency array contains ONLY stable values (mintPk, connection, isDevnet).
  // Callbacks are accessed via refs so parent re-renders (e.g. wallet connect events on
  // ?mint= navigation) don't cancel and restart the async retry loop mid-flight.
  // Retries increased to 5×2s (up to 10s) for devnet RPC propagation under load.
  useEffect(() => {
    if (!mintPk) {
      setMintNetworkStatus("idle");
      setMirrorError(null);
      // PERC-1093 follow-up: unconditionally clear stale mirror state when input is cleared.
      // Without this reset, mirrorMeta stays non-null from the previous valid mint and the
      // propagation guard (tokenMeta !== null || mirrorMeta === null) silently swallows
      // onTokenResolved(null), leaving wizard.tokenMeta pointing at the old token.
      setMirrorMeta(null);
      setIsNativeDevnetMint(false);
      onTokenResolvedRef.current(null);
      onMintNetworkValidChangeRef.current?.(false);
      setTokenProgramId(TOKEN_PROGRAM_ID);
      return;
    }
    // Capture the mint address string at effect start so fetch bodies are consistent
    // even if debounced state changes (and so we can drop debounced from deps).
    const mintAddr = mintPk.toBase58();
    let cancelled = false;
    setMirrorError(null);
    setMirrorMeta(null);
    setIsNativeDevnetMint(false);

    if (isDevnet) {
      // DEVNET: First check if the mint already exists on-chain as a valid SPL token.
      // If it does (user-created devnet mint), use it directly — no mirror needed.
      // If it doesn't, call mirror-mint to create a devnet mirror from mainnet metadata.
      setMintNetworkStatus("loading");
      (async () => {
        try {
          // Step 1: Check if mint exists on devnet.
          // GH#1255 / GH#1258: Retry up to 5 times (2s apart, 10s total) to handle RPC
          // propagation delay for mints just created via Token Factory. Original 3×1.5s
          // was insufficient under devnet load; also the loop was being cancelled by
          // parent re-renders when callbacks were in the dep array (GH#1258).
          let accountInfo = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) {
              await new Promise(r => setTimeout(r, 2000));
            }
            if (cancelled) return;
            try {
              // GH#1258 follow-up: wrap in try/catch so transient RPC throws also
              // retry instead of escaping to the outer catch and skipping remaining attempts.
              accountInfo = await connection.getAccountInfo(mintPk);
            } catch (e) {
              if (attempt === 4) throw e;
              continue;
            }
            if (accountInfo) break;
          }
          if (cancelled) return;

          if (accountInfo) {
            const isTokenMint =
              accountInfo.owner.equals(TOKEN_PROGRAM_ID) ||
              accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID);

            if (isTokenMint) {
              // Mint already exists on devnet — use it directly, no mirror needed.
              // Mark as native so we don't show the "mainnet mirror" label (PERC-1093).
              // GH#1261: record resolved program ID so balance fetch targets the right program.
              setTokenProgramId(accountInfo.owner);
              const devnetMeta = {
                name: tokenMeta?.name ?? `Token ${mintAddr.slice(0, 6)}`,
                symbol: tokenMeta?.symbol ?? mintAddr.slice(0, 4).toUpperCase(),
                decimals: tokenMeta?.decimals ?? 6,
              };
              setMirrorMeta(devnetMeta);
              setIsNativeDevnetMint(true);
              onDevnetMintResolvedRef.current?.(mintAddr, devnetMeta);
              onTokenResolvedRef.current(devnetMeta);
              setMintNetworkStatus("valid");
              onMintNetworkValidChangeRef.current?.(true);

              // Best-effort: register in devnet_mints for airdrop endpoint lookup
              fetch("/api/devnet-register-mint", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  mintAddress: mintAddr,
                  name: devnetMeta.name,
                  symbol: devnetMeta.symbol,
                  decimals: devnetMeta.decimals,
                }),
              }).catch(() => {}); // fire-and-forget
              return;
            }
          }

          // Step 2: Mint not found on devnet after retries — try mirror from mainnet
          if (cancelled) return;
          setMintNetworkStatus("mirroring");
          // GH#1614: include walletAddress so /api/devnet-mirror-mint can associate
          // the mirror with the connected wallet (required field — API returns 400 without it).
          const mirrorWallet = publicKey?.toBase58() ?? null;
          const resp = await fetch("/api/devnet-mirror-mint", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mainnetCA: mintAddr, walletAddress: mirrorWallet }),
          });
          if (cancelled) return;
          const data = await resp.json();
          if (!resp.ok) {
            setMintNetworkStatus("mirror-failed");
            setMirrorError(data.error ?? `Mirror failed (HTTP ${resp.status})`);
            onMintNetworkValidChangeRef.current?.(false);
            return;
          }
          // Mirror succeeded — notify parent with the devnet mint + metadata
          const resolvedMirrorMeta = {
            name: data.name ?? `Token ${mintAddr.slice(0, 6)}`,
            symbol: data.symbol ?? mintAddr.slice(0, 4).toUpperCase(),
            decimals: data.decimals ?? 6,
          };
          setMirrorMeta(resolvedMirrorMeta);
          onDevnetMintResolvedRef.current?.(data.devnetMint, resolvedMirrorMeta);
          onTokenResolvedRef.current(resolvedMirrorMeta);
          setMintNetworkStatus("valid");
          onMintNetworkValidChangeRef.current?.(true);
        } catch {
          if (!cancelled) {
            setMintNetworkStatus("mirror-failed");
            setMirrorError("Network error — could not validate mint");
            onMintNetworkValidChangeRef.current?.(false);
          }
        }
      })();
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
    // GH#1614: publicKey added so effect re-runs when wallet connects after mint is entered,
    // enabling mirror-mint to include walletAddress on the retry attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintPk, connection, isDevnet, publicKey]);

  // Propagate token meta changes.
  // PERC-1093: Don't override an already-resolved devnet/mirror meta with null mainnet metadata.
  // The mainnet metadata API returns null for devnet-native tokens (no mainnet listing).
  // Overwriting wizard.tokenMeta with null blocks step1Valid even when mintNetworkStatus="valid".
  // Only propagate null when mirrorMeta is also null (i.e., nothing resolved yet / input cleared).
  // GH#1258: use ref for onTokenResolved so parent re-renders don't re-fire this unnecessarily.
  useEffect(() => {
    if (tokenMeta !== null || mirrorMeta === null) {
      onTokenResolvedRef.current(tokenMeta);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenMeta, mirrorMeta]);

  // Check wallet token balance.
  // GH#1256: For native devnet mints (freshly created via Token Factory), the ATA may
  // not be visible on the RPC immediately after the mint transaction confirms. Retry
  // up to 5 times with 3s delay (15s total) so balance isn't stuck at 0.
  // GH#1258: use ref for onBalanceChange to prevent parent re-renders from cancelling
  // mid-retry. Only restart on genuine address/wallet/network changes.
  useEffect(() => {
    if (!publicKey || !mintValid) {
      // GH#1260: clear loading flag so spinner doesn't get stuck when wallet disconnects
      // or mint is cleared while an ATA retry loop is in-flight.
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
      // GH#1258: increased from 3 to 5 attempts, delay 2s→3s, for devnet RPC lag.
      const MAX_ATTEMPTS = isNativeDevnetMint ? 5 : 1;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 3000));
        }
        if (cancelled) return;
        try {
          const ata = await getAssociatedTokenAddress(mintPkForBalance, publicKey, false, capturedTokenProgramId);
          const account = await getAccount(connection, ata, undefined, capturedTokenProgramId);
          if (!cancelled) {
            const amount = account.amount;
            setBalance(amount);
            onBalanceChangeRef.current(amount);
            // Got a non-zero balance — no need to retry
            if (amount > 0n) break;
          }
        } catch {
          if (!cancelled && attempt === MAX_ATTEMPTS - 1) {
            setBalance(0n);
            onBalanceChangeRef.current(0n);
          }
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
  }, [connection, publicKey, mintPk, mintValid, isNativeDevnetMint, tokenProgramId]);

  const showInvalid = debounced.length > 0 && !mintValid;
  const effectiveMeta = tokenMeta ?? mirrorMeta;
  const showResolved = mintValid && effectiveMeta && mintNetworkStatus === "valid";
  // Block continue if mint doesn't exist on the current network or is still being checked
  const mintNetworkBlocked = mintValid && (mintNetworkStatus === "loading" || mintNetworkStatus === "invalid" || mintNetworkStatus === "mirroring" || mintNetworkStatus === "mirror-failed");
  const effectiveCanContinue = canContinue && !mintNetworkBlocked;

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
        {mintValid && mintNetworkStatus === "mirroring" && (
          <p className="mt-1.5 text-[10px] text-[var(--accent)] animate-pulse">
            🪞 Mainnet token detected — creating devnet mirror...
          </p>
        )}
        {mintValid && mintNetworkStatus === "mirror-failed" && (
          <p className="mt-1.5 text-[10px] text-[var(--short)]">
            ✗ Failed to mirror mainnet token: {mirrorError ?? "Unknown error"}
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
              {mirrorMeta && !isNativeDevnetMint && (
                <p className="text-[9px] text-[var(--accent)]/60 mt-0.5">
                  🪞 Devnet mirror of mainnet token
                </p>
              )}
              {mirrorMeta && isNativeDevnetMint && (
                <p className="text-[9px] text-[var(--accent)]/60 mt-0.5">
                  ✓ Native devnet token
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
        className="w-full border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15] disabled:cursor-not-allowed disabled:border-[var(--border)] disabled:bg-transparent disabled:text-[var(--text-dim)] disabled:opacity-50"
      >
        {mintNetworkStatus === "loading" ? "VALIDATING..." : mintNetworkStatus === "mirroring" ? "MIRRORING..." : "CONTINUE →"}
      </button>
    </div>
  );
};

