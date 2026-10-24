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

import { FC, ReactNode, useCallback, useMemo, useRef } from "react";
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
import { walletAdapterNetwork } from "@/lib/wallet-adapter-network";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { guardSign, noteBlockhash, SIGN_CHAIN_DEVNET } from "@/lib/v22/sign-guard";
import { sendMayHaveBroadcast } from "@/lib/tx";
import { chainSignerNote, standardDevnetSigner } from "@/lib/v22/standard-sign";

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
      // v2.2 QA NB-2: always name the deployment's network; without it the Solflare SDK assumes mainnet-beta and
      // flags every devnet transaction as "for mainnet" (lib/wallet-adapter-network.ts).
      new SolflareWalletAdapter({ network: walletAdapterNetwork(getConfig().network) }),
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
  const { connection: appConnection } = useConnectionCompat();

  // v2.2 QA NB-2: every signature goes through guardSign (devnet genesis + blockhash origin, logged), and Wallet
  // Standard wallets are told the chain. Flag off: guardSign is a pass-through and no chain signer is built.
  // The decision is taken PER REQUEST from the live adapter (`adapter.wallet.accounts` is a live getter): it used to be
  // memoised on [wallet, publicKey], i.e. frozen at connect time, so a wallet whose accounts were (re)listed later
  // (autoConnect before the Standard wallet registered, a `change` event) kept the stale answer for the whole session.
  const adapterRef = useRef<{ adapter: unknown; publicKey: typeof publicKey }>({ adapter: wallet?.adapter, publicKey });
  adapterRef.current = { adapter: wallet?.adapter, publicKey };
  const decideChain = useCallback((): { chainSigner: ReturnType<typeof standardDevnetSigner>; note: string | undefined } => {
    if (!isDevnetV22Enabled()) return { chainSigner: null, note: undefined };
    const { adapter, publicKey: pk } = adapterRef.current;
    return { chainSigner: standardDevnetSigner(adapter, pk), note: chainSignerNote(adapter, pk) };
  }, []);
  const guarded = useMemo(
    () =>
      <T,>(via: string, txs: Transaction[], d: { chainSigner: ReturnType<typeof standardDevnetSigner>; note: string | undefined }, sign: () => Promise<T>): Promise<T> =>
        guardSign({ txs, via, connection: appConnection, chain: d.chainSigner ? SIGN_CHAIN_DEVNET : "none", wrapperProgramId: cfg.programId, signerNote: d.note, sign }),
    [appConnection, cfg.programId],
  );

  const signTransaction = useMemo(() => {
    if (!adapterSignTx || !publicKey) return undefined;
    return async (tx: Transaction): Promise<Transaction> => {
      // Ensure fee payer + blockhash are set so the adapter can sign cleanly.
      if (!tx.recentBlockhash) {
        const conn = new Connection(cfg.rpcUrl, "confirmed");
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        noteBlockhash(blockhash, "wallet bridge signTransaction (tx arrived without a blockhash)", conn);
      }
      if (!tx.feePayer) {
        tx.feePayer = publicKey;
      }
      const d = decideChain();
      return guarded("adapter signTransaction", [tx], d, async () => (d.chainSigner ? (await d.chainSigner([tx]))[0] : adapterSignTx(tx)));
    };
  }, [adapterSignTx, publicKey, cfg.rpcUrl, guarded, decideChain]);

  const signAndSendTransaction = useMemo(() => {
    if (!adapterSignTx || !publicKey) return undefined;
    return async (tx: Transaction): Promise<Uint8Array> => {
      const conn = new Connection(cfg.rpcUrl, "confirmed");
      if (!tx.recentBlockhash) {
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        noteBlockhash(blockhash, "wallet bridge signAndSendTransaction (tx arrived without a blockhash)", conn);
      }
      if (!tx.feePayer) {
        tx.feePayer = publicKey;
      }
      const d = decideChain();
      const signed = await guarded("adapter signAndSendTransaction", [tx], d, async () => (d.chainSigner ? (await d.chainSigner([tx]))[0] : adapterSignTx(tx)));
      const wire = signed.serialize(); // a serialize error never left the browser
      try {
        return bs58.decode(await conn.sendRawTransaction(wire));
      } catch (e) {
        // The bytes may be on the wire: hand back the signature so sendTx confirms it instead of reporting "nothing was sent".
        if (signed.signature && sendMayHaveBroadcast(e)) return new Uint8Array(signed.signature);
        throw e;
      }
    };
  }, [adapterSignTx, publicKey, cfg.rpcUrl, guarded, decideChain]);

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
      const d = decideChain();
      return guarded("adapter signAllTransactions", txs, d, () => (d.chainSigner ? d.chainSigner(txs) : adapterSignAllTx(txs)));
    };
  }, [adapterSignAllTx, publicKey, guarded, decideChain]);

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
