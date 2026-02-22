"use client";

/**
 * Compatibility layer: provides the same interface as @solana/wallet-adapter-react
 * useWallet() and useConnection() but backed by Privy.
 *
 * This allows existing hooks (useTrade, useDeposit, etc.) to migrate with minimal
 * changes — just swap the import from wallet-adapter to this file.
 */

import { useMemo } from "react";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import { getConfig } from "@/lib/config";

export interface WalletCompat {
  publicKey: PublicKey | null;
  connected: boolean;
  signTransaction: ((tx: Transaction) => Promise<Transaction>) | null;
  signAllTransactions: ((txs: Transaction[]) => Promise<Transaction[]>) | null;
  /** Raw Privy wallet reference for sign-and-send flows */
  privyWallet: ReturnType<typeof useWallets>["wallets"][number] | null;
}

/**
 * Drop-in replacement for `useWallet()` from @solana/wallet-adapter-react.
 */
export function useWalletCompat(): WalletCompat {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction: privySignTx } = useSignTransaction();

  return useMemo(() => {
    if (!ready || !authenticated || wallets.length === 0) {
      return {
        publicKey: null,
        connected: false,
        signTransaction: null,
        signAllTransactions: null,
        privyWallet: null,
      };
    }

    // Prefer external wallet (Phantom, Backpack), fall back to embedded
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wallet =
      wallets.find((w) => (w as any).walletClientType !== "privy") ??
      wallets[0];

    const publicKey = new PublicKey(wallet.address);

    const signTransaction = async (tx: Transaction): Promise<Transaction> => {
      const serialized = tx.serialize({ requireAllSignatures: false });
      const { signedTransaction } = await privySignTx({
        transaction: serialized,
        wallet,
      });
      return Transaction.from(signedTransaction);
    };

    const signAllTransactions = async (txs: Transaction[]): Promise<Transaction[]> => {
      const signed: Transaction[] = [];
      for (const tx of txs) {
        signed.push(await signTransaction(tx));
      }
      return signed;
    };

    return {
      publicKey,
      connected: true,
      signTransaction,
      signAllTransactions,
      privyWallet: wallet,
    };
  }, [ready, authenticated, wallets, privySignTx]);
}

/**
 * Drop-in replacement for `useConnection()` from @solana/wallet-adapter-react.
 */
export function useConnectionCompat(): { connection: Connection } {
  const connection = useMemo(() => {
    const url = getConfig().rpcUrl;
    const rpc = url && url.startsWith("http") ? url : "https://api.devnet.solana.com";
    return new Connection(rpc, "confirmed");
  }, []);

  return { connection };
}
