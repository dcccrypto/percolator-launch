"use client";

import { createContext } from "react";
import type { PublicKey, Transaction } from "@solana/web3.js";

/**
 * Unified wallet API — the exact shape `useWalletCompat()` has always returned.
 *
 * Providers (Privy / wallet-adapter) compute this object and inject it via
 * context, so consumers never import a wallet SDK directly. This is what keeps
 * the heavy `@privy-io/react-auth` graph — and its transitive WalletConnect /
 * Coinbase / viem / ethers deps — OUT of the shared client bundle: only the
 * already-`dynamic()` `PrivyProviderClient` imports Privy; every other module
 * (the 60+ `useWalletCompat()` call sites) just reads this context.
 */
export interface WalletApi {
  publicKey: PublicKey | null;
  connected: boolean;
  connecting: boolean;
  /** Active wallet object (Privy `WalletWithMetadata` or adapter `Wallet`). Not
   *  read for sub-properties by any shared consumer, so intentionally opaque. */
  wallet: unknown;
  signTransaction: ((tx: Transaction) => Promise<Transaction>) | undefined;
  signAndSendTransaction: ((tx: Transaction) => Promise<Uint8Array>) | undefined;
  signMessage: ((message: Uint8Array) => Promise<Uint8Array>) | undefined;
  /**
   * Batch-sign N independent transactions in ONE wallet approval. Optional —
   * not every wallet/adapter exposes it. Callers (see lib/tx.ts's
   * `signAllCompat`) MUST fall back to N sequential `signTransaction` calls
   * when this is undefined, so batching is purely additive: it never removes
   * a capability the sequential flow already had.
   */
  signAllTransactions: ((txs: Transaction[]) => Promise<Transaction[]>) | undefined;
  disconnect: () => Promise<void>;
}

/** Read-only default — used when neither wallet provider is mounted. */
export const READ_ONLY_WALLET_API: WalletApi = {
  publicKey: null,
  connected: false,
  connecting: false,
  wallet: null,
  signTransaction: undefined,
  signAndSendTransaction: undefined,
  signMessage: undefined,
  signAllTransactions: undefined,
  disconnect: async () => {},
};

export const WalletApiContext = createContext<WalletApi>(READ_ONLY_WALLET_API);
