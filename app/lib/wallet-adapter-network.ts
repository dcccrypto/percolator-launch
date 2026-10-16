/**
 * v2.2 QA NB-2: "Network mismatch: your network is devnet, but this transaction is for mainnet" in Solflare.
 *
 * Every transaction the app builds uses the one shared connection (getConfig().rpcUrl = the same-origin /api/rpc
 * proxy, which refuses mainnet routing on a devnet deployment) and a blockhash fetched from it, so no mainnet blockhash
 * can reach a tx. The mismatch came from the WALLET side: `new SolflareWalletAdapter()` was created with no `network`,
 * and the adapter hands `{ network: undefined }` to the Solflare SDK, which then assumes mainnet-beta for the dapp
 * (wallet-adapter-solflare adapter.js: `new SolflareClass({ network: this._config.network })`). Whenever the connection
 * went through that legacy adapter (the Solflare web / iframe path) instead of the Wallet Standard extension, Solflare
 * was told "mainnet" while the user was on devnet. The adapter now gets the deployment's network.
 */
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";

export function walletAdapterNetwork(network: string): WalletAdapterNetwork {
  if (network === "mainnet") return WalletAdapterNetwork.Mainnet;
  if (network === "testnet") return WalletAdapterNetwork.Testnet;
  return WalletAdapterNetwork.Devnet;
}
