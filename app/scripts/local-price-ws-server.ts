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
 * This DISPLAY price now ticks off the SAME mainnet DEX pools the keeper
 * derives the on-chain AuthMark from (not a separate CEX-aggregate oracle
 * like Pyth) — so it works for every market, including pump.fun coins with
 * no Pyth feed (BURNIE, Percolator). A single DEX pool's spot only moves on
 * swaps, so a thin pool can legitimately sit still between polls — that's
 * expected, not a bug (it's still the same source the trade settles
 * against, so there's no more Pyth/AuthMark drift to explain away).
 *
 * Market list below mirrors `app/PLAYGROUND.md`'s "Live markets" table
 * (2026-07-10 born-immortal re-seed) — devnet slab to mainnet DEX pool, for
 * the 6 markets the trade terminal ships with.
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
 *   PRICE_WS_POLL_MS  (default 500)
 */
import { Connection } from "@solana/web3.js";
import { WebSocketServer, WebSocket } from "ws";
import { readPoolPriceE6, type DecimalsCache, type PoolReadEntry } from "../lib/priceStore/dexPoolReader";

// Railway (and most PaaS) inject PORT and route the public domain to it, so
// prefer it; PRICE_WS_PORT is the local-dev override; 8787 is the local default.
const PORT = Number(process.env.PORT ?? process.env.PRICE_WS_PORT ?? 8787);
// The DISPLAY price now ticks off the same mainnet DEX pools the keeper
// derives the on-chain AuthMark from — a single pool's spot only moves on
// swaps (a thin pump.fun pool can legitimately sit still between polls),
// unlike a continuously-republished CEX-aggregate oracle. That's expected,
// not a bug.
const POLL_INTERVAL_MS = Number(process.env.PRICE_WS_POLL_MS ?? 500);
// Shared with the cross-cluster keeper (~/percolator-oracle-keeper/.env) —
// same Helius mainnet key, so keep RPC calls batched/backed-off (see
// dexPoolReader's withRpcBackoff) to avoid 429s from double-polling it.
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

interface MarketEntry extends PoolReadEntry {
  slab: string;
}

/** Mirrors app/PLAYGROUND.md's "Live markets" table (2026-07-10 born-immortal re-seed). */
const MARKETS: MarketEntry[] = [
  { slab: "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV", poolAddress: "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", dexType: "raydium-clmm", label: "SOL/USDC" },
  { slab: "B22quVNFuuEYwx4dQigwn41BMBuk9ZcTdMik4UH7PshY", poolAddress: "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL", dexType: "meteora-dlmm", label: "JUP/USDC" },
  { slab: "6Hqn4VoMHjvCb1XWQkpnJ1UE3xAverJezVdk3czvgQxh", poolAddress: "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2", dexType: "meteora-dlmm", label: "TRUMP/USDC" },
  { slab: "Gbpuam5UYV4MpC1DmGeTVZWtT4UGDmahMW2vo4p1MBAf", poolAddress: "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU", dexType: "meteora-dlmm", label: "PENGU/USDC" },
  { slab: "GPpyVaHAEJ8u6W9UAyCPp6tuQB2Chm1Z6uLUKA9ePJBC", poolAddress: "5tYFviFWQRKV9BJSTHGitbdqEYC1BGUgRUDnSADUXqJP", dexType: "pumpswap", label: "BURNIE/WSOL" },
  { slab: "FGaUkXepxCggbmpbgXDWUZ3V2CGSh6MeDCU6KLTLShbH", poolAddress: "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW", dexType: "pumpswap", label: "PERC/WSOL" },
];

// The SOL market is the SOL/USD reference for converting WSOL-quoted
// PumpSwap pools (BURNIE, Percolator) to USD — see dexPoolReader's
// `solPriceE6` param.
const SOL_MARKET = MARKETS.find((m) => m.label.startsWith("SOL/"))!;

const mainnetConn = new Connection(MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const decimalsCache: DecimalsCache = new Map();

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

// Low-volume skip logging: warn at most once per market per this many
// consecutive skips, so a persistently-thin/un-seeded pool doesn't spam
// stdout every poll tick.
const SKIP_LOG_EVERY_N = 20;
const skipStreak = new Map<string, number>();

function logSkip(entry: MarketEntry, reason: string | undefined): void {
  const n = (skipStreak.get(entry.slab) ?? 0) + 1;
  skipStreak.set(entry.slab, n);
  if (n === 1 || n % SKIP_LOG_EVERY_N === 0) {
    console.warn(`[local-price-ws] ${entry.label} skipped (x${n}): ${reason ?? "unknown reason"}`);
  }
}

/**
 * One poll cycle: read every market's mainnet DEX pool and broadcast fresh
 * prices. Per-market errors are caught individually so one bad pool read
 * (RPC hiccup, transient 429 exhaustion, etc.) never kills the loop or
 * blocks the other markets.
 *
 * SOL is read first because the PumpSwap markets (BURNIE, Percolator) are
 * WSOL-quoted and need this cycle's SOL/USD price to convert to USD.
 */
async function pollOnce(): Promise<void> {
  let solPriceE6: bigint | undefined;
  try {
    const solResult = await readPoolPriceE6(mainnetConn, SOL_MARKET, decimalsCache);
    if (!solResult.skipped) {
      solPriceE6 = solResult.priceE6;
      lastPriceE6.set(SOL_MARKET.slab, solResult.priceE6);
      broadcast(SOL_MARKET.slab, solResult.priceE6);
      skipStreak.delete(SOL_MARKET.slab);
    } else {
      logSkip(SOL_MARKET, solResult.skipReason);
      // Fall back to the last known SOL price (if any) so PumpSwap markets
      // don't go dark on a single transient SOL-pool skip.
      solPriceE6 = lastPriceE6.get(SOL_MARKET.slab);
    }
  } catch (err) {
    console.warn(`[local-price-ws] ${SOL_MARKET.label} read error:`, err instanceof Error ? err.message : err);
    solPriceE6 = lastPriceE6.get(SOL_MARKET.slab);
  }

  await Promise.all(
    MARKETS.filter((m) => m !== SOL_MARKET).map(async (entry) => {
      try {
        const result = await readPoolPriceE6(mainnetConn, entry, decimalsCache, solPriceE6);
        if (result.skipped) {
          logSkip(entry, result.skipReason);
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
  `[local-price-ws] listening on ws://localhost:${PORT}, polling ${MARKETS.length} mainnet DEX pools every ${POLL_INTERVAL_MS}ms (DEX-sourced — same pools the keeper derives the on-chain AuthMark from, NOT Pyth)`,
);
for (const m of MARKETS) {
  console.log(`  ${m.label.padEnd(11)} slab=${m.slab.slice(0, 8)}…  pool=${m.poolAddress.slice(0, 8)}… (${m.dexType})`);
}

void pollLoop();

process.on("SIGINT", () => {
  console.log("\n[local-price-ws] shutting down");
  wss.close();
  process.exit(0);
});
