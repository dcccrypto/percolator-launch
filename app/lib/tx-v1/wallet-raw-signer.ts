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

// ---------------------------------------------------------------------------
// Wallet error classification (L-5 / A-2, security review 2026-10-05)
//
// Order of precedence, always: a DECLINE wins. A user who said no is never treated as "the wallet
// cannot sign v1" (which would re-plan in the legacy format and open the wallet again).
//
// Real shapes, from the installed packages and wallet docs:
//  - EIP-1193 / Phantom / Backpack / Solflare providers: `{ code: 4001, message: "User rejected the request." }`.
//  - Privy (@privy-io/react-auth 3.41): `ProviderRpcError("The user rejected the request", 4001)` wrapped in a
//    `PrivyProviderRpcError`; a `PrivyClientError` "Transaction was rejected by the user" with
//    `privyErrorCode: "transaction_failure"` whose `cause` is the wallet error; flow exits `user_exited_*`.
//  - wallet-adapter (@solana/wallet-adapter-base 0.9.27): `WalletSignTransactionError(message, error)` keeps the
//    wallet's error on `.error` (not `.cause`), so the chain walk follows both.
//  - Mobile Wallet Adapter (@solana-mobile/mobile-wallet-adapter-protocol 2.2.9):
//    `SolanaMobileWalletAdapterProtocolError` code -3 ERROR_NOT_SIGNED (declined), -2 ERROR_INVALID_PAYLOADS
//    (the wallet could not read the payload); `SolanaMobileWalletAdapterError` code
//    "ERROR_ASSOCIATION_CANCELLED" (user closed the wallet).
//  - Genuine "cannot read v1": Phantom 26.31.0 "Reached end of buffer unexpectedly"; JSON-RPC -32603
//    "Unexpected error" from providers proxying a parse failure.
// ---------------------------------------------------------------------------

/** Numeric provider codes that mean "the user declined" (EIP-1193 4001 user rejected request). */
const DECLINE_CODES: ReadonlySet<number> = new Set([4001]);
/** String codes / names that mean "the user declined or closed the wallet". */
const DECLINE_STRING_CODES: ReadonlySet<string> = new Set([
  "4001",
  "USER_REJECTED_REQUEST",
  "E4001_USER_REJECTED_REQUEST",
  "ACTION_REJECTED",
  "ERROR_ASSOCIATION_CANCELLED",
  "UserRejectedRequestError",
  "WalletUserRejectedError",
]);
const MWA_PROTOCOL_ERROR = "SolanaMobileWalletAdapterProtocolError";
const MWA_NOT_SIGNED = -3;
const MWA_INVALID_PAYLOADS = -2;
/** JSON-RPC internal error; Phantom answers an unparseable transaction with it ("Unexpected error"). */
const RPC_INTERNAL_ERROR = -32603;

/**
 * Decline wording, the fallback when no code/name matched. Deliberately wide: a false "decline" only means
 * no automatic legacy retry (the user sees the error and can try again); a missed decline re-prompts a user
 * who already said no.
 */
const DECLINE_TEXT =
  /\b(user\s+)?(rejected|declined|denied|cancell?ed|canceled|aborted|dismissed)\b|\b(reject|decline|deny|cancel)(ed|led)?\s+(the\s+)?(request|transaction|signature|signing|approval)|user\s+(closed|exited|abort|cancel|den(y|ied)|reject|declin)|closed\s+(the\s+)?(wallet|popup|pop-up|window|modal|dialog)|(popup|pop-up|window|modal|dialog)\s+(was\s+)?closed|approval\s+denied|not\s+approved\s+by\s+(the\s+)?user|user_exited|exited_/i;

/**
 * "This wallet cannot read a v1 transaction" wording. Narrow on purpose: only parse/version failures.
 * Bare "not supported", "invalid transaction", "version 1" and "unexpected error" (without the -32603 code)
 * are NOT enough.
 */
const V1_PARSE_FAILURE_TEXT =
  /reached end of buffer|end of buffer unexpectedly|unsupported (transaction |message )?version|unknown (transaction |message )?version|invalid (transaction |message )?version|(transaction|message) version \(?1\)? (is )?not supported|versioned transactions? (are |is )?not supported|v1 transactions? (are |is )?not supported|failed to deseriali[sz]e (the )?(transaction|message)|could not (parse|deserialize|decode) (the )?(transaction|message)/i;

interface ErrorLink {
  name?: string;
  code?: unknown;
  message?: string;
  privyErrorCode?: unknown;
}

/** The error and what it wraps (`cause`, wallet-adapter's `error`, Privy's `cause`), max depth 5. */
function errorChain(err: unknown): ErrorLink[] {
  const out: ErrorLink[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && isObject(cur) && !seen.has(cur); depth++) {
    seen.add(cur);
    out.push({
      name: typeof cur.name === "string" ? cur.name : undefined,
      code: cur.code,
      message: typeof cur.message === "string" ? cur.message : undefined,
      privyErrorCode: cur.privyErrorCode,
    });
    cur = cur.cause ?? cur.error;
  }
  return out;
}

function linkIsDecline(l: ErrorLink): boolean {
  if (typeof l.code === "number" && DECLINE_CODES.has(l.code)) return true;
  if (typeof l.code === "string" && DECLINE_STRING_CODES.has(l.code)) return true;
  if (l.name !== undefined && DECLINE_STRING_CODES.has(l.name)) return true;
  if (l.name === MWA_PROTOCOL_ERROR && l.code === MWA_NOT_SIGNED) return true;
  if (typeof l.privyErrorCode === "string" && /(^|_)exited_|rejected/i.test(l.privyErrorCode)) return true;
  return false;
}

/**
 * Wallet "user said no". Codes and names first (4001, Privy/MWA shapes, anywhere in the wrapped chain), then
 * the decline wording as a fallback. Never retried, never fallen back.
 */
export function isUserRejection(err: unknown): boolean {
  if (typeof err === "string") return DECLINE_TEXT.test(err);
  const chain = errorChain(err);
  if (chain.some(linkIsDecline)) return true;
  return chain.some((l) => l.message !== undefined && DECLINE_TEXT.test(l.message));
}

/**
 * True when a wallet SIGNING error means "this wallet cannot read a v1 transaction", which is safe to answer
 * with ONE legacy re-plan (nothing has been sent). A decline always wins: if {@link isUserRejection} is true
 * this is false. Matches only genuine parse/version failures: the Phantom buffer-underrun, a JSON-RPC -32603
 * internal error (a provider proxying a parse failure), a Mobile Wallet Adapter ERROR_INVALID_PAYLOADS, and
 * explicit unsupported/unknown-version wording.
 */
export function isV1WalletSigningFailure(err: unknown): boolean {
  if (isUserRejection(err)) return false;
  if (typeof err === "string") return V1_PARSE_FAILURE_TEXT.test(err);
  const chain = errorChain(err);
  for (const l of chain) {
    if (l.code === RPC_INTERNAL_ERROR) return true;
    if (l.name === MWA_PROTOCOL_ERROR && l.code === MWA_INVALID_PAYLOADS) return true;
    if (l.message !== undefined && V1_PARSE_FAILURE_TEXT.test(l.message)) return true;
  }
  return false;
}
