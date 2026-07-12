"use client";

import { FC, ReactNode, useMemo } from "react";
import { PrivyProvider, usePrivy, type WalletListEntry } from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useWallets,
  useSignTransaction,
  useSignAndSendTransaction,
  useSignMessage,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { PublicKey, Transaction } from "@solana/web3.js";
import { SentryUserContext } from "@/components/providers/SentryUserContext";
import { PrivyLoginContext } from "@/hooks/usePrivySafe";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { usePreferredWallet, resolveActiveWallet } from "@/hooks/usePreferredWallet";
import { getNetwork } from "@/lib/config";

/**
 * Client-only Privy provider wrapper. Loaded via next/dynamic with ssr:false
 * to prevent Privy SDK from crashing during server-side rendering.
 */
const PrivyProviderClient: FC<{ appId: string; children: ReactNode }> = ({
  appId,
  children,
}) => {
  const solanaConnectors = useMemo(() => toSolanaWalletConnectors(), []);
  const walletConnectCloudProjectId =
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  const walletList = useMemo<WalletListEntry[]>(
    () => ["phantom", "solflare", "backpack", "jupiter", "detected_solana_wallets"],
    []
  );

  // Privy v3 requires explicit Solana RPC config for embedded wallet transactions.
  // IMPORTANT: Privy always needs solana:mainnet RPC present — even in devnet mode —
  // otherwise initialization fails with "No RPC configuration found for chain solana:mainnet".
  // We provide BOTH chains so Privy initializes correctly. The correct chain for
  // transactions is selected via the explicit `chain` parameter on signTransaction /
  // signAndSendTransaction calls (see useWalletCompat.ts), NOT by limiting rpcs.
  const solanaRpcs = useMemo(() => {
    // PERC-469: Route all Privy RPC calls through the /api/rpc proxy so the Helius
    // API key is never exposed client-side.  The proxy accepts an optional
    // ?network=mainnet|devnet query param (added in PERC-469) to route each chain to
    // the correct Helius endpoint using server-side env vars only.
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const mainnetRpcUrl = `${origin}/api/rpc?network=mainnet`;
    const devnetRpcUrl = `${origin}/api/rpc?network=devnet`;

    // WSS endpoint for subscriptions — Privy needs a real WebSocket URL; we use a
    // dedicated WS-only key (NEXT_PUBLIC_HELIUS_WS_API_KEY, intentionally limited-scope
    // and safe to expose) or fall back to public Solana endpoints.
    const wsKey = (process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY ?? "").trim();
    const mainnetWss = wsKey
      ? `wss://mainnet.helius-rpc.com/?api-key=${wsKey}`
      : "wss://api.mainnet-beta.solana.com";
    const devnetWss = wsKey
      ? `wss://devnet.helius-rpc.com/?api-key=${wsKey}`
      : "wss://api.devnet.solana.com";

    return {
      "solana:mainnet": {
        rpc: createSolanaRpc(mainnetRpcUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(mainnetWss),
        blockExplorerUrl: "https://solscan.io",
      },
      "solana:devnet": {
        rpc: createSolanaRpc(devnetRpcUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(devnetWss),
        blockExplorerUrl: "https://explorer.solana.com?cluster=devnet",
      },
    };
  }, []);

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          walletChainType: "solana-only",
          showWalletLoginFirst: true,
          walletList,
        },
        loginMethods: ["wallet", "email"],
        walletConnectCloudProjectId,
        externalWallets: {
          solana: {
            connectors: solanaConnectors,
          },
        },
        // Privy v3: solana.rpcs must be at the top-level config.solana key,
        // not inside embeddedWallets.solana. Provides RPC for all Solana standard
        // wallet hooks (useStandardSignAndSendTransaction etc.).
        solana: {
          rpcs: solanaRpcs,
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },
      }}
    >
      <SentryUserContext />
      <PrivyLoginBridge>
        <PrivyWalletApiBridge>{children}</PrivyWalletApiBridge>
      </PrivyLoginBridge>
    </PrivyProvider>
  );
};

/**
 * Computes the unified WalletApi from Privy's hooks and injects it via
 * WalletApiContext. Lives INSIDE the PrivyProvider tree and inside this
 * dynamically-imported module, so `useWalletCompat()` consumers get the Privy
 * implementation without ever importing @privy-io/react-auth themselves. Ported
 * verbatim from the former `useWalletCompatPrivyInner` in useWalletCompat.ts.
 */
const PrivyWalletApiBridge: FC<{ children: ReactNode }> = ({ children }) => {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction: privySignTransaction } = useSignTransaction();
  const { signAndSendTransaction: privySignAndSend } = useSignAndSendTransaction();
  const { signMessage: privySignMessage } = useSignMessage();
  const { preferredAddress } = usePreferredWallet();

  const activeWallet = useMemo(() => {
    return resolveActiveWallet(wallets, preferredAddress);
  }, [wallets, preferredAddress]);

  const publicKey = useMemo(() => {
    if (!activeWallet) return null;
    try {
      return new PublicKey(activeWallet.address);
    } catch {
      return null;
    }
  }, [activeWallet]);

  const connected = authenticated && !!activeWallet;

  const signTransaction = useMemo(() => {
    if (!activeWallet) return undefined;
    return async (tx: Transaction): Promise<Transaction> => {
      const serialized = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      // Explicitly pass the chain so Privy uses the correct network's RPC.
      // Without this, Privy defaults to solana:mainnet which causes 403s
      // when the app is configured for devnet.
      const network = getNetwork();
      const chain = network === "mainnet" ? "solana:mainnet" : "solana:devnet";
      const result = await privySignTransaction({
        transaction: new Uint8Array(serialized),
        wallet: activeWallet,
        chain: chain as any,
      });
      return Transaction.from(Buffer.from(result.signedTransaction));
    };
  }, [activeWallet, privySignTransaction]);

  /**
   * PERC-8388: signAndSendTransaction bypasses Lighthouse/Blowfish injection.
   * When the wallet signs AND sends atomically, there is no post-sign window
   * for wallet middleware to inject assertion instructions that break our tx.
   */
  /**
   * signAllTransactions: the market-launch batching fast path's primary sign
   * method — one Privy approval modal for the whole batch instead of one per
   * tx. `useSignTransaction().signTransaction` is VARIADIC
   * (`signTransaction(...inputs: SignTransactionInput[]): Promise<SignTransactionOutput[]>`
   * — verified in @privy-io/react-auth's dist/dts/solana.d.ts) precisely for
   * this multi-tx case; spreading N inputs returns N outputs in the same
   * order, from a single approval.
   */
  const signAllTransactions = useMemo(() => {
    if (!activeWallet) return undefined;
    return async (txs: Transaction[]): Promise<Transaction[]> => {
      const network = getNetwork();
      const chain = network === "mainnet" ? "solana:mainnet" : "solana:devnet";
      const inputs = txs.map((tx) => ({
        transaction: new Uint8Array(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ),
        wallet: activeWallet,
        chain: chain as any,
      }));
      const results = await privySignTransaction(...inputs);
      return results.map((result) => Transaction.from(Buffer.from(result.signedTransaction)));
    };
  }, [activeWallet, privySignTransaction]);

  const signAndSendTransaction = useMemo(() => {
    if (!activeWallet) return undefined;
    return async (tx: Transaction): Promise<Uint8Array> => {
      const serialized = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const network = getNetwork();
      const chain = network === "mainnet" ? "solana:mainnet" : "solana:devnet";
      const result = await privySignAndSend({
        transaction: new Uint8Array(serialized),
        wallet: activeWallet,
        chain: chain as any,
      });
      return new Uint8Array(result.signature);
    };
  }, [activeWallet, privySignAndSend]);

  const signMessage = useMemo(() => {
    if (!activeWallet) return undefined;
    return async (message: Uint8Array): Promise<Uint8Array> => {
      const result = await privySignMessage({ message, wallet: activeWallet });
      return result.signature;
    };
  }, [activeWallet, privySignMessage]);

  const api = useMemo<WalletApi>(
    () => ({
      publicKey,
      connected,
      connecting: !ready,
      wallet: activeWallet,
      signTransaction,
      signAndSendTransaction,
      signMessage,
      signAllTransactions,
      disconnect: logout,
    }),
    [publicKey, connected, ready, activeWallet, signTransaction, signAndSendTransaction, signMessage, signAllTransactions, logout],
  );

  return <WalletApiContext.Provider value={api}>{children}</WalletApiContext.Provider>;
};

/**
 * Bridge that exposes Privy's login function via context so components
 * outside the Privy tree can trigger wallet connection safely.
 */
const PrivyLoginBridge: FC<{ children: ReactNode }> = ({ children }) => {
  const { login } = usePrivy();
  return (
    <PrivyLoginContext.Provider value={login}>
      {children}
    </PrivyLoginContext.Provider>
  );
};

export default PrivyProviderClient;
