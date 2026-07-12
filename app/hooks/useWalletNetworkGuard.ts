"use client";

/**
 * PERC-onboarding-5: wrong-network wallet detection.
 *
 * Devnet playground, but a connected wallet extension (Phantom/Solflare/...)
 * can independently be set to Mainnet. There's no reliable, universal way to
 * read a wallet's configured cluster through the Wallet Standard / the
 * Privy/wallet-adapter compat layer this app uses (`useWalletCompat`) — no
 * chain/cluster field is exposed by either provider bridge (see
 * hooks/useWalletCompat.ts). A wrong-network wallet also can't be detected
 * from OUR OWN devnet RPC reads (`connection.getBalance` etc. always talk to
 * OUR devnet endpoint regardless of the wallet's own setting, and 0 SOL is
 * completely normal for a brand-new devnet wallet anyway).
 *
 * So this is a best-effort, ADVISORY-ONLY signal: many wallets simulate or
 * validate a transaction against their OWN configured cluster before
 * signing/sending. When that cluster is Mainnet while this app is building
 * a devnet transaction, the failure characteristically surfaces as an
 * RPC-level blockhash/simulation error (the devnet blockhash this app
 * fetched doesn't exist on the wallet's mainnet view), not a program error.
 * Feed a transaction-send failure's raw message through `reportTxError` right
 * after a user-initiated transaction fails, and this sets a banner message
 * if it matches that signature. Never blocks anything — purely informational,
 * and the caller decides how/where to render it (this app's existing
 * humanized-banner pattern, e.g. OrderTicket.tsx's engineLockError box).
 */

import { useCallback, useState } from "react";

export interface WalletNetworkGuardState {
  /** Set when a transaction failure looks like the connected wallet is on a
   *  different Solana cluster than this app (devnet). Advisory only. */
  networkWarning: string | null;
  /** Feed a raw transaction-send error message through this after a
   *  user-initiated transaction fails. Cheap, synchronous, no side effect
   *  if the message doesn't match the wrong-network signature. */
  reportTxError: (message: string) => void;
  /** Clear a previously-set warning (e.g. once a later transaction succeeds). */
  clearNetworkWarning: () => void;
}

// Conservative on purpose: only the class of error a mismatched-cluster
// wallet's own preflight/simulation tends to produce (blockhash unknown to
// the wallet's RPC view, or a simulation failure explicitly about the
// blockhash) — NOT a bare "blockhash expired" from network congestion
// (sendTx already retries that internally; see lib/tx.ts), and not generic
// program/custom-error failures, which have their own humanized messages.
const NETWORK_MISMATCH_PATTERN =
  /blockhash not found|failed to get recent blockhash|transaction simulation failed[^]*blockhash|WalletSendTransactionError[^]*blockhash/i;

export function useWalletNetworkGuard(): WalletNetworkGuardState {
  const [networkWarning, setNetworkWarning] = useState<string | null>(null);

  const reportTxError = useCallback((message: string) => {
    if (NETWORK_MISMATCH_PATTERN.test(message)) {
      setNetworkWarning(
        "Your wallet may be set to Mainnet. Switch it to Devnet in your wallet settings, then reconnect.",
      );
    }
  }, []);

  const clearNetworkWarning = useCallback(() => setNetworkWarning(null), []);

  return { networkWarning, reportTxError, clearNetworkWarning };
}
