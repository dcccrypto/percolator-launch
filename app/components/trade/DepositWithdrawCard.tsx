"use client";
import { explorerTxUrl } from "@/lib/config";
import { prewarmTxLanding } from "@/lib/tx";

import { FC, useState, useEffect, useRef } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { DevnetTokenFaucetButton } from "./DevnetTokenFaucetButton";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useDeposit } from "@/hooks/useDeposit";
import { useWithdraw } from "@/hooks/useWithdraw";
import { useInitUser } from "@/hooks/useInitUser";
import { AUTO_DEPOSIT_AMOUNT } from "@/hooks/useAutoDeposit";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { parseHumanAmount } from "@/lib/parseAmount";
import { formatTokenAmount } from "@/lib/format";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { isSentinelValue } from "@/lib/health";
import { useConvertibleProfit } from "@/hooks/useConvertibleProfit";
import { settlingProfitMessage } from "@/lib/convert-released-pnl";
import { useWalletBalanceRefreshKey } from "@/lib/wallet-balance-invalidation";

interface DepositWithdrawCardProps {
  slabAddress: string;
  isDevnetMirror?: boolean;
  /** Tab to show; the parent can change it while the card is open (e.g. the
   *  order-ticket footer's separate Deposit / Withdraw triggers). The in-card
   *  tabs still switch modes locally. */
  initialMode?: "deposit" | "withdraw";
  /** The order ticket's "Get test funds": the wallet holds some collateral but less than the
   *  order needs, so offer the faucet even though the balance is not 0. */
  offerFaucet?: boolean;
}

function sanitizeDecimalInput(value: string): string {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const dotIndex = cleaned.indexOf(".");
  if (dotIndex === -1) return cleaned;
  return cleaned.slice(0, dotIndex + 1) + cleaned.slice(dotIndex + 1).replace(/\./g, "");
}

export const DepositWithdrawCard: FC<DepositWithdrawCardProps> = ({ slabAddress, isDevnetMirror = false, initialMode = "deposit", offerFaucet = false }) => {
  const { connected: walletConnected, publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const connected = walletConnected || mockMode;
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const { deposit, loading: depositLoading, error: depositError } = useDeposit(slabAddress);
  const { withdraw, loading: withdrawLoading, error: withdrawError } = useWithdraw(slabAddress);
  const { initUser, loading: initLoading, error: initError } = useInitUser(slabAddress);
  const { config: mktConfig } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const symbol = tokenMeta?.symbol ?? "Token";

  const [mode, setMode] = useState<"deposit" | "withdraw">(initialMode);
  const [amount, setAmount] = useState("");

  // Prewarm the tx-landing caches (blockhash, priority fee, clock drift) the
  // moment this card appears — the user types an amount before submitting,
  // and that time absorbs the fetches, so the deposit/withdraw click reaches
  // the wallet popup without blocking on them. Fire-and-forget; sendTx falls
  // back to live fetches if any prewarm failed.
  useEffect(() => {
    if (!mockMode && walletConnected) prewarmTxLanding(connection);
  }, [connection, mockMode, walletConnected]);
  const [lastSig, setLastSig] = useState<string | null>(null);
  // A faucet claim (inline button or the global modal) changes none of the deps above.
  const walletBalanceKey = useWalletBalanceRefreshKey();

  type WalletBalanceSnapshot = {
    scopeKey: string;
    amount: bigint | null;
    decimals: number | null;
  };

  const walletBalanceScopeKey =
    publicKey && mktConfig?.collateralMint
      ? `${publicKey.toBase58()}:${mktConfig.collateralMint.toBase58()}`
      : null;

  const [walletBalanceSnapshot, setWalletBalanceSnapshot] = useState<WalletBalanceSnapshot | null>(
    null,
  );

  const walletBalance = mockMode
    ? 500_000_000n
    : walletBalanceSnapshot?.scopeKey === walletBalanceScopeKey
      ? walletBalanceSnapshot.amount
      : null;

  const maxRawRef = useRef<bigint | null>(null);

  // A typed or Max-derived amount belongs to the wallet/mint scope that
  // produced it. Clear both representations immediately after that scope
  // changes so a replacement wallet cannot submit the previous value.
  useEffect(() => {
    maxRawRef.current = null;
    setAmount("");
  }, [walletBalanceScopeKey]);

  const onChainDecimals =
    !mockMode && walletBalanceSnapshot?.scopeKey === walletBalanceScopeKey
      ? walletBalanceSnapshot.decimals
      : null;

  const decimals = onChainDecimals ?? tokenMeta?.decimals ?? 6;

  // Keep the mode-specific MAX raw value from leaking across Deposit/Withdraw.
  // MAX stores exact BigInt precision in maxRawRef, so switching tabs must clear
  // both the display amount and the raw ref before the opposite action can submit.
  useEffect(() => {
    setMode(initialMode);
    setAmount('');
    maxRawRef.current = null;
  }, [initialMode]);

  const switchMode = (nextMode: 'deposit' | 'withdraw') => {
    if (nextMode === mode) return;
    maxRawRef.current = null;
    setAmount('');
    setMode(nextMode);
  };
  useEffect(() => {
    if (mockMode) return;

    if (!publicKey || !mktConfig?.collateralMint || !walletBalanceScopeKey) {
      setWalletBalanceSnapshot(null);
      return;
    }

    const requestScopeKey = walletBalanceScopeKey;
    let cancelled = false;

    // Immediately invalidate a snapshot owned by a different wallet or mint.
    // Same-scope refreshes retain their verified value while a post-transaction
    // balance refresh is pending.
    setWalletBalanceSnapshot((current) =>
      current?.scopeKey === requestScopeKey
        ? current
        : {
            scopeKey: requestScopeKey,
            amount: null,
            decimals: null,
          },
    );

    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(mktConfig.collateralMint, publicKey);

        const info = await connection.getTokenAccountBalance(ata);

        if (!cancelled && info.value.amount) {
          setWalletBalanceSnapshot({
            scopeKey: requestScopeKey,
            amount: BigInt(info.value.amount),
            decimals: info.value.decimals ?? null,
          });
        }
      } catch {
        if (!cancelled) {
          setWalletBalanceSnapshot({
            scopeKey: requestScopeKey,
            amount: null,
            decimals: null,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mockMode, publicKey, mktConfig?.collateralMint, walletBalanceScopeKey, connection, lastSig, walletBalanceKey]);

  // Pre-fill deposit: the FIRST time this card is open for a brand-new
  // (0-capital) account with a known wallet balance, default the amount
  // field to min(walletBalance, the 500 USDC starter cap) instead of making
  // the user type a number before they can even see what "Max" would give
  // them. Only ever runs once per mount (prefilledRef) — after that, the
  // field is the user's own to edit/clear, including clearing it back to
  // empty on purpose. Gated to the Deposit tab and to a truly untouched
  // field so it never clobbers a value the user is mid-typing.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current) return;
    if (mode !== "deposit") return;
    if (amount !== "" || maxRawRef.current !== null) return;
    if (walletBalance == null) return; // wait for a real balance read
    const capitalNow = userAccount?.account.capital ?? 0n;
    if (capitalNow !== 0n) return; // only for never-funded accounts
    // Nothing to prefill yet. Don't latch: an empty wallet funded from the faucet should
    // still get the starter amount once the balance arrives.
    if (walletBalance <= 0n) return;
    prefilledRef.current = true;
    const prefillAmt = walletBalance < AUTO_DEPOSIT_AMOUNT ? walletBalance : AUTO_DEPOSIT_AMOUNT;
    setAmount(formatTokenAmount(prefillAmt, decimals));
  }, [mode, amount, walletBalance, userAccount, decimals]);

  // Released profit the program would move into capital for a withdraw (tag 28, prepended
  // by useWithdraw). Withdraw is capital-only on-chain, so without this a flat winner's
  // profit would never show as withdrawable. Hook runs before the early returns below.
  const convertQuote = useConvertibleProfit(
    slabAddress,
    mockMode ? undefined : userAccount?.pubkey,
    userAccount?.account.capital ?? 0n,
    userAccount && !isSentinelValue(userAccount.account.pnl) ? userAccount.account.pnl : 0n,
    (userAccount?.account.positionSize ?? 0n) !== 0n,
  );

  if (!connected) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <p className="text-[11px] text-[var(--text-muted)]">Connect wallet</p>
      </div>
    );
  }

  // "Get test funds" opens this card when the wallet holds some collateral but less than the order
  // needs; the faucet blocks below only show at a 0 balance, which left that button a dead end.
  const moreFundsFaucet = offerFaucet && walletBalance !== null && walletBalance > 0n && mktConfig?.collateralMint ? (
    <div data-testid="more-funds-faucet" className="mb-2 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-2 space-y-2">
      <p className="text-[10px] text-[var(--warning)]">Need more {symbol} for this order.</p>
      <DevnetTokenFaucetButton mintAddress={mktConfig.collateralMint.toBase58()} symbol={symbol} />
    </div>
  ) : null;

  if (!userAccount) {
    const hasTokens = walletBalance !== null && walletBalance > 0n;
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <p className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Create Account</p>
        {walletBalance !== null && (
          <p className="mb-2 text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
            Wallet: {formatTokenAmount(walletBalance, decimals, 3)} {symbol}
          </p>
        )}
        {moreFundsFaucet}
        {!hasTokens && (
          <div className="mb-2 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-2 space-y-2">
            <p className="text-[10px] text-[var(--warning)]">
              You need {symbol} tokens to trade this market.
            </p>
            {/* GH#1367: Show faucet button for all devnet markets.
                DevnetTokenFaucetButton self-corrects to a faucet link for non-mirror mints. */}
            {mktConfig?.collateralMint && (
              <DevnetTokenFaucetButton
                mintAddress={mktConfig.collateralMint.toBase58()}
                symbol={symbol}
              />
            )}
          </div>
        )}
        {hasTokens ? (
          <>
            <p className="mb-2 text-[10px] text-[var(--text-secondary)]">
              Create your trading account on this market, then deposit to trade.
            </p>
            <button
              onClick={async () => {
                try {
                  // Account only (#2424: the starter deposit is user-chosen). The deposit
                  // form this card shows next is prefilled, editable and balance-checked.
                  const result = await initUser(0n);
                  setLastSig(result?.sig ?? null);
                } catch {
                  // initError state is set by the hook and shown below
                }
              }}
              disabled={initLoading}
              className="w-full rounded-none bg-[var(--accent)] py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-white hover:bg-[var(--accent-muted)] hover:scale-[1.01] active:scale-[0.99] transition-transform disabled:opacity-50"
            >
              {initLoading ? "Creating account..." : "Create Trading Account"}
            </button>
          </>
        ) : (
          <>
            <p className="mb-2 text-[10px] text-[var(--text-secondary)]">
              Get tokens first, then create your account.
            </p>
            <button
              disabled
              className="w-full rounded-none bg-[var(--bg-surface)] py-2 text-[10px] font-medium text-[var(--text-muted)] cursor-not-allowed opacity-50"
            >
              Create Account
            </button>
          </>
        )}
        {initError && <p className="mt-2 text-[10px] text-[var(--short)]">{initError}</p>}
        {lastSig && <p className="mt-2 text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>Tx: {lastSig.slice(0, 12)}...</p>}
      </div>
    );
  }

  const capital = userAccount.account.capital;
  const positionSize = userAccount.account.positionSize ?? 0n;
  const hasOpenPosition = positionSize !== 0n;
  // The engine refuses EVERY withdrawal while a position is open, and useWithdraw
  // blocks it up front (OPEN_POSITION_WITHDRAW_MESSAGE), so nothing is withdrawable
  // until the position is closed: no Max, and any amount reads as blocked.
  // Flat: capital plus the released profit tag 28 would convert in the same tx.
  const withdrawable = hasOpenPosition
    ? 0n
    : convertQuote?.status === "ready" && convertQuote.postCapital > capital
      ? convertQuote.postCapital
      : capital;
  const settlingProfitLine = !hasOpenPosition && convertQuote?.status === "settling"
    ? settlingProfitMessage(convertQuote.code)
    : null;
  const loading = mode === "deposit" ? depositLoading : withdrawLoading;
  const error = mode === "deposit" ? depositError : withdrawError;
  const isDepositBalanceUnverified =
    !mockMode && mode === "deposit" && walletBalance === null;

  let parsedAmount: bigint = 0n;
  let parseError: string | null = null;
  if (maxRawRef.current !== null) {
    parsedAmount = maxRawRef.current;
  } else if (amount) {
    try {
      parsedAmount = parseHumanAmount(amount, decimals);
    } catch {
      parseError = `Too many decimal places (max ${decimals})`;
    }
  }
  const isOverWithdraw = !parseError && mode === "withdraw" && parsedAmount > 0n && parsedAmount > withdrawable;
  const isOverDeposit = !parseError && mode === "deposit" && parsedAmount > 0n && walletBalance !== null && parsedAmount > walletBalance;
  const validationError = parseError
    ? parseError
    : isOverWithdraw
    ? (hasOpenPosition ? "Close your position to withdraw" : "Insufficient capital")
    : isOverDeposit
    ? "Insufficient wallet balance"
    : null;

  async function handleSubmit() {
    if (!amount || !userAccount || validationError || isDepositBalanceUnverified) return;
    if (mockMode) { setAmount(""); return; }
    try {
      const amtNative = maxRawRef.current ?? parseHumanAmount(amount, decimals);
      if (amtNative <= 0n) return;
      let sig: string | undefined;
      if (mode === "deposit") {
        // accountExists=true: DepositWithdrawCard only renders when userAccount !== null,
        // so the account is confirmed by SlabProvider. Skips the stale-slab re-check in
        // useDeposit that would incorrectly prepend a duplicate InitUser. (P0 race fix)
        sig = await deposit({ userIdx: userAccount.idx, amount: amtNative, accountExists: true, portfolioPk: userAccount.pubkey });
      } else {
        sig = await withdraw({ userIdx: userAccount.idx, amount: amtNative, portfolioPk: userAccount.pubkey });
      }
      setLastSig(sig ?? null);
      maxRawRef.current = null;
      setAmount("");
    } catch (err) {
      if (process.env.NODE_ENV === 'development') {
        console.error(`${mode} failed:`, err);
      }
      // Error state is already handled by deposit/withdraw hooks
    }
  }

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      {/* Onboarding hint for new users */}
      {capital === 0n && !mockMode && (
        <div className="mb-3 border-b border-[var(--border)]/30 pb-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] mb-1">Getting Started</p>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            Deposit collateral to start trading. Your collateral is the token you&apos;ll use as margin for leveraged positions.
          </p>
        </div>
      )}

      {/* Balance overview */}
      <div className="mb-3 grid grid-cols-2 gap-px border border-[var(--border)]/20">
        <div className="p-2">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Account Balance</p>
          {/* 3dp display only — the MAX buttons below still use full raw precision */}
          <p data-testid="account-balance" className="text-sm font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(hasOpenPosition ? capital : withdrawable, decimals, 3)} <span className="text-[10px] font-normal text-[var(--text-secondary)]">{symbol}</span></p>
        </div>
        <div className="p-2 border-l border-[var(--border)]/20">
          <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">Wallet Balance</p>
          <p className="text-sm font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{walletBalance !== null ? formatTokenAmount(walletBalance, decimals, 3) : "—"} <span className="text-[10px] font-normal text-[var(--text-secondary)]">{symbol}</span></p>
        </div>
      </div>
      {mode === "deposit" && moreFundsFaucet}
      {mode === "deposit" && walletBalance !== null && walletBalance === 0n && mktConfig?.collateralMint && (
        <div className="mb-2 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-2 space-y-2">
          <p className="text-[10px] text-[var(--warning)]">
            Wallet has 0 {symbol}. You may have a different token with the same name.
          </p>
          {/* PERC-475: Devnet mirror market — self-service faucet button */}
          {isDevnetMirror ? (
            <DevnetTokenFaucetButton
              mintAddress={mktConfig.collateralMint.toBase58()}
              symbol={symbol}
            />
          ) : (
            <a
              href={mktConfig?.collateralMint ? `/devnet-mint?mint=${mktConfig.collateralMint.toBase58()}&symbol=${encodeURIComponent(symbol)}` : "/devnet-mint"}
              className="text-[10px] text-[var(--warning)] underline underline-offset-2 hover:text-[var(--warning)]/80"
            >
              Mint more →
            </a>
          )}
          <p className="text-[9px] text-[var(--text-secondary)] break-all" style={{ fontFamily: "var(--font-mono)" }}>
            Mint: {mktConfig.collateralMint.toBase58()}
          </p>
        </div>
      )}

      <div className="mb-2 flex gap-1">
        <button data-testid="deposit-tab" onClick={() => switchMode("deposit")} className={`flex-1 rounded-none py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] ${mode === "deposit" ? "bg-[var(--accent)] text-white" : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}>Deposit</button>
        <button data-testid="withdraw-tab" onClick={() => switchMode("withdraw")} className={`flex-1 rounded-none py-1.5 text-[10px] font-medium uppercase tracking-[0.1em] ${mode === "withdraw" ? "bg-[var(--warning)] text-[var(--bg)]" : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}>Withdraw</button>
      </div>

      <div className="mb-2">
        <div className="relative">
          <input
            type="text"
            data-testid={`${mode}-amount-input`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              const newValue = sanitizeDecimalInput(e.target.value);
              if (newValue !== amount) {
                maxRawRef.current = null;
              }
              setAmount(newValue);
            }}
            placeholder={`Amount (${symbol})`}
            style={{ fontFamily: "var(--font-mono)" }}
            className="w-full rounded-none border border-[var(--border)]/50 bg-[var(--bg)] px-3 py-2 pr-14 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
          />
          {mode === "withdraw" && withdrawable > 0n && (
            <button
              type="button"
              // Only rendered flat (withdrawable is 0 with a position open):
              // capital plus the released profit that converts to capital
              // in the same transaction.
              onClick={() => { maxRawRef.current = withdrawable; setAmount(formatTokenAmount(withdrawable, decimals)); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-none px-2 py-0.5 text-[9px] font-semibold uppercase text-[var(--accent)] hover:bg-[var(--accent)]/10"
            >
              Max
            </button>
          )}
          {mode === "deposit" && walletBalance !== null && walletBalance > 0n && (
            <button
              type="button"
              onClick={() => { maxRawRef.current = walletBalance; setAmount(formatTokenAmount(walletBalance, decimals)); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-none px-2 py-0.5 text-[9px] font-semibold uppercase text-[var(--accent)] hover:bg-[var(--accent)]/10"
            >
              Max
            </button>
          )}
        </div>
        {validationError && (
          <p className="mt-1 text-[10px] text-[var(--short)]">{validationError}</p>
        )}
        {mode === "withdraw" && settlingProfitLine && (
          <p data-testid="settling-profit" className="mt-1 text-[10px] text-[var(--text-secondary)]">{settlingProfitLine}</p>
        )}
      </div>

      {mode === "withdraw" && hasOpenPosition && (
        <div className="mb-2 border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-2 space-y-1">
          <p data-testid="withdraw-position-open" className="text-[10px] text-[var(--warning)]">Close your position to withdraw.</p>
          <p className="text-[10px] text-[var(--text-secondary)]">
            Your balance backs the open position, and this market can&apos;t release any of it
            until the position is fully closed. Then the whole balance is withdrawable.
          </p>
        </div>
      )}

      <button
        onClick={handleSubmit}
        data-testid={`${mode}-submit`}
        disabled={loading || !amount || !!validationError || isDepositBalanceUnverified}
        className={`w-full rounded-none py-2 text-[10px] font-medium uppercase tracking-[0.1em] hover:scale-[1.01] active:scale-[0.99] transition-transform disabled:cursor-not-allowed disabled:opacity-50 ${mode === "deposit" ? "bg-[var(--accent)] text-white hover:brightness-110" : "bg-[var(--warning)] text-[var(--bg)] hover:brightness-110"}`}
      >
        {loading ? "Sending..." : validationError ? validationError : mode === "deposit" ? `Deposit ${symbol}` : `Withdraw ${symbol}`}
      </button>

      {error && <p data-testid={`${mode}-error`} className="mt-2 text-[10px] text-[var(--short)]">{error}</p>}
      {lastSig && <p className="mt-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>Tx: <a href={`${explorerTxUrl(lastSig)}`} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">{lastSig.slice(0, 12)}...</a></p>}
    </div>
  );
};
