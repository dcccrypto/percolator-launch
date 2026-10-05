/**
 * Raw-bytes wallet signing for Solana v1 transactions (SIMD-0385).
 *
 * Why not `wallet.signTransaction(tx)`: the app's WalletApi (and wallet-adapter's) takes a web3.js
 * `Transaction` / `VersionedTransaction` OBJECT, and web3.js 1.x cannot build a v1 message
 * (`MessageV1.serialize()` throws, even in 1.99.0). Both wallet providers the app mounts sit on the
 * Wallet Standard `solana:signTransaction` feature, which takes and returns raw bytes:
 *
 *  - wallet-adapter: `useWallet().wallet.adapter` is a `StandardWalletAdapter` whose `.wallet` is the
 *    Standard wallet (the adapter's own `signTransaction` only serializes the object and calls that
 *    feature: @solana/wallet-standard-wallet-adapter-base adapter.js).
 *  - Privy: the active wallet is a `ConnectedStandardSolanaWallet` whose `.standardWallet` is the
 *    Standard wallet (the batch signer in PrivyProviderClient already calls the feature directly).
 *
 * So this module resolves the Standard wallet + account behind either shape and signs bytes with it,
 * in ONE call for N transactions (one approval). No duck-typed transaction object is passed into
 * wallet-adapter, and nothing here depends on web3.js deserializing v1.
 *
 * Gate: a wallet is v1-capable only when it ADVERTISES version 1 on `solana:signTransaction`
 * (and, for wallet-adapter, on the adapter's `supportedTransactionVersions`, via the SDK's
 * `walletSupportsV1`). Wallets must not advertise 1 before they can sign it. As of 2026-10-05:
 * Privy embedded wallets advertise `["legacy", 0]` (@privy-io/react-auth 3.41.0), so they never
 * get v1; Phantom 26.31.0 cannot sign v1; Backpack signs v1.
 */
import type { PublicKey } from "@solana/web3.js";
import { walletSupportsV1 } from "@/lib/v21/sdk";

export const SOLANA_SIGN_TRANSACTION_FEATURE = "solana:signTransaction";

/** Wallet Standard chain id, e.g. `solana:devnet`. */
export type SolanaChainId = `solana:${string}`;

interface StandardAccount {
  address: string;
  features?: readonly string[];
}

interface StandardSignInput {
  account: StandardAccount;
  transaction: Uint8Array;
  chain?: string;
}

interface StandardSignFeature {
  supportedTransactionVersions?: readonly unknown[];
  signTransaction: (...inputs: StandardSignInput[]) => Promise<readonly { signedTransaction: Uint8Array }[]>;
}

interface StandardWalletLike {
  name?: string;
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}

/** A wallet that can sign raw transaction bytes. */
export interface RawTxSigner {
  /** Which provider shape it was resolved from. */
  readonly source: "wallet-adapter" | "privy";
  /** Wallet name (diagnostics only). */
  readonly name: string;
  /** Versions the wallet's `solana:signTransaction` feature advertises. */
  readonly versions: ReadonlySet<unknown>;
  /** True only when the wallet advertises v1 everywhere the gate looks. */
  readonly supportsV1: boolean;
  /** Sign every wire in ONE wallet call (one approval); returns the signed wires in order. */
  signRaw(wires: readonly Uint8Array[]): Promise<Uint8Array[]>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asStandardWallet(v: unknown): StandardWalletLike | null {
  if (!isObject(v)) return null;
  const { accounts, features } = v;
  if (!Array.isArray(accounts) || !isObject(features)) return null;
  return v as unknown as StandardWalletLike;
}

function signFeatureOf(w: StandardWalletLike): StandardSignFeature | null {
  const f = w.features[SOLANA_SIGN_TRANSACTION_FEATURE];
  if (!isObject(f) || typeof f.signTransaction !== "function") return null;
  return f as unknown as StandardSignFeature;
}

function versionSet(list: readonly unknown[] | undefined): ReadonlySet<unknown> {
  return new Set(Array.isArray(list) ? list : []);
}

function makeSigner(
  source: RawTxSigner["source"],
  std: StandardWalletLike,
  address: string,
  chain: SolanaChainId,
  extraV1Gate: boolean,
): RawTxSigner | null {
  const feature = signFeatureOf(std);
  if (!feature) return null;
  const account = std.accounts.find((a) => a.address === address);
  if (!account) return null;
  if (account.features && !account.features.includes(SOLANA_SIGN_TRANSACTION_FEATURE)) return null;
  const versions = versionSet(feature.supportedTransactionVersions);
  const supportsV1 = extraV1Gate && walletSupportsV1({ supportedTransactionVersions: versions });
  return {
    source,
    name: std.name ?? "unknown",
    versions,
    supportsV1,
    async signRaw(wires) {
      if (wires.length === 0) return [];
      const out = await feature.signTransaction(...wires.map((transaction) => ({ account, transaction, chain })));
      if (!Array.isArray(out) || out.length !== wires.length) {
        throw new Error(`Wallet returned ${Array.isArray(out) ? out.length : "no"} signed transactions for ${wires.length}`);
      }
      return out.map((o) => new Uint8Array(o.signedTransaction));
    },
  };
}

/**
 * Resolve a raw-bytes signer for the app's active wallet (`WalletApi.wallet`).
 *
 * @param wallet - wallet-adapter `Wallet` ({ adapter }) or Privy `ConnectedStandardSolanaWallet`.
 * @param publicKey - The connected public key (the account to sign with).
 * @param chain - Wallet Standard chain id.
 * @returns The signer, or null when the wallet exposes no Standard `solana:signTransaction`
 *   (legacy-only adapters, read-only, disconnected): callers then use the legacy path.
 */
export function resolveRawTxSigner(wallet: unknown, publicKey: PublicKey | null, chain: SolanaChainId): RawTxSigner | null {
  if (!publicKey || !isObject(wallet)) return null;
  const address = publicKey.toBase58();

  // wallet-adapter `Wallet`: { adapter: StandardWalletAdapter, readyState }.
  const adapter = wallet.adapter;
  if (isObject(adapter)) {
    const std = asStandardWallet(adapter.wallet);
    if (!std) return null;
    const adapterVersions = adapter.supportedTransactionVersions;
    const adapterV1 = walletSupportsV1({
      supportedTransactionVersions: adapterVersions instanceof Set ? (adapterVersions as ReadonlySet<unknown>) : null,
    });
    return makeSigner("wallet-adapter", std, address, chain, adapterV1);
  }

  // Privy `ConnectedStandardSolanaWallet`: { address, standardWallet }.
  if (typeof wallet.address === "string" && wallet.address === address) {
    const std = asStandardWallet(wallet.standardWallet);
    if (!std) return null;
    return makeSigner("privy", std, address, chain, true);
  }
  return null;
}

/**
 * True when a wallet SIGNING error looks like "this wallet cannot handle a v1 transaction", which is
 * safe to answer with a v0/legacy re-plan (nothing has been sent). A user rejection is never one.
 * Observed: Phantom 26.31.0 `Reached end of buffer unexpectedly`; wallets proxying a parse failure as
 * JSON-RPC `-32603 Unexpected error`.
 */
export function isV1WalletSigningFailure(err: unknown): boolean {
  const msg = errorText(err);
  if (isUserRejection(err)) return false;
  return /end of buffer|unsupported (transaction )?version|version 1|transaction version|failed to deseriali[sz]e|could not (parse|deserialize|decode)|invalid transaction|unknown (transaction )?version|-32603|unexpected error|not supported/i.test(msg);
}

/** Wallet "user said no" (EIP-1193 4001 / wallet-adapter wording). Never retried, never fallen back. */
export function isUserRejection(err: unknown): boolean {
  if (isObject(err) && err.code === 4001) return true;
  return /user rejected|rejected the request|user denied|user cancel|request was cancel|declined/i.test(errorText(err));
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && isObject(cur); depth++) {
    if (typeof cur.message === "string") parts.push(cur.message);
    if (typeof cur.code === "number" || typeof cur.code === "string") parts.push(String(cur.code));
    cur = cur.cause ?? cur.error;
  }
  return parts.join(" | ");
}
