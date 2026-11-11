/**
 * The Solana mainnet mints of the major USD-pegged stablecoins (and bridged / wrapped / yield-bearing USD variants).
 * Data only (no imports) so the same list is reused by the app gates, the keeper/indexer refusal and the on-chain denylist PR
 * (exported to out/stablecoin-mints.json).
 *
 * Verified 2026-11-10. EVERY address below was checked on mainnet (`getAccountInfo`: it is an SPL / Token-2022 mint; the
 * on-chain Metaplex / Token-2022 metadata name+symbol match the entry where metadata exists) AND against at least one
 * independent source:
 *   ISSUER = the issuer's own documentation page lists the address
 *   CG     = CoinGecko API `platforms.solana` for the coin id given
 *   JUP    = Jupiter tokens v2 (lite-api.jup.ag/tokens/v2/search) tag verified / strict / stable
 *   SLTL   = solana-labs/token-list `solana.tokenlist.json` (the legacy list; covers the Wormhole/Portal and Allbridge mints)
 *
 * No Solana mint was found for GHO, BOLD, TUSD, BUSD, USDT0, RLUSD or USDtb (Jupiter token search returns only unverified look-alike
 * launches for them, which are deliberately NOT listed): GHO, TUSD, BUSD, USDT0, RLUSD and USDtb are covered by the ticker / name rule in
 * ./stablecoin-perps. BOLD, USX and CASH are NOT ticker-blocked (unrelated memecoins use those exact tickers): USX and CASH are blocked by
 * their verified mint below, and BOLD has no Solana mint so it is not blocked at all until one is verified (only the full name
 * "Liquity BOLD" / "Liquity USD" is refused).
 *
 * 41 entries: 32 (2026-11-10) + 7 (r7, 2026-11-11, #3798) + 2 (r8, 2026-11-11: sUSD, syrupUSDC). The keeper copy
 * (percolator-oracle-keeper src/cross-cluster/stablecoin-mints.ts) must hold the same 41 addresses.
 *
 * Policy: USD only. EURC and other non-USD fiat stables are NOT blocked. Yield-bearing / NAV-accruing USD tokens (sUSDe, USDY)
 * ARE blocked (sUSDe, USDY, sDAI, and the r8 additions sUSD and syrupUSDC): their price is a deterministic accrual on a dollar, so a perp on them has no independent underlying.
 * Devnet: the app's USDC-like devnet mints (Sim-USDC, Circle devnet USDC) are collateral, never a perp underlying
 * identity (`mainnet_ca`), and were not in the original list, so they are intentionally not here.
 */
export interface StablecoinMint {
  address: string;
  symbol: string;
  name: string;
  /** Where the address was verified (see legend above). */
  source: string;
}

export const STABLECOIN_MINT_LIST: readonly StablecoinMint[] = [
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USD Coin (Circle, native)", source: "ISSUER developers.circle.com/stablecoins/usdc-contract-addresses; SLTL; JUP stable; CHAIN" },
  { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "Tether USD", source: "ISSUER tether.to/en/supported-protocols; SLTL; JUP stable; CHAIN" },
  { address: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", symbol: "PYUSD", name: "PayPal USD", source: "CG paypal-usd; JUP stable; CHAIN (Token-2022 metadata)" },
  { address: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", symbol: "USDS", name: "USDS (Sky)", source: "CG usds; JUP stable; CHAIN" },
  { address: "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u", symbol: "FDUSD", name: "First Digital USD", source: "CG first-digital-usd; JUP stable; CHAIN" },
  { address: "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT", symbol: "USDe", name: "Ethena USDe", source: "CG ethena-usde; JUP stable; CHAIN" },
  { address: "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN", symbol: "sUSDe", name: "Staked USDe (yield-bearing USD)", source: "CG ethena-staked-usde; JUP verified; CHAIN" },
  { address: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", symbol: "USDG", name: "Global Dollar (Paxos)", source: "CG global-dollar; JUP stable; CHAIN (Token-2022 metadata)" },
  { address: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", symbol: "USD1", name: "World Liberty Financial USD", source: "CG usd1-wlfi; JUP stable; CHAIN" },
  { address: "AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9", symbol: "AUSD", name: "Agora Dollar", source: "CG agora-dollar; JUP stable; CHAIN (Token-2022 metadata)" },
  { address: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", symbol: "USDY", name: "Ondo US Dollar Yield (yield-bearing USD)", source: "ISSUER docs.ondo.finance/addresses; JUP strict; CHAIN" },
  { address: "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX", symbol: "USDH", name: "USDH Hubble Stablecoin", source: "CG usdh; SLTL; JUP stable; CHAIN (mint)" },
  { address: "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT", symbol: "UXD", name: "UXD Stablecoin", source: "CG uxd-stablecoin; SLTL; JUP stable; CHAIN (mint)" },
  { address: "5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E", symbol: "hyUSD", name: "Hylo USD", source: "JUP stable (verified); CHAIN metadata Hylo USD / hyUSD" },
  { address: "GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw", symbol: "frxUSD", name: "Frax USD", source: "CG frax-usd; CHAIN metadata Frax USD / frxUSD" },
  { address: "EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o", symbol: "DAI", name: "Dai Stablecoin (Portal / Wormhole)", source: "SLTL; JUP strict; CHAIN" },
  { address: "A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM", symbol: "USDCet", name: "USD Coin (Portal from Ethereum)", source: "SLTL; JUP strict; CHAIN" },
  { address: "Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1", symbol: "USDTet", name: "Tether USD (Portal from Ethereum)", source: "SLTL; JUP strict; CHAIN" },
  { address: "E2VmbootbVCBkMNNxKQgCLMS1X3NoGMaYAsufaAsf7M", symbol: "USDCpo", name: "USD Coin (PoS) (Portal from Polygon)", source: "SLTL; JUP strict; CHAIN" },
  { address: "5goWRao6a3yNC4d6UjMdQxonkCMvKBwdpubU3qhfcdf1", symbol: "USDTpo", name: "Tether USD (PoS) (Portal from Polygon)", source: "SLTL; JUP strict; CHAIN" },
  { address: "FCqfQSujuPxy6V42UvafBhsysWtEq1vhjfMN1PUbgaxA", symbol: "USDCbs", name: "USD Coin (Portal from BSC)", source: "SLTL; JUP strict; CHAIN" },
  { address: "8qJSyQprMC57TWKaYEmetUR3UUiTP2M3hXdcvFhkZdmv", symbol: "USDTbs", name: "Tether USD (Portal from BSC)", source: "SLTL; JUP strict; CHAIN" },
  { address: "9vMJfxuKxXBoEa7rM12mYLMwTacLMLDJqHozw96WQL8i", symbol: "UST", name: "UST (Portal), legacy depegged USD stable", source: "SLTL; JUP strict; CHAIN" },
  { address: "DdFPRnccQqLD4zCHrBqdY95D6hvw6PLWp9DEXj1fLCL9", symbol: "aeUSDC", name: "Wrapped USDC (Allbridge from Ethereum)", source: "SLTL; JUP strict; CHAIN (mint)" },
  { address: "eqKJTf1Do4MDPyKisMYqVaUFpkEFAs3riGF3ceDH2Ca", symbol: "apUSDC", name: "Wrapped USDC (Allbridge from Polygon)", source: "SLTL; JUP strict; CHAIN (mint)" },
  { address: "8XSsNvaKU9FDhYWAv7Yc7qSNwuJSzVrXBNEk7AFiWF69", symbol: "abUSDC", name: "Wrapped USDC (Allbridge from BSC)", source: "SLTL; JUP strict; CHAIN (mint)" },
  { address: "8Yv9Jz4z7BUHP68dz8E8m3tMe6NKgpMUKn8KVqrPA6Fr", symbol: "aaUSDC", name: "Wrapped USDC (Allbridge from Avalanche)", source: "SLTL; CHAIN (mint)" },
  { address: "DHpoYejUDqzByb6HAdaLWF7KZvwUv2vWYDY9cTENNZui", symbol: "acUSDC", name: "Wrapped USDC (Allbridge from Celo)", source: "SLTL; CHAIN (mint)" },
  { address: "Bn113WT6rbdgwrm12UJtnmNqGqZjY4it2WoUQuQopFVn", symbol: "aeUSDT", name: "Wrapped USDT (Allbridge from Ethereum)", source: "SLTL; JUP strict; CHAIN (mint)" },
  { address: "DNhZkUaxHXYvpxZ7LNnHtss8sQgdAfd1ZYS1fB7LKWUZ", symbol: "apUSDT", name: "Wrapped USDT (Allbridge from Polygon)", source: "SLTL; JUP strict; CHAIN (mint)" },
  { address: "E77cpQ4VncGmcAXX16LHFFzNBEBb2U7Ar7LBmZNfCgwL", symbol: "abUSDT", name: "Wrapped USDT (Allbridge from BSC)", source: "SLTL; CHAIN (mint)" },
  { address: "FwEHs3kJEdMa2qZHv7SgzCiFXUQPEycEXksfBkwmS8gj", symbol: "aaUSDT", name: "Wrapped USDT (Allbridge from Avalanche)", source: "SLTL; JUP strict; CHAIN (mint)" },
  // Added 2026-11-11 (r7). Each: getAccountInfo on the Solana public RPC (SPL / Token-2022 mint) + on-chain metadata name/symbol + an independent source.
  { address: "usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia", symbol: "USD+", name: "USD+ (Overnight)", source: "CG usd-2; JUP verified; CHAIN mint + Metaplex USD+ / USD+" },
  { address: "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH", symbol: "CASH", name: "CASH", source: "CG cash-4; JUP stable (verified); CHAIN Token-2022 metadata CASH / CASH" },
  { address: "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG", symbol: "USX", name: "USX (Solstice)", source: "CG usx; JUP stable (verified); CHAIN mint + Metaplex USX / USX" },
  { address: "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC", symbol: "eUSX", name: "eUSX (Solstice, yield-bearing USD)", source: "CG solstice-eusx; JUP verified yb; CHAIN mint + Metaplex eUSX / eUSX" },
  { address: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", symbol: "JupUSD", name: "Jupiter USD", source: "CG jupusd; JUP stable (verified); CHAIN mint + Metaplex Jupiter USD / JupUSD" },
  { address: "EwxNF8g9UfmsJVcZFTpL9Hx5MCkoQFoJi6XNWzKf1j8e", symbol: "acUSD", name: "Wrapped CUSD (Allbridge from Celo)", source: "SLTL acUSD; CHAIN mint (no Metaplex account)" },
  { address: "FR87nWEUxVgerFGhZM8Y4AggKGLnaXswr1Pd8wZ4kZcp", symbol: "FRAX", name: "Frax (Portal / Wormhole)", source: "SLTL FRAX (Frax (Portal)); CHAIN mint + Metaplex Frax (Wormhole) / FRAX" },
  // Added 2026-11-11 (r8). Each: getAccountInfo on the Solana public RPC + on-chain metadata, the issuer's docs page, and Jupiter + CoinGecko.
  { address: "susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X", symbol: "sUSD", name: "Solayer USD (yield-bearing USD)", source: "ISSUER docs.solayer.org/susd/yield-bearing-stablecoin/what-is-susd (Token Address, Token-2022); CG solayer-usd; JUP verified yb; CHAIN Token-2022 metadata Solayer USD / sUSD" },
  { address: "AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj", symbol: "syrupUSDC", name: "Syrup USDC (Maple, yield-bearing USD)", source: "ISSUER docs.maple.finance/integrate/crosschain/syrupusd-crosschain (Solana tab, Token); CG syrupusdc; JUP verified yb; CHAIN SPL mint" },
];
