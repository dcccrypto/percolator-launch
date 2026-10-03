import { PublicKey } from "@solana/web3.js";
import { getServiceClient, getServerNetwork } from "@/lib/supabase";
import { getServerConnection } from "@/lib/server-rpc";
import { getConfig } from "@/lib/config";

/**
 * GH#2795: slabs of markets that belong to an abandoned wrapper.
 *
 * After the 2026-10-01 relaunch /api/markets stopped listing markets whose slab is
 * owned by another program (#2714), and /api/markets/[slab] 404s them. The `trades`
 * table carries no program, so the leaderboard and a trader's history and stats kept
 * counting fills on those retired markets and linking to pages that no longer open.
 *
 * The rule is the one /api/markets/[slab] applies: a registry slab whose account
 * exists and is owned by a program other than the current wrapper is retired. The
 * trade readers EXCLUDE these slabs rather than including only the current ones, so:
 *   - a market created on the current wrapper is never hidden, even before it reaches
 *     the registry or this cache;
 *   - an unreadable slab (RPC gap, closed account) is not retired — degrade, don't hide;
 *   - any failure returns [] and the readers behave exactly as before this change.
 *
 * Only the owner is needed, so accounts are read with a zero-length data slice. The set
 * changes only when a wrapper is retired, so a complete answer is cached per instance.
 */

const CHUNK = 100;
const CACHE_TTL_MS = 5 * 60_000;
const READ_TIMEOUT_MS = 4_000;

let cache: { at: number; slabs: string[] } | null = null;
let inflight: Promise<string[]> | null = null;

/** Test hook: forget the cached set. */
export function resetRetiredSlabCache(): void {
  cache = null;
  inflight = null;
}

async function compute(): Promise<{ slabs: string[]; complete: boolean }> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("markets")
    .select("slab_address")
    .eq("network", getServerNetwork())
    .not("slab_address", "is", null);
  if (error) throw error;

  const keys: Array<{ slab: string; key: PublicKey }> = [];
  for (const slab of new Set((data ?? []).map((r) => String((r as { slab_address: unknown }).slab_address ?? "")))) {
    try {
      keys.push({ slab, key: new PublicKey(slab) });
    } catch {
      // Not an address — cannot be a slab of anything.
    }
  }

  const wrapper = getConfig().programId;
  const conn = getServerConnection("confirmed");
  const retired: string[] = [];
  let complete = true;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    try {
      const infos = await conn.getMultipleAccountsInfo(
        chunk.map((c) => c.key),
        { commitment: "confirmed", dataSlice: { offset: 0, length: 0 } },
      );
      infos.forEach((info, j) => {
        if (info && info.owner.toBase58() !== wrapper) retired.push(chunk[j].slab);
      });
    } catch {
      complete = false; // this chunk stays unknown: its slabs are not retired
    }
  }
  return { slabs: retired, complete };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("retired-slabs: timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Slabs whose trades must not be shown: registry markets owned by another program.
 * Never throws; [] means "no filter".
 */
export async function getRetiredSlabs(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.slabs;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { slabs, complete } = await withTimeout(compute(), READ_TIMEOUT_MS);
      // A partial answer is used for this request but not cached, so the next one retries.
      if (complete) cache = { at: Date.now(), slabs };
      return slabs;
    } catch (err) {
      console.warn("[retired-slabs] unavailable, trades unfiltered:", err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
