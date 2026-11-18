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

const V17_PORTFOLIO_MAGIC = new Uint8Array([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16;
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
  cache.delete(`${programId.toBase58()}|${slab.toBase58()}`);
}

export async function resolveLpAccounts(
  connection: Connection,
  programId: PublicKey,
  slab: PublicKey,
  knownLp: PublicKey | null = null,
): Promise<LpAccounts | null> {
  const key = `${programId.toBase58()}|${slab.toBase58()}|${knownLp?.toBase58() ?? ""}`;
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.ts : -1;
  if (hit && age >= 0 && age < TTL_MS) return hit.v; // negative age = clock stepped back: miss

  const pinned = knownLp ?? (PLAYGROUND_SLAB_META[slab.toBase58()]?.lp_portfolio_address
    ? new PublicKey(PLAYGROUND_SLAB_META[slab.toBase58()].lp_portfolio_address as string)
    : null);
  let found: LpAccounts | null = null;
  if (pinned) {
    const info = await connection.getAccountInfo(pinned, "confirmed");
    if (info) found = { lpPortfolio: pinned, matcherCtx: matcherCtxOfPortfolio(new Uint8Array(info.data)) };
  }
  if (!found && !knownLp) {
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from(V17_PORTFOLIO_MAGIC).toString("base64"), encoding: "base64" } },
        { memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: slab.toBase58() } },
      ],
    });
    for (const { pubkey, account } of accounts) {
      const ctx = matcherCtxOfPortfolio(new Uint8Array(account.data));
      if (ctx) {
        found = { lpPortfolio: pubkey, matcherCtx: ctx };
        break;
      }
    }
  }
  if (found) cache.set(key, { v: found, ts: Date.now() });
  return found;
}

/** `["vault_lp", market]` under the wrapper program (P3 VaultLpStateV18 PDA). */
export function deriveVaultLpStatePda(programId: PublicKey, market: PublicKey, seed: string): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), market.toBuffer()], programId)[0];
}
