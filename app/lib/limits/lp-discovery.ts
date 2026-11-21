/**
 * Resolve a market's matcher-LP portfolio + matcher context ADDRESSES (the
 * limits UI then reads their bytes each poll). Same discovery rule as
 * lib/matcherCaps.ts (curated PLAYGROUND_SLAB_META pin first, else a
 * getProgramAccounts scan for the matcher-ENABLED portfolio of this market),
 * kept separate so the limits UI never perturbs the ticket's cap cache.
 *
 * P3: when the asset has a bound vault LP (`AssetVaultLpV18.vault_lp_portfolio`),
 * that key IS the LP — pass it as `knownLp` and no scan runs.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_IDENTITY_TRAILER_LEN, decodePortfolioMatcherControl } from "@percolatorct/sdk";
import { PLAYGROUND_SLAB_META } from "@/lib/playground-slab-meta";
import { isPortfolioAccount } from "@/lib/portfolio-account";
import { resolveMarketLp } from "@/lib/market-lp";
import { decodeAssetVaultLp, isV18MarketHeader } from "@/lib/limits/decode";

const PORTFOLIO_MATCHER_CONFIG_LEN = 104;
const TTL_MS = 300_000;

export interface LpAccounts {
  lpPortfolio: PublicKey;
  matcherCtx: PublicKey | null;
}

/** Matcher ctx from an ENABLED portfolio matcher config, else null. */
export function matcherCtxOfPortfolio(data: Uint8Array): PublicKey | null {
  if (!isPortfolioAccount(data)) return null; // F-3
  const trailer = V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
  if (data.length < PORTFOLIO_MATCHER_CONFIG_LEN + trailer) return null;
  const off = data.length - PORTFOLIO_MATCHER_CONFIG_LEN - trailer;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (!decodePortfolioMatcherControl(dv.getBigUint64(off + 96, true)).enabled) return null;
  return new PublicKey(data.subarray(off + 32, off + 64));
}

const cache = new Map<string, { v: LpAccounts; ts: number }>();

export function invalidateLpAccounts(programId: PublicKey, slab: PublicKey): void {
  const prefix = `${programId.toBase58()}|${slab.toBase58()}|`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Read-only fallback for a vault LP explicitly bound on-chain.
 * Never supplies an unverified matcher context.
 */
async function verifiedBoundVaultRead(
  connection: Connection,
  programId: PublicKey,
  slab: PublicKey,
  knownLp: PublicKey,
  assetIndex: number,
): Promise<LpAccounts | null> {
  const marketInfo = await connection.getAccountInfo(slab, "confirmed");

  if (!marketInfo || !marketInfo.owner.equals(programId)) {
    return null;
  }

  const marketData = new Uint8Array(marketInfo.data);
  if (!isV18MarketHeader(marketData)) return null;

  const binding = decodeAssetVaultLp(marketData, assetIndex);

  if (
    !binding?.bound ||
    !new PublicKey(binding.vaultLpPortfolio).equals(knownLp)
  ) {
    return null;
  }

  const info = await connection.getAccountInfo(knownLp, "confirmed");

  if (!info || !info.owner.equals(programId)) return null;

  const data = new Uint8Array(info.data);

  if (!isPortfolioAccount(data) || data.length < 80) {
    return null;
  }

  // Immutable provenance must match this market and account.
  if (!new PublicKey(data.subarray(16, 48)).equals(slab)) {
    return null;
  }

  if (!new PublicKey(data.subarray(48, 80)).equals(knownLp)) {
    return null;
  }

  return {
    lpPortfolio: knownLp,
    matcherCtx: null,
  };
}

export async function resolveLpAccounts(
  connection: Connection,
  programId: PublicKey,
  slab: PublicKey,
  knownLp: PublicKey | null = null,
  assetIndex = 0,
): Promise<LpAccounts | null> {
  // CANONICAL_ASSET_ISOLATION_V1
  // resolveMarketLp() currently selects the asset-0 trading LP.
  // Never reuse it as a read-only vault LP for another asset.
  if (!Number.isInteger(assetIndex) || assetIndex < 0) {
    return null;
  }

  if (assetIndex !== 0) {
    if (!knownLp) return null;
    return verifiedBoundVaultRead(
      connection, programId, slab, knownLp, assetIndex,
    ).catch(() => null);
  }

  const key = `${programId.toBase58()}|${slab.toBase58()}|${assetIndex}|${knownLp?.toBase58() ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.v;

  const pinned = knownLp ?? (PLAYGROUND_SLAB_META[slab.toBase58()]?.lp_portfolio_address
    ? new PublicKey(PLAYGROUND_SLAB_META[slab.toBase58()].lp_portfolio_address as string)
    : null);


  let canonical: Awaited<ReturnType<typeof resolveMarketLp>> = null;
  let canonicalError: unknown = null;

  try {
    canonical = await resolveMarketLp(
      connection, programId, slab, pinned,
    );
  } catch (error) {
    canonicalError = error;
  }

  if (canonical) {
    const found: LpAccounts = {
      lpPortfolio: canonical.pubkey,
      matcherCtx: canonical.matcherCtx,
    };
    cache.set(key, { v: found, ts: Date.now() });
    return found;
  }

  // Only an explicitly supplied, on-chain-bound vault LP
  // may use this read-only fallback.
  if (knownLp) {
    const fallback = await verifiedBoundVaultRead(
      connection, programId, slab, knownLp, assetIndex,
    ).catch(() => null);

    // Do not cache fallback: revocation must be observed
    // on the next read.
    if (fallback) return fallback;
  }

  if (canonicalError !== null) throw canonicalError;
  return null;

}

/** `["vault_lp", market]` under the wrapper program (P3 VaultLpStateV18 PDA). */
export function deriveVaultLpStatePda(programId: PublicKey, market: PublicKey, seed: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), market.toBuffer()], programId)[0];
}
