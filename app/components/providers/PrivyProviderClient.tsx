"use client";

import { FC, ReactNode, useCallback, useMemo } from "react";
import {
  PrivyProvider,
  useConnectWallet,
  useLogin,
  usePrivy,
  type WalletListEntry,
} from "@privy-io/react-auth";
import {
  toSolanaWalletConnectors,
  useWallets,
  useSignTransaction,
  useSignAndSendTransaction,
  useSignMessage,
} from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { PublicKey, Transaction } from "@solana/web3.js";
import * as Sentry from "@sentry/nextjs";
import { SentryUserContext } from "@/components/providers/SentryUserContext";
import { PrivyLoginContext } from "@/hooks/usePrivySafe";
import { WalletApiContext, type WalletApi } from "@/hooks/walletApiContext";
import { usePreferredWallet, resolveActiveWallet } from "@/hooks/usePreferredWallet";
import { getNetwork } from "@/lib/config";
import { purgeLegacyPrivyState } from "@/lib/privy-legacy-purge";

// Drop legacy pre-cookie Privy tokens at module-evaluation time. This chunk is
// loaded via next/dynamic (ssr:false) before PrivyProvider is ever rendered, and
// the Privy SDK only reads localStorage when its provider/client mounts (render
// or later), never at import. So this runs strictly before Privy's boot refresh,
// without an inline script (CSP-safe) and without racing a React effect.
purgeLegacyPrivyState();

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
      const serialized = txs.map(
        (tx) => new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
      );

      // ATTEMPT 1 — the wallet's OWN wallet-standard `solana:signTransaction`
      // feature, invoked with ALL inputs in a single call. This is the native
      // batch path (what wallet-adapter's signAllTransactions uses under the
      // hood); Phantom/Solflare render it as ONE approval listing every tx.
      //
      // The features hang off `ConnectedStandardSolanaWallet.standardWallet`
      // (a SolanaStandardWallet), NOT off the connected-wallet object itself —
      // reading `activeWallet.features` finds nothing, silently falls through,
      // and the user gets one Privy approval PER transaction (the exact
      // "I still signed 8 times" report on Solflare). Verified against
      // @privy-io/js-sdk-core's ConnectedStandardSolanaWallet class:
      // `get standardWallet(): SolanaStandardWallet`.
      try {
        const connected = activeWallet as unknown as {
          address: string;
          standardWallet?: {
            features?: Record<string, unknown>;
            accounts?: Array<{ address: string }>;
          };
        };
        const std = connected.standardWallet;
        const feature = std?.features?.["solana:signTransaction"] as
          | { signTransaction?: (...inputs: unknown[]) => Promise<Array<{ signedTransaction: Uint8Array }>> }
          | undefined;
        const account =
          std?.accounts?.find((a) => a.address === connected.address) ?? std?.accounts?.[0];
        if (typeof feature?.signTransaction === "function" && account) {
          const outputs = await feature.signTransaction(
            ...serialized.map((bytes) => ({ transaction: bytes, account, chain })),
          );
          if (Array.isArray(outputs) && outputs.length === txs.length) {
            console.info(`[PrivyProviderClient] batch-signed ${txs.length} txs via wallet-standard feature (ONE approval)`);
            return outputs.map((o) => Transaction.from(Buffer.from(o.signedTransaction)));
          }
        }
      } catch (e) {
        console.warn("[PrivyProviderClient] wallet-standard batch sign failed — trying the connected wallet's own signer:", e);
      }

      // ATTEMPT 2 — ConnectedStandardSolanaWallet's own VARIADIC
      // signTransaction (a documented wrapper around the same
      // solana:signTransaction feature). Covers wallets whose feature object
      // isn't reachable structurally above.
      try {
        const walletSigner = activeWallet as unknown as {
          signTransaction?: (...inputs: unknown[]) => Promise<Array<{ signedTransaction: Uint8Array }> | { signedTransaction: Uint8Array }>;
        };
        if (typeof walletSigner.signTransaction === "function" && txs.length > 1) {
          const outputs = await walletSigner.signTransaction(
            ...serialized.map((bytes) => ({ transaction: bytes, chain })),
          );
          if (Array.isArray(outputs) && outputs.length === txs.length) {
            console.info(`[PrivyProviderClient] batch-signed ${txs.length} txs via connected-wallet variadic signer (ONE approval)`);
            return outputs.map((o) => Transaction.from(Buffer.from(o.signedTransaction)));
          }
        }
      } catch (e) {
        console.warn("[PrivyProviderClient] connected-wallet variadic sign failed — using Privy signer (may prompt per tx):", e);
      }

      // ATTEMPT 3 (fallback) — Privy's own signer, called with all N inputs.
      // GH#2594: this still RESOLVES with N signed transactions, so from
      // signAllCompat's (lib/tx.ts) point of view it looks identical to a
      // genuine one-approval batch — but Privy's own bridge for a
      // non-wallet-standard wallet may prompt once PER transaction internally
      // (the "I still signed N times" report). Neither the return value nor
      // signAllCompat can observe that degradation, so before this it was
      // invisible outside a console.warn. Report it once per batch so a
      // degraded launch is discoverable without reproducing it locally.
      if (txs.length > 1) {
        Sentry.captureMessage(
          `[PrivyProviderClient] signAllTransactions degraded to Privy's per-tx signer for a ${txs.length}-tx batch — the wallet likely prompted ${txs.length} times instead of once.`,
          "warning",
        );
      }

      const inputs = serialized.map((bytes) => ({
        transaction: bytes,
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
 * Bridge that exposes a "connect wallet" action via context so components
 * outside the Privy tree can trigger wallet connection safely.
 *
 * The action must never be a silent no-op. Privy's session (refresh token)
 * outlives the wallet connection: after e.g. an overnight extension lock,
 * Privy's silent reconnect fails, `authenticated` stays true, and no Solana
 * wallet is connected. `login()` in that state only logs "Attempted to log
 * in, but user is already logged in" (@privy-io/react-auth 3.41.0) and
 * returns — so every Connect CTA was dead. When authenticated we therefore
 * open `connectWallet()`, which re-prompts the external wallet.
 */
const PrivyLoginBridge: FC<{ children: ReactNode }> = ({ children }) => {
  const { setPreferredAddress } = usePreferredWallet();
  const { authenticated } = usePrivy();

  const { login } = useLogin({
    onComplete: ({ loginAccount }) => {
      // This bridge backs Trade/Faucet and other callers of usePrivyLogin().
      // Persist the wallet that actually authenticated the session.
      if (loginAccount?.type === "wallet" && loginAccount.chainType === "solana") {
        setPreferredAddress(loginAccount.address);
      }
    },
  });

  // #2620 semantics for (re)connects: the wallet the user explicitly connects
  // becomes the active signer. `useConnectWallet` subscribes to Privy's global
  // `connectWallet` event, so this also covers the header's Reconnect button.
  // Privy does not fire it for wallet-login or link flows (those go through
  // `onComplete` above).
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      if (wallet.type === "solana") {
        setPreferredAddress(wallet.address);
      }
    },
  });

  const connect = useCallback(() => {
    if (authenticated) {
      connectWallet({ walletChainType: "solana-only" });
      return;
    }
    login();
  }, [authenticated, connectWallet, login]);

  return (
    <PrivyLoginContext.Provider value={connect}>
      {children}
    </PrivyLoginContext.Provider>
  );
};

export default PrivyProviderClient;
