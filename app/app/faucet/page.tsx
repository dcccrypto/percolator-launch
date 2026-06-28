"use client";

/**
 * Playground Faucet Page — /faucet
 *
 * Lets any connected wallet claim 10,000 Sim-USDC (+ a small SOL top-up)
 * without needing a Privy account. Works out of the box on devnet:
 *   1. Connect a Phantom / Solflare / Backpack wallet (via wallet-adapter).
 *   2. Click "Get test funds" — server mints Sim-USDC directly to the user's ATA.
 *      The mint authority is the fee payer so the user needs 0 SOL to receive tokens.
 *   3. A small SOL airdrop (~0.05) is attempted so the user can pay for
 *      subsequent transactions.
 *
 * Rate-limited: 1 claim per wallet per hour.
 */

import { FC, useState, useCallback } from "react";
import Link from "next/link";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { useWalletAdapterAvailable } from "@/hooks/useWalletAdapterAvailable";
import { usePrivyAvailable, usePrivyLogin } from "@/hooks/usePrivySafe";
import { SimUsdcBalance } from "@/components/playground/SimUsdcBalance";
import { ConnectButton } from "@/components/wallet/ConnectButton";

const SIM_USDC_MINT =
  process.env.NEXT_PUBLIC_TEST_USDC_MINT?.trim() ||
  "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

const EXPLORER_BASE = "https://explorer.solana.com/tx";

interface FaucetResult {
  usdc_amount: number;
  usdc_sig: string;
  sol_airdropped: boolean;
  sol_sig?: string;
  nextClaimAt: string;
}

interface FaucetError {
  error: string;
  nextClaimAt?: string;
  hint?: string;
}

const FaucetPage: FC = () => {
  const { publicKey, connected } = useWalletCompat();
  const adapterAvailable = useWalletAdapterAvailable();
  const privyAvailable = usePrivyAvailable();
  const privyLogin = usePrivyLogin();

  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<FaucetResult | null>(null);
  const [faucetError, setFaucetError] = useState<FaucetError | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const handleClaim = useCallback(async () => {
    if (!publicKey || loading) return;
    setLoading(true);
    setResult(null);
    setFaucetError(null);

    try {
      const resp = await fetch("/api/playground/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58() }),
      });
      const data = (await resp.json()) as Record<string, unknown>;

      if (!resp.ok) {
        setFaucetError({
          error: (data.error as string) || `HTTP ${resp.status}`,
          nextClaimAt: data.nextClaimAt as string | undefined,
          hint: data.hint as string | undefined,
        });
      } else {
        setResult({
          usdc_amount: data.usdc_amount as number,
          usdc_sig: data.usdc_sig as string,
          sol_airdropped: data.sol_airdropped as boolean,
          sol_sig: data.sol_sig as string | undefined,
          nextClaimAt: data.nextClaimAt as string,
        });
        // Refresh balance display after successful mint
        setRefreshTick((t) => t + 1);
      }
    } catch (err) {
      setFaucetError({
        error: err instanceof Error ? err.message : "Network error — please retry",
      });
    } finally {
      setLoading(false);
    }
  }, [publicKey, loading]);

  const explorerUrl = (sig: string) =>
    `${EXPLORER_BASE}/${sig}?cluster=devnet`;

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-[var(--text)]">Playground Faucet</h1>
        <p className="mt-2 text-[14px] text-[var(--text-secondary)]">
          Get 10,000 Sim-USDC to trade on devnet. No real funds required.
        </p>
        <p className="mt-1 text-[12px] font-mono text-[var(--text-muted)]">
          mint: {SIM_USDC_MINT.slice(0, 8)}...{SIM_USDC_MINT.slice(-6)}
        </p>
      </div>

      {/* Connect prompt */}
      {!connected && (
        <div className="mb-6 rounded-md border border-[var(--border)] bg-[var(--bg-elevated,var(--bg))] p-6">
          <p className="mb-4 text-[14px] text-[var(--text-secondary)]">
            Connect a wallet to get started.
          </p>
          {adapterAvailable ? (
            <ConnectButton />
          ) : privyAvailable ? (
            <button
              onClick={privyLogin}
              className="rounded-sm border border-[var(--accent)] bg-[var(--accent)]/20 px-4 py-2 text-[13px] font-medium text-[var(--text)] hover:bg-[var(--accent)]/30"
            >
              Connect Wallet
            </button>
          ) : (
            <p className="text-[13px] text-[var(--text-muted)]">
              No wallet provider configured.
            </p>
          )}
        </div>
      )}

      {/* Faucet card */}
      {connected && publicKey && (
        <div className="space-y-4">
          {/* Balance */}
          <div className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated,var(--bg))] p-4">
            <p className="mb-1 text-[12px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Your Sim-USDC balance
            </p>
            <SimUsdcBalance
              publicKey={publicKey}
              refreshTick={refreshTick}
              className="mt-1"
            />
          </div>

          {/* Claim button */}
          <button
            onClick={() => void handleClaim()}
            disabled={loading || !!result}
            className={[
              "w-full rounded-sm border px-4 py-3 text-[14px] font-medium transition-all",
              loading || result
                ? "cursor-not-allowed border-[var(--border)] text-[var(--text-muted)] opacity-60"
                : "border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--text)] hover:bg-[var(--accent)]/30",
            ].join(" ")}
          >
            {loading ? "Minting..." : result ? "Claimed" : "Get 10,000 Sim-USDC"}
          </button>

          {/* Success result */}
          {result && (
            <div className="rounded-md border border-[var(--long)]/30 bg-[var(--long)]/[0.06] p-4 text-[13px]">
              <p className="font-semibold text-[var(--long)]">
                {result.usdc_amount.toLocaleString()} Sim-USDC minted
              </p>
              <p className="mt-1 text-[var(--text-secondary)]">
                Transaction:{" "}
                <a
                  href={explorerUrl(result.usdc_sig)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono underline hover:text-[var(--accent)]"
                >
                  {result.usdc_sig.slice(0, 8)}...
                </a>
              </p>
              {result.sol_airdropped && result.sol_sig && (
                <p className="mt-1 text-[var(--text-secondary)]">
                  SOL airdrop:{" "}
                  <a
                    href={explorerUrl(result.sol_sig)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono underline hover:text-[var(--accent)]"
                  >
                    {result.sol_sig.slice(0, 8)}...
                  </a>
                </p>
              )}
              {!result.sol_airdropped && (
                <p className="mt-1 text-[var(--text-muted)] text-[12px]">
                  SOL airdrop skipped (public faucet busy). Try{" "}
                  <a
                    href="https://faucet.solana.com"
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-[var(--accent)]"
                  >
                    faucet.solana.com
                  </a>{" "}
                  for devnet SOL.
                </p>
              )}
              <p className="mt-2 text-[12px] text-[var(--text-muted)]">
                Next claim:{" "}
                {result.nextClaimAt
                  ? new Date(result.nextClaimAt).toLocaleString()
                  : "in 1 hour"}
              </p>
            </div>
          )}

          {/* Error */}
          {faucetError && (
            <div className="rounded-md border border-[var(--short)]/30 bg-[var(--short)]/[0.06] p-4 text-[13px]">
              <p className="font-medium text-[var(--short)]">{faucetError.error}</p>
              {faucetError.hint === "missing_keypair" && (
                <p className="mt-1 text-[var(--text-muted)]">
                  Set <code className="font-mono">DEVNET_MINT_AUTHORITY_KEYPAIR</code> in{" "}
                  <code className="font-mono">.env.local</code> to enable live minting.
                </p>
              )}
              {faucetError.nextClaimAt && (
                <p className="mt-1 text-[var(--text-muted)]">
                  Next claim: {new Date(faucetError.nextClaimAt).toLocaleString()}
                </p>
              )}
              {!faucetError.nextClaimAt && (
                <button
                  onClick={() => setFaucetError(null)}
                  className="mt-2 text-[12px] underline text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}

          {/* Nav */}
          <div className="flex gap-4 pt-2">
            <Link
              href="/markets"
              className="text-[13px] text-[var(--text-secondary)] underline hover:text-[var(--text)]"
            >
              Browse markets
            </Link>
            <Link
              href="/trade"
              className="text-[13px] text-[var(--text-secondary)] underline hover:text-[var(--text)]"
            >
              Start trading
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};

export default FaucetPage;
