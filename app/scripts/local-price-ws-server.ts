#!/usr/bin/env npx tsx
/**
 * local-price-ws-server.ts — Phase 1 of the trade-terminal rebuild
 * (see ~/percolator-v17-devnet-test/playground/BUILD-LOG.md).
 *
 * A local, dev-only WebSocket server that speaks the EXACT same wire
 * protocol as percolator-api's production price feed
 * (percolator-api/src/routes/ws.ts): clients send
 * `{type:"subscribe", slabAddress}` / `{type:"unsubscribe", slabAddress}`,
 * server replies with `{type:"price", slab, price, timestamp}` (price is a
 * USD float, same as production's `flushPriceUpdate`). This makes it a true
 * drop-in for `NEXT_PUBLIC_WS_URL` — nothing in the client
 * (lib/priceStore/*) needs to change if this is later pointed at the real
 * backend instead.
 *
 * HYBRID price source (2026-07-10):
 *   - Pyth Hermes SSE stream for the 4 majors that HAVE a Pyth feed (SOL,
 *     JUP, TRUMP, PENGU) — continuous ~2-3 updates/sec, like Hyperliquid's
 *     index price. A single mainnet DEX pool's spot only moves on swaps
 *     (measured: majors sat FROZEN at 1 distinct price for 19s under
 *     DEX-only polling), so Pyth is the right source for anything that has
 *     a feed.
 *   - Mainnet DEX-pool polling (via `../lib/priceStore/dexPoolReader.ts`,
 *     a cited, function-for-function port of `~/percolator-oracle-keeper/
 *     src/cross-cluster/price-reader.ts`'s `readPoolPriceE6`) for the 2
 *     pump.fun coins with NO Pyth feed (BURNIE, Percolator). These are
 *     WSOL-quoted PumpSwap pools, so their USD conversion uses the
 *     latest Pyth SOL/USD price captured from the stream above (falling
 *     back to a one-off DEX read of the SOL pool if Pyth SOL hasn't
 *     arrived yet) — no separate continuous SOL poll needed, which keeps
 *     Helius RPC load to just these 2 pools most cycles.
 *
 * Market list mirrors `app/PLAYGROUND.md`'s "Live markets" table
 * (2026-07-10 born-immortal re-seed).
 *
 * Usage:
 *   MAINNET_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... \
 *     npx tsx scripts/local-price-ws-server.ts
 *
 *   Reuse the mainnet RPC URL already configured for the cross-cluster
 *   keeper at ~/percolator-oracle-keeper/.env (MAINNET_RPC_URL=...) rather
 *   than provisioning a new key. Falls back to the public mainnet RPC
 *   (rate-limited) if MAINNET_RPC_URL is unset — never hardcode a live key
 *   in this tracked file (see CLAUDE.md / PLAYGROUND.md guardrails).
 *
 * Then point the Next.js app at it (in app/.env.local):
 *   NEXT_PUBLIC_WS_URL=ws://localhost:8787
 *
 * Optional env:
 *   PRICE_WS_PORT     (default 8787)
 *   PRICE_WS_POLL_MS  (default 500 — DEX-poll interval for the 2 pump.fun markets)
 *   HERMES_BASE       (default https://hermes.pyth.network)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { detectDexType } from "@percolatorct/sdk";
import { WebSocketServer, WebSocket } from "ws";
import { readPoolPriceE6, type DecimalsCache, type PoolReadEntry } from "../lib/priceStore/dexPoolReader";
import { isBlockedSlab } from "../lib/blocklist";

// Railway (and most PaaS) inject PORT and route the public domain to it, so
// prefer it; PRICE_WS_PORT is the local-dev override; 8787 is the local default.
const PORT = Number(process.env.PORT ?? process.env.PRICE_WS_PORT ?? 8787);
// DEX-poll interval for the 2 pump.fun-only markets (BURNIE, Percolator) —
// their pool's spot only moves on swaps, so this is a "check for a new
// swap" cadence, not a continuous tick like Pyth.
const POLL_INTERVAL_MS = Number(process.env.PRICE_WS_POLL_MS ?? 500);
const HERMES_BASE = process.env.HERMES_BASE ?? "https://hermes.pyth.network";
// Shared with the cross-cluster keeper (~/percolator-oracle-keeper/.env) —
// same Helius mainnet key. Only used for the 2 pump.fun DEX polls (+ an
// occasional one-off SOL-pool fallback read), so load is far lower than a
// full 6-market DEX poll would be.
//
// NEVER hardcode a live API key here — this file is tracked on the public
// `playground` branch (see CLAUDE.md rule 3 / PLAYGROUND.md guardrails; this
// repo's git history already contains a prior Helius-key leak + rotation
// under `scripts/*` one-off files — don't repeat it). Set MAINNET_RPC_URL in
// the environment (locally via shell/`.env.local`-style export, in Railway
// via `railway variables set`); this falls back to the public mainnet RPC
// (heavily rate-limited, fine for a quick smoke test, not for sustained
// polling) only when it's unset.
const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
if (!MAINNET_RPC_URL) {
  console.warn(
    "[local-price-ws] MAINNET_RPC_URL not set — falling back to the public mainnet RPC " +
      "(https://api.mainnet-beta.solana.com), which is heavily rate-limited. Set " +
      "MAINNET_RPC_URL to a dedicated key (e.g. the same Helius mainnet key configured " +
      "for percolator-oracle-keeper) for reliable operation.",
  );
}

// ── Pyth Hermes: the 4 majors that have a feed ──────────────────────────────

/** Pyth mainnet crypto price-feed IDs, keyed by the CURRENT devnet slab. */
const PYTH_FEED: Record<string, string> = {
  "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", // SOL
  "B22quVNFuuEYwx4dQigwn41BMBuk9ZcTdMik4UH7PshY": "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996", // JUP
  "6Hqn4VoMHjvCb1XWQkpnJ1UE3xAverJezVdk3czvgQxh": "879551021853eec7a7dc827578e8e69da7e4fa8148339aa0d3d5296405be4b1a", // TRUMP
  "Gbpuam5UYV4MpC1DmGeTVZWtT4UGDmahMW2vo4p1MBAf": "bed3097008b9b5e3c93bec20be79cb43986b85a996475589351a21e67bae9b61", // PENGU
};
const idToSlab = new Map(Object.entries(PYTH_FEED).map(([slab, id]) => [id.toLowerCase(), slab]));
const PYTH_LABELS: Record<string, string> = {
  "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV": "SOL/USDC",
  "B22quVNFuuEYwx4dQigwn41BMBuk9ZcTdMik4UH7PshY": "JUP/USDC",
  "6Hqn4VoMHjvCb1XWQkpnJ1UE3xAverJezVdk3czvgQxh": "TRUMP/USDC",
  "Gbpuam5UYV4MpC1DmGeTVZWtT4UGDmahMW2vo4p1MBAf": "PENGU/USDC",
};
const SOL_SLAB = "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV";

// ── DEX poll: the 2 pump.fun markets with no Pyth feed ──────────────────────

interface DexMarketEntry extends PoolReadEntry {
  slab: string;
}

/**
 * Seed list, mirroring app/PLAYGROUND.md's "Live markets" table (2026-07-10
 * born-immortal re-seed). These are NOT the whole story any more — see
 * refreshDbMarkets(): every market registered since is discovered from the
 * database instead of being pinned here.
 *
 * Pinning was the reason a newly launched market never ticked. The feed only
 * ever streamed these six slabs, so a market created after this file was last
 * deployed had no live price at all and only moved when the page re-read
 * on-chain — indistinguishable from a broken price feed.
 */
const SEED_DEX_MARKETS: DexMarketEntry[] = [
  { slab: "GPpyVaHAEJ8u6W9UAyCPp6tuQB2Chm1Z6uLUKA9ePJBC", poolAddress: "5tYFviFWQRKV9BJSTHGitbdqEYC1BGUgRUDnSADUXqJP", dexType: "pumpswap", label: "BURNIE/WSOL" },
  { slab: "FGaUkXepxCggbmpbgXDWUZ3V2CGSh6MeDCU6KLTLShbH", poolAddress: "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW", dexType: "pumpswap", label: "PERC/WSOL" },
];

/**
 * Live DEX market list = the seed above plus every `keeper_status='active'`
 * market in the database, refreshed on an interval. Same source of truth the
 * oracle keeper reads, so a market starts ticking as soon as it registers —
 * no redeploy of this service.
 */
let dexMarkets: DexMarketEntry[] = [...SEED_DEX_MARKETS];

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
const DB_REFRESH_MS = 60_000;

/** Pool -> dexType, resolved from the pool account's on-chain owner and cached
 *  for the process. dex_type is deliberately not a database column: the owner
 *  program is authoritative and a stored copy could disagree with chain. */
const dexTypeByPool = new Map<string, PoolReadEntry["dexType"]>();

/**
 * Rebuild `dexMarkets` from the database.
 *
 * Failure is a no-op: the previous list keeps streaming rather than the feed
 * going silent because one query failed.
 */
async function refreshDbMarkets(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/markets` +
      `?select=slab_address,dex_pool_address,symbol` +
      `&keeper_status=eq.active&network=eq.devnet&dex_pool_address=not.is.null`;
    const resp = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[local-price-ws] market refresh: HTTP ${resp.status} — keeping the previous list`);
      return;
    }
    const rows = (await resp.json()) as Array<{
      slab_address: string; dex_pool_address: string; symbol: string | null;
    }>;
    if (!Array.isArray(rows)) return;

    // Classify any pool we have not seen before, from its on-chain owner.
    const unknown = rows.map((r) => r.dex_pool_address).filter((p) => p && !dexTypeByPool.has(p));
    for (let i = 0; i < unknown.length; i += 100) {
      const chunk = unknown.slice(i, i + 100);
      const infos = await mainnetConn.getMultipleAccountsInfo(
        chunk.map((p) => new PublicKey(p)),
        "confirmed",
      );
      infos.forEach((info, j) => {
        if (!info) return;
        const dex = detectDexType(info.owner);
        if (dex) dexTypeByPool.set(chunk[j], dex as PoolReadEntry["dexType"]);
      });
    }

    const seeded = new Set(SEED_DEX_MARKETS.map((m) => m.slab));
    const discovered: DexMarketEntry[] = [];
    for (const r of rows) {
      if (seeded.has(r.slab_address)) continue;      // already pinned above
      if (PYTH_FEED[r.slab_address]) continue;        // streamed off Pyth instead
      const dexType = dexTypeByPool.get(r.dex_pool_address);
      if (!dexType) continue;                         // unclassifiable — never guess
      discovered.push({
        slab: r.slab_address,
        poolAddress: r.dex_pool_address,
        dexType,
        label: `${r.symbol ?? r.slab_address.slice(0, 8)}/WSOL`,
      });
    }
    // Seeds go through the blocklist too: a pinned entry used to stream
    // FOREVER regardless of retirement — only a redeploy could silence it
    // (2026-07-31 audit).
    const next = [...SEED_DEX_MARKETS, ...discovered].filter((m) => !isBlockedSlab(m.slab));
    if (next.length !== dexMarkets.length) {
      console.log(`[local-price-ws] market list: ${dexMarkets.length} -> ${next.length} (${discovered.length} from db)`);
    }
    // Evict cached prices for slabs leaving the list: without this, a client
    // subscribing to a RETIRED slab was replayed the last pre-retirement
    // price stamped with a FRESH timestamp — a frozen price presented as
    // live (2026-07-31 audit).
    const liveSlabs = new Set(next.map((m) => m.slab));
    for (const slab of lastPriceE6.keys()) {
      if (!liveSlabs.has(slab) && !PYTH_FEED[slab]) {
        lastPriceE6.delete(slab);
        console.log(`[local-price-ws] evicted cached price for removed market ${slab.slice(0, 8)}…`);
      }
    }
    dexMarkets = next;
  } catch (err) {
    console.warn(
      "[local-price-ws] market refresh failed — keeping the previous list:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Fallback SOL/USDC raydium-clmm pool, used only if Pyth SOL hasn't arrived yet. */
const SOL_FALLBACK_ENTRY: PoolReadEntry = {
  poolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
  dexType: "raydium-clmm",
  label: "SOL/USDC (fallback)",
};

const mainnetConn = new Connection(MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const decimalsCache: DecimalsCache = new Map();

/** Latest SOL/USD price (e6) captured from the Pyth stream — feeds the 2 WSOL-quoted PumpSwap markets' USD conversion. */
let latestSolPriceE6: bigint | undefined;

const lastPriceE6 = new Map<string, bigint>();

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>; // slab addresses
}
const clients = new Set<ClientState>();

const wss = new WebSocketServer({ port: PORT });

function sendPrice(ws: WebSocket, slab: string, priceE6: bigint): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "price",
      slab,
      price: Number(priceE6) / 1_000_000,
      timestamp: Date.now(),
    }),
  );
}

function broadcast(slab: string, priceE6: bigint): void {
  for (const client of clients) {
    if (client.subscriptions.has(slab)) sendPrice(client.ws, slab, priceE6);
  }
}

wss.on("connection", (ws) => {
  const client: ClientState = { ws, subscriptions: new Set() };
  clients.add(client);
  console.log(`[local-price-ws] client connected (${clients.size} total)`);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; slabAddress?: string };
      if (msg.type === "subscribe" && msg.slabAddress) {
        client.subscriptions.add(msg.slabAddress);
        // Send the last-known price immediately (if any) — mirrors
        // production's "send initial data for price channels" so the
        // client isn't blank until the next update.
        const last = lastPriceE6.get(msg.slabAddress);
        if (last !== undefined) sendPrice(ws, msg.slabAddress, last);
      } else if (msg.type === "unsubscribe" && msg.slabAddress) {
        client.subscriptions.delete(msg.slabAddress);
      }
    } catch {
      /* ignore malformed messages — local dev tool, not a hardened server */
    }
  });

  ws.on("close", () => {
    clients.delete(client);
    console.log(`[local-price-ws] client disconnected (${clients.size} total)`);
  });

  ws.on("error", (err) => {
    console.warn("[local-price-ws] client socket error:", err instanceof Error ? err.message : err);
  });
});

// ── Pyth Hermes stream (4 majors) ───────────────────────────────────────────

type ParsedPrice = { id: string; price: { price: string; expo: number } };
function applyParsed(parsed: ParsedPrice[]): void {
  for (const item of parsed) {
    const slab = idToSlab.get(String(item.id).toLowerCase().replace(/^0x/, ""));
    if (!slab) continue;
    const priceUsd = Number(item.price.price) * Math.pow(10, item.price.expo);
    if (!(priceUsd > 0)) continue;
    const priceE6 = BigInt(Math.round(priceUsd * 1_000_000));
    lastPriceE6.set(slab, priceE6);
    broadcast(slab, priceE6);
    if (slab === SOL_SLAB) latestSolPriceE6 = priceE6;
  }
}

// Live SSE stream from Pyth Hermes: every feed update is pushed the instant Pyth
// publishes (~2-3×/sec) — continuous ticking, like Hyperliquid's index price.
// Auto-reconnects.
async function streamPrices(): Promise<void> {
  const qs = Object.values(PYTH_FEED).map((id) => `ids[]=0x${id}`).join("&");
  const url = `${HERMES_BASE}/v2/updates/price/stream?${qs}&parsed=true`;
  for (;;) {
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`hermes stream HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const evt = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const json = dataLine.slice(5).trim();
          if (!json || json === "[DONE]") continue;
          try {
            const body = JSON.parse(json) as { parsed?: ParsedPrice[] };
            if (body.parsed) applyParsed(body.parsed);
          } catch {
            /* skip malformed event */
          }
        }
      }
    } catch (err) {
      console.warn("[local-price-ws] hermes stream error, reconnecting —", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ── DEX poll (2 pump.fun markets) ───────────────────────────────────────────

// Low-volume skip logging: warn at most once per market per this many
// consecutive skips, so a persistently-thin/un-seeded pool doesn't spam
// stdout every poll tick.
const SKIP_LOG_EVERY_N = 20;
const skipStreak = new Map<string, number>();

function logSkip(label: string, key: string, reason: string | undefined): void {
  const n = (skipStreak.get(key) ?? 0) + 1;
  skipStreak.set(key, n);
  if (n === 1 || n % SKIP_LOG_EVERY_N === 0) {
    console.warn(`[local-price-ws] ${label} skipped (x${n}): ${reason ?? "unknown reason"}`);
  }
}

/**
 * One DEX-poll cycle: read the 2 pump.fun pools and broadcast fresh prices.
 * Per-market errors are caught individually so one bad pool read (RPC
 * hiccup, transient 429, etc.) never kills the loop or blocks the other
 * market.
 *
 * The seeded entries are WSOL-quoted PumpSwap pools, so they need a
 * SOL/USD price to convert to USD — prefer the latest value captured off
 * the (continuous, more accurate) Pyth stream; only fall back to a one-off
 * DEX read of the SOL pool if Pyth SOL hasn't arrived yet (e.g. right at
 * startup, before the first stream event lands).
 */
async function pollOnce(): Promise<void> {
  let solPriceE6 = latestSolPriceE6;
  if (solPriceE6 === undefined) {
    try {
      const solResult = await readPoolPriceE6(mainnetConn, SOL_FALLBACK_ENTRY, decimalsCache);
      if (!solResult.skipped) {
        solPriceE6 = solResult.priceE6;
      } else {
        logSkip(SOL_FALLBACK_ENTRY.label, "sol-fallback", solResult.skipReason);
      }
    } catch (err) {
      console.warn("[local-price-ws] SOL fallback read error:", err instanceof Error ? err.message : err);
    }
  }

  await Promise.all(
    dexMarkets.map(async (entry) => {
      try {
        const result = await readPoolPriceE6(mainnetConn, entry, decimalsCache, solPriceE6);
        if (result.skipped) {
          logSkip(entry.label, entry.slab, result.skipReason);
          return;
        }
        skipStreak.delete(entry.slab);
        lastPriceE6.set(entry.slab, result.priceE6);
        broadcast(entry.slab, result.priceE6);
      } catch (err) {
        console.warn(`[local-price-ws] ${entry.label} read error:`, err instanceof Error ? err.message : err);
      }
    }),
  );
}

async function pollLoop(): Promise<void> {
  for (;;) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

console.log(
  `[local-price-ws] listening on ws://localhost:${PORT} — hybrid: Pyth Hermes (SSE, ~2-3/s) for 4 majors + DEX poll (${POLL_INTERVAL_MS}ms) for 2 pump.fun markets`,
);
for (const slab of Object.keys(PYTH_FEED)) {
  console.log(`  ${(PYTH_LABELS[slab] ?? "?").padEnd(11)} slab=${slab.slice(0, 8)}…  pyth=${PYTH_FEED[slab].slice(0, 8)}…`);
}
for (const m of SEED_DEX_MARKETS) {
  console.log(`  ${m.label.padEnd(11)} slab=${m.slab.slice(0, 8)}…  pool=${m.poolAddress.slice(0, 8)}… (${m.dexType})`);
}

// Discover database-registered markets before the first poll, then keep the
// list current. Runs alongside the price loops; a failure never stops them.
void (async () => {
  await refreshDbMarkets();
  setInterval(() => { void refreshDbMarkets(); }, DB_REFRESH_MS);
})();

void streamPrices();
void pollLoop();

process.on("SIGINT", () => {
  console.log("\n[local-price-ws] shutting down");
  wss.close();
  process.exit(0);
});
