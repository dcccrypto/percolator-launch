"use client";

/**
 * WalletAdapterProviderClient
 *
 * Client-only wallet-adapter provider for universal wallet connect (Phantom, Solflare, Backpack,
 * any Wallet Standard compatible browser extension).
 *
 * Mounted by WalletProvider when NEXT_PUBLIC_PRIVY_APP_ID is not set so that anyone
 * can connect a browser wallet without a Privy account.
 *
 * autoConnect: true — re-connects the last used wallet on page load (standard UX).
 */

import { FC, ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { Connection, Transaction } from "@solana/web3.js";
// bs58 v6: default export is the codec object
import _bs58 from "bs58";
import { getConfig } from "@/lib/config";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";

const bs58 = _bs58 as { decode(str: string): Uint8Array };

interface Props {
  children: ReactNode;
}

export const WalletAdapterProviderClient: FC<Props> = ({ children }) => {
  const endpoint = useMemo(() => {
    return getConfig().rpcUrl || "https://api.devnet.solana.com";
  }, []);

  const wallets = useMemo(
    () => [
      // Legacy adapter that auto-detects the extension. Wallet Standard wallets
      // (modern Phantom / Solflare / Backpack) self-register via the standard
      // adapter bridge. Phantom's legacy adapter is intentionally omitted — Phantom
      // is always Standard-compliant now and double-registering logs a console
      // warning ("Phantom was registered as a Standard Wallet…") on every load.
      new SolflareWalletAdapter(),
    ],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <AdapterWalletApiBridge>{children}</AdapterWalletApiBridge>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
};

/**
 * Computes the unified WalletApi from wallet-adapter's `useWallet()` and injects
 * it via WalletApiContext, matching the Privy bridge's shape so all
 * `useWalletCompat()` consumers work unchanged. Ported verbatim from the former
 * `useWalletCompatAdapterInner` in useWalletCompat.ts.
 */
const AdapterWalletApiBridge: FC<{ children: ReactNode }> = ({ children }) => {
  const {
    publicKey,
    connected,
    connecting,
    wallet,
    signTransaction: adapterSignTx,
    signAllTransactions: adapterSignAllTx,
    signMessage: adapterSignMessage,
    disconnect,
  } = useWallet();

  const cfg = getConfig();

  const signTransaction = useMemo(() => {
    if (!adapterSignTx || !publicKey) return undefined;
    return async (tx: Transaction): Promise<Transaction> => {
      // Ensure fee payer + blockhash are set so the adapter can sign cleanly.
      if (!tx.recentBlockhash) {
        const conn = new Connection(cfg.rpcUrl, "confirmed");
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
      }
      if (!tx.feePayer) {
        tx.feePayer = publicKey;
      }
      return adapterSignTx(tx);
    };
  }, [adapterSignTx, publicKey, cfg.rpcUrl]);

  const signAndSendTransaction = useMemo(() => {
    if (!adapterSignTx || !publicKey) return undefined;
    return async (tx: Transaction): Promise<Uint8Array> => {
      const conn = new Connection(cfg.rpcUrl, "confirmed");
      if (!tx.recentBlockhash) {
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
      }
      if (!tx.feePayer) {
        tx.feePayer = publicKey;
      }
      const signed = await adapterSignTx(tx);
      const sig = await conn.sendRawTransaction(signed.serialize());
      return bs58.decode(sig);
    };
  }, [adapterSignTx, publicKey, cfg.rpcUrl]);

  /**
   * signAllTransactions: the market-launch batching fast path's primary sign
   * method (one popup for the whole batch instead of N). Native on most
   * Wallet Standard adapters (Phantom, Solflare, Backpack) — just ensure fee
   * payer is set on each tx the same way `signTransaction` above does, since
   * callers build these with `lib/tx.ts`'s `buildBatchTx` which already sets
   * both blockhash and feePayer, but this defends the same way for any
   * caller that doesn't.
   */
  const signAllTransactions = useMemo(() => {
    if (!adapterSignAllTx || !publicKey) return undefined;
    return async (txs: Transaction[]): Promise<Transaction[]> => {
      for (const tx of txs) {
        if (!tx.feePayer) tx.feePayer = publicKey;
      }
      return adapterSignAllTx(txs);
    };
  }, [adapterSignAllTx, publicKey]);

  const api = useMemo<WalletApi>(
    () => ({
      publicKey,
      connected,
      connecting,
      wallet,
      signTransaction,
      signAndSendTransaction,
      /** signMessage: available on most Wallet Standard adapters (Phantom, Solflare). */
      signMessage: adapterSignMessage,
      signAllTransactions,
      disconnect,
    }),
    [publicKey, connected, connecting, wallet, signTransaction, signAndSendTransaction, adapterSignMessage, signAllTransactions, disconnect],
  );

  return <WalletApiContext.Provider value={api}>{children}</WalletApiContext.Provider>;
};

export default WalletAdapterProviderClient;
