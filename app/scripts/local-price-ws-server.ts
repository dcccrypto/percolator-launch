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
 * Price source (2026-10-01, no Pyth):
 *   - Mainnet DEX-pool polling (via `../lib/priceStore/dexPoolReader.ts`, a cited,
 *     function-for-function port of `~/percolator-oracle-keeper/src/cross-cluster/
 *     price-reader.ts`'s `readPoolPriceE6`) for every market registered for the keeper.
 *   - SOL/USD (the USD conversion of the WSOL-quoted pools) from Jupiter's Price API
 *     (lib/jupiter-price.ts), refreshed every SOL_REFRESH_MS; when Jupiter is unreachable or its
 *     value is stale, a one-off DEX read of the SOL/USDC pool instead. The Pyth Hermes stream
 *     this used before is gone: the playground does not use Pyth.
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
 *   PRICE_WS_SOL_MS   (default 5000 — Jupiter SOL/USD refresh interval)
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { detectDexType } from "@percolatorct/sdk";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { readPoolPriceE6, type DecimalsCache, type PoolReadEntry } from "../lib/priceStore/dexPoolReader";
import { createBatchPoolReader } from "../lib/priceStore/dexPoolBatchReader";
import { fetchJupiterSolUsdE6 } from "../lib/jupiter-price";
import { pickSolUsdE6 } from "../lib/priceStore/solUsd";
import { isBlockedSlab } from "../lib/blocklist";
import { createTickService, MAX_BODY_BYTES } from "../lib/chart/tick-service";
import { bearerMatches } from "../lib/chart/tick-ingest";
import { MAX_WATCHED_SLABS, RateLimiter, WS_MAX_PAYLOAD_BYTES, checkSubscribe, clientKey, isKnownSlab } from "../lib/chart/ws-guards";
import { getPgCandleStore, getPgSql } from "../lib/chart/pg-store";
import { createTradeFeed } from "../lib/chart/trade-feed";
import type { TickMessage } from "../lib/chart/perp-types";

// Railway (and most PaaS) inject PORT and route the public domain to it, so
// prefer it; PRICE_WS_PORT is the local-dev override; 8787 is the local default.
const PORT = Number(process.env.PORT ?? process.env.PRICE_WS_PORT ?? 8787);
// DEX-poll interval for the 2 pump.fun-only markets (BURNIE, Percolator) —
// their pool's spot only moves on swaps, so this is a "check for a new
// swap" cadence, not a continuous tick like Pyth.
const POLL_INTERVAL_MS = Number(process.env.PRICE_WS_POLL_MS ?? 500);
/** Jupiter SOL/USD refresh interval (an HTTP call, no RPC). */
const SOL_REFRESH_MS = Number(process.env.PRICE_WS_SOL_MS ?? 5000);
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

// ── DEX poll: every keeper-registered market ───────────────────────────────

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
// RELAUNCH (2026-10-01): EMPTY. Both pinned pump.fun slabs were on the abandoned
// GnwdeQr… wrapper, so polling them cost two mainnet pool reads (three RPC calls each)
// every cycle for markets no client can list. Relaunch markets come from the database
// (refreshDbMarkets) as soon as they register.
const SEED_DEX_MARKETS: DexMarketEntry[] = [];

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
      if (!liveSlabs.has(slab)) {
        lastPriceE6.delete(slab);
        console.log(`[local-price-ws] evicted cached price for removed market ${slab.slice(0, 8)}…`);
      }
    }
    dexMarkets = next;
    marketsLoaded = true;
  } catch (err) {
    console.warn(
      "[local-price-ws] market refresh failed — keeping the previous list:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** SOL/USDC raydium-clmm pool, read only when Jupiter's SOL/USD is missing or stale. */
const SOL_FALLBACK_ENTRY: PoolReadEntry = {
  poolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
  dexType: "raydium-clmm",
  label: "SOL/USDC (fallback)",
};

const mainnetConn = new Connection(MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const decimalsCache: DecimalsCache = new Map();
// Batched reads: static pool facts resolved once per minute, every changing account of every market
// read per cycle with getMultipleAccountsInfo (<=100 per call). See lib/priceStore/dexPoolBatchReader.ts.
const batchReader = createBatchPoolReader(mainnetConn, decimalsCache);

/** Latest SOL/USD (e6) from Jupiter and when it arrived: the WSOL-quoted pools' USD conversion. */
let jupiterSol: { e6: bigint; at: number } | null = null;

const lastPriceE6 = new Map<string, bigint>();

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>; // slab addresses
}
const clients = new Set<ClientState>();

// ── Perp chart ticks (keeper -> here -> browsers) ──────────────────────────
// The keeper POSTs every landed mark push (plus the raw pool price it read) to
// POST /ingest/ticks. This process stamps (epoch, seq), folds the ticks into the canonical
// candles, persists them (when a database URL is set), and pushes each tick to every client
// subscribed to that slab over the same socket the price feed already uses.
// See ~/percolator-ops/ledger/charts-perp-standard-plan-2026-10-04.md.
const TICK_INGEST_KEY = process.env.TICK_INGEST_KEY;
const TICK_FLUSH_MS = Number(process.env.TICK_FLUSH_MS ?? 10_000);
const tickStore = getPgCandleStore(process.env, 2);
/** The market set: database-registered active markets (dexMarkets) plus any TICK_EXTRA_SLABS. Until the first
 *  successful database read the set is "not loaded" and only the address format is enforced. */
let marketsLoaded = (process.env.TICK_EXTRA_SLABS ?? "").trim().length > 0 && !SUPABASE_URL;
const knownSlabs = (): ReadonlySet<string> => {
  const set = new Set(dexMarkets.map((m) => m.slab));
  for (const x of (process.env.TICK_EXTRA_SLABS ?? "").split(",").map((v) => v.trim()).filter(Boolean)) set.add(x);
  return set;
};
const tickService = createTickService({
  key: TICK_INGEST_KEY, store: tickStore, epoch: randomUUID(),
  isKnownSlab: (slab) => isKnownSlab(slab, knownSlabs(), marketsLoaded, isBlockedSlab),
});
const ticksLimiter = new RateLimiter(30, 60_000); // GET /ticks: 30 per minute per client
const tickRequestStartedAt = Date.now();

const CORS = { "Access-Control-Allow-Origin": "*" };

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...extra });
    res.end(JSON.stringify(body));
  };
  if (req.method === "OPTIONS") { res.writeHead(204, { ...CORS, "Access-Control-Allow-Headers": "content-type" }); res.end(); return; }
  if (req.method === "POST" && url.pathname === "/ingest/ticks") {
    // Authenticate on the header BEFORE reading a byte of the body.
    if (!TICK_INGEST_KEY) { json(503, { error: "ingest is not configured" }, { Connection: "close" }); return; }
    if (!bearerMatches(req.headers.authorization, TICK_INGEST_KEY)) { tickService.stats.ingestUnauthorized++; json(401, { error: "unauthorized" }, { Connection: "close" }); return; }
    const body = await readBody(req);
    if (body === null) { json(413, { error: "body too large" }); return; }
    const out = tickService.ingest(req.headers.authorization, body, (m) => broadcastTick(m));
    if (out.status === 202) { res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify(out)); }
    else json(out.status, { error: out.error });
    return;
  }
  if (req.method === "GET" && url.pathname === "/ticks") {
    // Gap repair: ticks after `sinceSeq` (same epoch) for one slab. A different epoch replays the buffer.
    const slab = url.searchParams.get("slab") ?? "";
    const since = Number(url.searchParams.get("sinceSeq") ?? "0");
    const epoch = url.searchParams.get("epoch");
    if (!ticksLimiter.allow(clientKey(req.headers["x-forwarded-for"], req.socket.remoteAddress), Date.now())) {
      json(429, { error: "slow down" }, { ...CORS, "Retry-After": "10" });
      return;
    }
    if (!slab || isBlockedSlab(slab)) { json(404, { error: "unknown slab" }, CORS); return; }
    json(200, { epoch: tickService.hub.epoch, ticks: tickService.replay(slab, Number.isFinite(since) ? since : 0, epoch) }, { ...CORS, "Cache-Control": "no-store" });
    return;
  }
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    json(200, { ok: true, uptimeS: Math.round((Date.now() - tickRequestStartedAt) / 1000), clients: clients.size, slabs: tickService.hub.slabCount(), ingestConfigured: !!TICK_INGEST_KEY, persistence: !!tickStore, stats: tickService.stats });
    return;
  }
  json(404, { error: "not found" });
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: WS_MAX_PAYLOAD_BYTES });

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

// ── Last-trade feed: indexer trades -> subscribed browsers ─────────────────
// One indexed query per second for every slab somebody is watching (never per viewer).
const TRADE_POLL_MS = Number(process.env.TRADE_POLL_MS ?? 1_000);
const tradeSql = getPgSql(process.env, 1);
const tradeFeed = tradeSql
  ? createTradeFeed({
      maxSlabs: MAX_WATCHED_SLABS,
      watched: () => { const s = new Set<string>(); for (const c of clients) for (const x of c.subscriptions) s.add(x); return s; },
      emit: (m) => {
        const payload = JSON.stringify(m);
        for (const c of clients) {
          if (c.subscriptions.has(m.slab) && c.ws.readyState === WebSocket.OPEN && c.ws.bufferedAmount <= 512 * 1024) c.ws.send(payload);
        }
      },
      query: (slabs, sinceIso) =>
        tradeSql.unsafe(
          `SELECT id::text AS id, slab_address, price::text AS price, size::text AS size, side, created_at
             FROM trades WHERE slab_address = ANY($1::text[]) AND network = $2 AND created_at >= $3::timestamptz
            ORDER BY created_at ASC LIMIT 500`,
          [slabs, process.env.NEXT_PUBLIC_DEFAULT_NETWORK ?? "devnet", sinceIso],
        ) as never,
    })
  : null;
if (tradeFeed) {
  let polling = false;
  setInterval(() => { if (polling) return; polling = true; void tradeFeed.poll().finally(() => { polling = false; }); }, TRADE_POLL_MS);
}

/** Skip a client whose socket is backed up: it repairs the gap from /ticks when it catches up. */
const MAX_BUFFERED_BYTES = 512 * 1024;

function broadcastTick(m: TickMessage): void {
  const payload = JSON.stringify(m);
  for (const client of clients) {
    if (!client.subscriptions.has(m.slab)) continue;
    if (client.ws.readyState !== WebSocket.OPEN || client.ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
    client.ws.send(payload);
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
        const v = checkSubscribe({ slab: msg.slabAddress, current: client.subscriptions, known: knownSlabs(), marketsLoaded, isBlocked: isBlockedSlab });
        if (!v.ok) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", reason: v.reason }));
          return;
        }
        client.subscriptions.add(msg.slabAddress);
        // Send the last-known price immediately (if any) — mirrors
        // production's "send initial data for price channels" so the
        // client isn't blank until the next update.
        const last = lastPriceE6.get(msg.slabAddress);
        if (last !== undefined) sendPrice(ws, msg.slabAddress, last);
        // ...and the last mark/oracle tick, so a chart that just (re)connected has a current value.
        const lastTick = tickService.hub.latest(msg.slabAddress);
        if (lastTick && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(lastTick));
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

// ── SOL/USD from Jupiter ────────────────────────────────────────────────────

async function solLoop(): Promise<void> {
  for (;;) {
    // Idle feed (no markets): no call at all.
    if (dexMarkets.length > 0) {
      const e6 = await fetchJupiterSolUsdE6();
      if (e6 !== null) jupiterSol = { e6, at: Date.now() };
    }
    await new Promise((r) => setTimeout(r, SOL_REFRESH_MS));
  }
}

// ── DEX poll ────────────────────────────────────────────────────────────────

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
 * One DEX-poll cycle: read every market's changing accounts in one batch and broadcast fresh
 * prices. Errors are isolated per market (a missing/invalid account skips only that market; a
 * failed RPC chunk fails only the markets in it), so a bad read never kills the loop.
 *
 * WSOL-quoted pools need a SOL/USD price to convert to USD: Jupiter's (fresh), else a one-off
 * DEX read of the SOL/USDC pool (lib/priceStore/solUsd.ts pickSolUsdE6).
 */
async function pollOnce(): Promise<void> {
  // Nothing to poll: skip the SOL read as well (an idle feed spends no RPC).
  if (dexMarkets.length === 0) return;
  const solPriceE6 = await pickSolUsdE6({
    jupiter: jupiterSol,
    now: Date.now(),
    maxAgeMs: Math.max(30_000, SOL_REFRESH_MS * 6),
    dexRead: async () => {
      try {
        const solResult = await readPoolPriceE6(mainnetConn, SOL_FALLBACK_ENTRY, decimalsCache);
        if (!solResult.skipped) return solResult.priceE6;
        logSkip(SOL_FALLBACK_ENTRY.label, "sol-fallback", solResult.skipReason);
      } catch (err) {
        console.warn("[local-price-ws] SOL fallback read error:", err instanceof Error ? err.message : err);
      }
      return undefined;
    },
  });

  const markets = dexMarkets;
  let outcomes: Awaited<ReturnType<typeof batchReader.readAll>>;
  try {
    outcomes = await batchReader.readAll(markets, solPriceE6);
  } catch (err) {
    console.warn("[local-price-ws] batch read failed:", err instanceof Error ? err.message : err);
    return;
  }
  for (const entry of markets) {
    const outcome = outcomes.get(entry.poolAddress);
    if (!outcome) continue;
    if (outcome.kind === "error") {
      console.warn(`[local-price-ws] ${entry.label} read error:`, outcome.error);
      continue;
    }
    const result = outcome.result;
    if (result.skipped) {
      logSkip(entry.label, entry.slab, result.skipReason);
      continue;
    }
    skipStreak.delete(entry.slab);
    lastPriceE6.set(entry.slab, result.priceE6);
    broadcast(entry.slab, result.priceE6);
  }
}

async function pollLoop(): Promise<void> {
  for (;;) {
    const started = Date.now();
    await pollOnce();
    // Fixed cadence: the interval is start-to-start (it used to be sleep AFTER the cycle, so the
    // period was POLL_INTERVAL_MS + cycle time). A 25 ms floor stops a slow cycle from spinning.
    await new Promise((r) => setTimeout(r, Math.max(25, POLL_INTERVAL_MS - (Date.now() - started))));
  }
}

httpServer.listen(PORT);
setInterval(() => { void tickService.flush(); }, TICK_FLUSH_MS);
if (tickStore) {
  // Retention prune, hourly. Failure is only a warning: the table just grows until the next success.
  setInterval(() => { tickStore.prune(Date.now()).catch((e) => console.warn("[local-price-ws] chart prune failed:", e instanceof Error ? e.message : e)); }, 60 * 60_000);
}
console.log(
  `[local-price-ws] ticks: ingest ${TICK_INGEST_KEY ? "ENABLED" : "disabled (TICK_INGEST_KEY unset)"}, persistence ${tickStore ? "on" : "off (no INDEXER_DATABASE_URL)"}`,
);
console.log(
  `[local-price-ws] listening on ws://localhost:${PORT} — DEX poll (${POLL_INTERVAL_MS}ms) for ${SEED_DEX_MARKETS.length} pinned + database-registered markets; SOL/USD from Jupiter every ${SOL_REFRESH_MS}ms (DEX fallback)`,
);
for (const m of SEED_DEX_MARKETS) {
  console.log(`  ${m.label.padEnd(11)} slab=${m.slab.slice(0, 8)}…  pool=${m.poolAddress.slice(0, 8)}… (${m.dexType})`);
}

// Discover database-registered markets before the first poll, then keep the
// list current. Runs alongside the price loops; a failure never stops them.
void (async () => {
  await refreshDbMarkets();
  setInterval(() => { void refreshDbMarkets(); }, DB_REFRESH_MS);
  // Continue each market's persisted candles across a restart (open stays the persisted open).
  if (tickStore) {
    try {
      const rows = await tickStore.newest(dexMarkets.map((m) => m.slab));
      for (const r of rows) tickService.hub.seed(r.slab, r.series, r.res, r.candle);
      console.log(`[local-price-ws] seeded ${rows.length} forming candles from the database`);
    } catch (err) {
      console.warn("[local-price-ws] candle seed failed (continuing unseeded):", err instanceof Error ? err.message : err);
    }
  }
})();

void solLoop();
void pollLoop();

process.on("SIGTERM", () => {
  wss.close();
  void tickService.flush().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("\n[local-price-ws] shutting down");
  wss.close();
  void tickService.flush().finally(() => process.exit(0));
});
