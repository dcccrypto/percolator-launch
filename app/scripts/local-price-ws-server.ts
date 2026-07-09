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
 * Price source: reads each market's mainnet DEX pool directly via
 * `../lib/priceStore/dexPoolReader.ts`, which is a cited, function-for-
 * function port of `~/percolator-oracle-keeper/src/cross-cluster/
 * price-reader.ts`'s `readPoolPriceE6` — same `@percolatorct/sdk`
 * primitives, same dispatch logic, same skip/error semantics. This is the
 * "reuse the keeper's DEX reader" requirement: the actual price math is the
 * SDK's, not reimplemented here.
 *
 * Market list below mirrors `~/percolator-oracle-keeper/registry.json`
 * (the "new consistent markets 2026-07-09 (20x SOL, 10x rest, no Earn vault)" registration) — devnet slab to
 * mainnet DEX pool, for the same 5 markets the trade terminal ships with.
 *
 * Usage:
 *   MAINNET_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... \
 *     npx tsx scripts/local-price-ws-server.ts
 *
 *   Reuse the mainnet RPC URL already configured for the cross-cluster
 *   keeper at ~/percolator-oracle-keeper/.env (MAINNET_RPC_URL=...) rather
 *   than provisioning a new key — see BUILD-LOG.md Phase 1 for the exact
 *   value's location (not printed here; it's a live API key).
 *
 * Then point the Next.js app at it (in app/.env.local):
 *   NEXT_PUBLIC_WS_URL=ws://localhost:8787
 *
 * Optional env:
 *   PRICE_WS_PORT     (default 8787)
 *   PRICE_WS_POLL_MS  (default 300 — matches the brief's "~300ms" cadence)
 */
import { WebSocketServer, WebSocket } from "ws";

// Railway (and most PaaS) inject PORT and route the public domain to it, so
// prefer it; PRICE_WS_PORT is the local-dev override; 8787 is the local default.
const PORT = Number(process.env.PORT ?? process.env.PRICE_WS_PORT ?? 8787);
// The DISPLAY price streams from Pyth Hermes — a CEX-aggregate median oracle,
// the SAME KIND of continuous feed Hyperliquid / Drift show as their index price
// (~2-3 updates/sec). A single mainnet DEX pool's spot only moves on swaps
// (measured: SOL/USDC Raydium sat unchanged for 5s), so it physically cannot
// tick like a CEX oracle — that stays the on-chain AuthMark trades settle
// against (they're ~0.1% apart, well within slippage). Zero Helius-key load.
const POLL_INTERVAL_MS = Number(process.env.PRICE_WS_POLL_MS ?? 500);
const HERMES_BASE = process.env.HERMES_BASE ?? "https://hermes.pyth.network";
// Pyth mainnet crypto price-feed IDs, keyed by the CURRENT devnet slab.
const PYTH_FEED: Record<string, string> = {
  "Fs13SX1b33wRh3DBbh1NmkuHSz5Z89oRb2ew7aNn1jMH": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", // SOL
  "J9unPVyDykcoQyxGxF1MfSE6mGyaaCfZhGEAk5eQokXG": "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996", // JUP
  "8WNAuxLDvo3S5Yf9Z5sm2me69N4d1RLvxoS1tCnPpo83": "879551021853eec7a7dc827578e8e69da7e4fa8148339aa0d3d5296405be4b1a", // TRUMP
  "DeWGMtVo8VHjUJ5qsPXSZsQS9rFJhnB3gE4tPGWrEcCB": "bed3097008b9b5e3c93bec20be79cb43986b85a996475589351a21e67bae9b61", // PENGU
};
const idToSlab = new Map(Object.entries(PYTH_FEED).map(([slab, id]) => [id.toLowerCase(), slab]));

interface MarketEntry {
  slab: string;
  pool: string;
  dexType: "raydium-clmm" | "meteora-dlmm" | "pumpswap";
  label: string;
}

/** Mirrors ~/percolator-oracle-keeper/registry.json as of 2026-07-09 (20x SOL, 10x rest, no Earn vault). */
const MARKETS: MarketEntry[] = [
  { slab: "Fs13SX1b33wRh3DBbh1NmkuHSz5Z89oRb2ew7aNn1jMH", pool: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", dexType: "raydium-clmm", label: "SOL/USDC" },
  { slab: "J9unPVyDykcoQyxGxF1MfSE6mGyaaCfZhGEAk5eQokXG", pool: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL", dexType: "meteora-dlmm", label: "JUP/USDC" },
  { slab: "8WNAuxLDvo3S5Yf9Z5sm2me69N4d1RLvxoS1tCnPpo83", pool: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2", dexType: "meteora-dlmm", label: "TRUMP/USDC" },
  { slab: "DeWGMtVo8VHjUJ5qsPXSZsQS9rFJhnB3gE4tPGWrEcCB", pool: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU", dexType: "meteora-dlmm", label: "PENGU/USDC" },
];

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
        // client isn't blank until the next poll tick.
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

console.log(`[local-price-ws] listening on ws://localhost:${PORT}, LIVE-streaming Pyth Hermes (SSE, ~2-3/s) for ${MARKETS.length} markets`);
for (const m of MARKETS) {
  console.log(`  ${m.label.padEnd(11)} slab=${m.slab.slice(0, 8)}…  pyth=${(PYTH_FEED[m.slab] ?? "?").slice(0, 8)}…`);
}

void streamPrices();

process.on("SIGINT", () => {
  console.log("\n[local-price-ws] shutting down");
  wss.close();
  process.exit(0);
});
