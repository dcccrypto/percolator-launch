/**
 * Rate-limited JSON-RPC client for the chain backfill.
 *
 * The key it is given is normally the LIVE KEEPER's, so this is deliberately gentle: a fixed
 * requests-per-second ceiling shared by every call (a batch of N costs N slots), exponential backoff
 * with jitter on 429/5xx/network errors, and a hard cap on retries. The URL (which carries the key)
 * is never logged or included in an error message.
 */
import type { ChainRpc, RpcTx, SigInfo } from "./chain-backfill";

export interface HttpRpcOptions {
  url: string;
  /** Sustained requests per second across all calls. Default 8. */
  rps?: number;
  /** Requests per HTTP batch for getTransaction. Default 8 (one batch per second at the default rate). */
  batch?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called with every request count so a caller can report RPC cost. */
  onRequests?: (n: number) => void;
}

export class RpcError extends Error {}

export function createHttpRpc(o: HttpRpcOptions): ChainRpc & { requests(): number } {
  const rps = Math.max(0.5, o.rps ?? 8);
  const batch = Math.max(1, o.batch ?? 8);
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const retries = o.maxRetries ?? 6;
  let nextSlot = 0; // earliest time the next request may start
  let total = 0;

  async function pace(n: number): Promise<void> {
    const t = now();
    const wait = Math.max(0, nextSlot - t);
    nextSlot = Math.max(t, nextSlot) + (n * 1000) / rps;
    if (wait > 0) await sleep(wait);
  }

  async function post(body: unknown, n: number): Promise<unknown> {
    let delay = 500;
    for (let attempt = 0; ; attempt++) {
      await pace(n);
      total += n;
      o.onRequests?.(n);
      try {
        const r = await fetchImpl(o.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        if (r.ok) return await r.json();
        if (r.status !== 429 && r.status < 500) throw new RpcError(`rpc http ${r.status}`);
        if (attempt >= retries) throw new RpcError(`rpc http ${r.status} after ${attempt + 1} attempts`);
        const ra = Number(r.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay * (0.8 + Math.random() * 0.4));
      } catch (e) {
        if (e instanceof RpcError) throw e;
        if (attempt >= retries) throw new RpcError("rpc network error");
        await sleep(delay * (0.8 + Math.random() * 0.4));
      }
      delay = Math.min(delay * 2, 30_000);
    }
  }

  return {
    requests: () => total,
    async getSignatures(address, before, limit): Promise<SigInfo[]> {
      const j = (await post({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [address, { limit, ...(before ? { before } : {}), commitment: "confirmed" }] }, 1)) as { result?: SigInfo[]; error?: unknown };
      if (!Array.isArray(j.result)) throw new RpcError("getSignaturesForAddress failed");
      return j.result.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ?? null }));
    },
    async getTransactions(signatures): Promise<Array<RpcTx | null>> {
      const out: Array<RpcTx | null> = [];
      for (let i = 0; i < signatures.length; i += batch) {
        const part = signatures.slice(i, i + batch);
        const reqs = part.map((sig, k) => ({ jsonrpc: "2.0", id: k, method: "getTransaction", params: [sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }));
        const res = (await post(reqs, part.length)) as Array<{ id: number; result?: RpcTx | null }>;
        if (!Array.isArray(res)) throw new RpcError("getTransaction batch failed");
        const byId = new Map(res.map((r) => [r.id, r.result ?? null]));
        for (let k = 0; k < part.length; k++) out.push(byId.get(k) ?? null);
      }
      return out;
    },
  };
}

/**
 * The devnet RPC URL for the backfill, from the environment only. Preference order: an explicit
 * CHAIN_RPC_URL; the dedicated charts key (CHART_BACKFILL_HELIUS_KEY, then HELIUS_CHARTS_API_KEY);
 * and only as a last resort the live keeper's key (HELIUS_KEEPER_API_KEY), which the live keeper shares,
 * so `usedKeeperKey` is reported and the script runs at the gentle default rate in that case.
 */
export function resolveBackfillRpc(env: Record<string, string | undefined>): { url: string; usedKeeperKey: boolean } | null {
  const explicit = env.CHAIN_RPC_URL?.trim();
  if (explicit) return { url: explicit, usedKeeperKey: false };
  const dedicated = (env.CHART_BACKFILL_HELIUS_KEY ?? env.HELIUS_CHARTS_API_KEY)?.trim();
  if (dedicated) return { url: `https://devnet.helius-rpc.com/?api-key=${dedicated}`, usedKeeperKey: false };
  const keeper = env.HELIUS_KEEPER_API_KEY?.trim();
  if (keeper) return { url: `https://devnet.helius-rpc.com/?api-key=${keeper}`, usedKeeperKey: true };
  return null;
}
