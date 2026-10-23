/**
 * v2.2 QA NB-2: sign through the Wallet Standard feature directly so the wallet is TOLD the chain.
 *
 * wallet-adapter's `signTransaction` / `signAllTransactions` call `solana:signTransaction` without a `chain`
 * (@solana/wallet-standard-wallet-adapter-base 1.1.5 adapter.js), which leaves the wallet to guess the cluster of a
 * transaction. The standard input has an optional `chain`; on the v2.2 (devnet-only) build every request names
 * `solana:devnet`. Returns null when the adapter is not a Wallet Standard adapter, has no sign feature, or the
 * connected account does not list devnet: the caller then uses the adapter's own method, unchanged.
 */
import { Transaction, type PublicKey } from "@solana/web3.js";
import { SIGN_CHAIN_DEVNET } from "./sign-guard";

const FEATURE = "solana:signTransaction";
interface StdAccount { address: string; chains: readonly string[]; features: readonly string[] }
interface StdInput { account: StdAccount; transaction: Uint8Array; chain: string }
interface StdWallet {
  accounts: readonly StdAccount[];
  features: Record<string, { signTransaction?: (...inputs: StdInput[]) => Promise<readonly { signedTransaction: Uint8Array }[]> } | undefined>;
}

export type ChainSigner = (txs: Transaction[]) => Promise<Transaction[]>;

/**
 * NB-2 diagnostics: WHY a request did or did not carry the chain (kept in the sign log / `?signdebug=1` line as `signer`).
 * The legacy Solflare adapter (no chain param, the wallet guesses the cluster) is the other way a request can reach the wallet.
 */
export function chainSignerNote(adapter: unknown, publicKey: PublicKey | null): string {
  const a = adapter as { name?: string; standard?: unknown; wallet?: StdWallet } | null | undefined;
  if (!a) return "no adapter";
  const name = a.name ?? "?";
  if (a.standard !== true || !a.wallet) return `legacy adapter ${name} (no chain param: the wallet guesses the cluster)`;
  if (!publicKey) return `standard ${name}, no public key`;
  const sign = a.wallet.features?.[FEATURE]?.signTransaction;
  if (typeof sign !== "function") return `standard ${name}, no ${FEATURE} feature`;
  const accounts = a.wallet.accounts ?? [];
  const account = accounts.find((x) => x.address === publicKey.toBase58());
  if (!account) return `standard ${name}, account not in wallet.accounts (${accounts.length} listed)`;
  if (!account.features.includes(FEATURE)) return `standard ${name}, account lacks ${FEATURE}`;
  if (!account.chains.includes(SIGN_CHAIN_DEVNET)) return `standard ${name}, account chains [${account.chains.join(",")}] lack ${SIGN_CHAIN_DEVNET}`;
  return `standard ${name} + chain ${SIGN_CHAIN_DEVNET}`;
}

export function standardDevnetSigner(adapter: unknown, publicKey: PublicKey | null): ChainSigner | null {
  const a = adapter as { standard?: unknown; wallet?: StdWallet } | null | undefined;
  if (!a || a.standard !== true || !a.wallet || !publicKey) return null;
  const wallet = a.wallet;
  const sign = wallet.features?.[FEATURE]?.signTransaction;
  const account = wallet.accounts?.find((x) => x.address === publicKey.toBase58());
  if (typeof sign !== "function" || !account) return null;
  if (!account.features.includes(FEATURE) || !account.chains.includes(SIGN_CHAIN_DEVNET)) return null;
  return async (txs) => {
    const outputs = await sign.call(
      wallet.features[FEATURE],
      ...txs.map((tx) => ({
        account,
        chain: SIGN_CHAIN_DEVNET,
        transaction: new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false })),
      })),
    );
    if (outputs.length !== txs.length) throw new Error(`Wallet returned ${outputs.length} signed transactions for ${txs.length}`);
    return outputs.map((o) => Transaction.from(o.signedTransaction));
  };
}
