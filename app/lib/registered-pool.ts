/**
 * The REGISTERED price venue of a market (2026-10-01, SI pool mismatch).
 *
 * The keeper pushes a market's on-chain mark from the pool recorded at registration (the
 * `markets` row's `dex_pool_address`, mirrored in the registry Blob with its `dexType`). The chart
 * (GeckoTerminal "top pool" for the mint) and /api/oracle/resolve (DexScreener's most liquid
 * pair) re-resolved a "best" pool instead: for SI (8WC8…) they showed pool 7Nj7m… while the
 * market is priced from 21bzHy…, so the displayed price was not the price the market trades at.
 * Every display path for a registered market reads its venue from here. Server-only.
 */
import { PublicKey } from "@solana/web3.js";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { readRegisteredMarkets } from "@/lib/playground-registered-markets";

/** The lookup itself failed (DB error / exception): NOT "unregistered", and never cached. */
export class RegisteredPoolLookupError extends Error {
  constructor(cause: unknown) {
    super("registered pool lookup failed", { cause });
    this.name = "RegisteredPoolLookupError";
  }
}

export interface RegisteredPool {
  slabAddress: string;
  pool: string;
  /** Keeper dex type from the registry ("pumpswap" | "meteora-dlmm" | …), when known. */
  dexType: string | null;
}

const TTL_MS = 60_000;
const REGISTERED_MINT_QUERY_TIMEOUT_MS = 1_500;
const MAX_ENTRIES = 500;
const bySlab = new Map<string, { v: RegisteredPool | null; at: number }>();
const byMint = new Map<string, { v: RegisteredPool | null; at: number }>();
/** Single-flight is process-local; bound distinct cold mint lookups. */
const MAX_IN_FLIGHT_MINT_LOOKUPS = 64;
const mintLookupInFlight = new Map<string, Promise<RegisteredPool | null>>();

function remember<K>(m: Map<K, { v: RegisteredPool | null; at: number }>, k: K, v: RegisteredPool | null): RegisteredPool | null {
  if (m.size >= MAX_ENTRIES) m.delete(m.keys().next().value as K);
  m.set(k, { v, at: Date.now() });
  return v;
}

function validPubkey(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * No Supabase configured (local dev / a deploy without the service key) is a supported mode, as
 * in /api/markets: there are no registered markets to honour, so lookups answer "not registered"
 * (cacheable, top-pool fallback) instead of a permanent "lookup failed" (review of #2735).
 */
function supabaseConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

async function dexTypeFor(slab: string): Promise<string | null> {
  try {
    return (await readRegisteredMarkets(AbortSignal.timeout(1_500))).find((m) => m.slabAddress === slab)?.dexType ?? null;
  } catch {
    return null;
  }
}

/**
 * The registered pool of the market at `slab`. When `mint` is given the row's mainnet CA must
 * match it (a slab can only vouch for its own token). null = not registered. Throws
 * RegisteredPoolLookupError when the lookup fails (supabase-js RETURNS errors; never cached).
 */
export async function registeredPoolForSlab(slab: string, mint?: string): Promise<RegisteredPool | null> {
  if (!validPubkey(slab)) return null;
  const key = `${slab}|${mint ?? ""}`;
  const hit = bySlab.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  if (!supabaseConfigured()) return null;
  let data: unknown;
  try {
    const res = await getServiceClient()
      .from("markets")
      .select("slab_address,dex_pool_address,mainnet_ca")
      .eq("slab_address", slab)
      .eq("network", getServerNetwork())
      .maybeSingle();
    if (res.error) throw res.error;
    data = res.data;
  } catch (e) {
    throw new RegisteredPoolLookupError(e); // not cached: a DB blip must not pin "unregistered"
  }
  const row = data as { slab_address: string; dex_pool_address: string | null; mainnet_ca: string | null } | null;
  if (!row || !validPubkey(row.dex_pool_address)) return remember(bySlab, key, null);
  if (mint && row.mainnet_ca !== mint) return remember(bySlab, key, null);
  return remember(bySlab, key, { slabAddress: slab, pool: row.dex_pool_address, dexType: await dexTypeFor(slab) });
}

/**
 * The registered pool of the live (keeper-active) market for mainnet token `mint`, newest first.
 * null when no market is registered for it. Throws RegisteredPoolLookupError on a failed lookup.
 */
export async function registeredPoolForMint(mint: string): Promise<RegisteredPool | null> {
  if (!validPubkey(mint)) return null;
  const hit = byMint.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  if (!supabaseConfigured()) return null;

  const pending = mintLookupInFlight.get(mint);
  if (pending) return pending;

  if (mintLookupInFlight.size >= MAX_IN_FLIGHT_MINT_LOOKUPS) {
    throw new RegisteredPoolLookupError(
      new Error("registered mint lookups are busy")
    );
  }

  const task = queryRegisteredPoolForMint(mint);
  mintLookupInFlight.set(mint, task);

  const cleanup = () => {
    if (mintLookupInFlight.get(mint) === task) {
      mintLookupInFlight.delete(mint);
    }
  };

  // Release the slot on both success and failure.
  void task.then(cleanup, cleanup);
  return task;
}

async function queryRegisteredPoolForMint(
  mint: string
): Promise<RegisteredPool | null> {
  let data: unknown;
  try {
    const res = await getServiceClient()
      .from("markets")
      .select("slab_address,dex_pool_address,created_at")
      .eq("mainnet_ca", mint)
      .eq("network", getServerNetwork())
      .eq("keeper_status", "active")
      .order("created_at", { ascending: false })
      .abortSignal(AbortSignal.timeout(REGISTERED_MINT_QUERY_TIMEOUT_MS))
      .limit(1);
    if (res.error) throw res.error;
    data = res.data;
  } catch (e) {
    throw new RegisteredPoolLookupError(e);
  }
  const row = (data as Array<{ slab_address: string; dex_pool_address: string | null }> | null)?.[0];
  if (!row || !validPubkey(row.dex_pool_address)) return remember(byMint, mint, null);
  return remember(byMint, mint, { slabAddress: row.slab_address, pool: row.dex_pool_address, dexType: await dexTypeFor(row.slab_address) });
}

/** Test seam. */
export function __clearRegisteredPoolCache(): void {
  bySlab.clear();
  byMint.clear();
}
