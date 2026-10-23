/**
 * Data-egress harness for review E1/E2/E3 (ledger indexer-db-review-2026-10-14). LOCAL THROWAWAY
 * Postgres only. Every DB byte is counted at a TCP proxy (server -> client), i.e. on the wire.
 *
 *   cd app
 *   psql "$PERF_PG_URL" -f scripts/perf/schema.sql && psql "$PERF_PG_URL" -f scripts/perf/seed.sql
 *   BASE_REF=origin/feat/v22-app bash scripts/perf/prepare-old.sh      # old code, via git show
 *   PERF_PG_URL=postgres://perf@127.0.0.1:54329/perf npx tsx scripts/perf/measure.ts
 *   rm -rf scripts/perf/.old
 *
 * What is measured vs computed is printed with every number.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { startByteProxy } from "./byte-proxy";

type Row = Record<string, unknown>;
interface FeedLike { poll(): Promise<number> }
interface TradeMessageLike { type: "trade"; slab: string; id: string; ts: number }
type CreateFeed = (opts: {
  query: (...args: never[]) => Promise<unknown[]>;
  watched(): Iterable<string>;
  emit(m: TradeMessageLike): void;
  now?: () => number;
}) => FeedLike;
type RouteGet = (req: unknown, ctx: { params: Promise<{ slab: string }> }) => Promise<Response>;

const PG = process.env.PERF_PG_URL;
if (!PG) throw new Error("PERF_PG_URL is required (a THROWAWAY local database)");
const pgUrl = new URL(PG);
if (!["127.0.0.1", "localhost"].includes(pgUrl.hostname)) throw new Error("refusing: PERF_PG_URL must be local");

const OLD_DIR = resolve(__dirname, ".old");
const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });
const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;

async function main(): Promise<void> {
  const proxy = await startByteProxy({ upstreamHost: pgUrl.hostname, upstreamPort: Number(pgUrl.port || 5432) });
  const viaProxy = new URL(PG as string);
  viaProxy.port = String(proxy.port);
  viaProxy.hostname = "127.0.0.1";
  // The app's own clients read these lazily (lib/indexer-db.ts getSql, lib/chart/pg-store.ts).
  process.env.INDEXER_DATABASE_URL = viaProxy.toString();
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";

  // Same client options as production (pg-store.ts getPgSql): transaction-pooler safe, no prepare.
  const sql = postgres(viaProxy.toString(), { max: 1, prepare: false, ssl: false, onnotice: () => {} });
  const direct = postgres(PG as string, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
  await sql`select 1`;

  const slabOf = async (symbol: string) => ((await direct`select slab_address from markets where symbol = ${symbol}`)[0] as Row).slab_address as string;
  const BUSY1 = await slabOf("TOK1");
  const BUSY2 = await slabOf("TOK2");
  const NORMAL = await slabOf("TOK5");
  const IDLE = await slabOf("TOK15");
  const WATCHED = [BUSY1, BUSY2, NORMAL, IDLE];
  console.log(`base: ${readFileSync(resolve(OLD_DIR, "BASE"), "utf8").trim()}`);
  const counts = (await direct`select (select count(*) from trades)::int as trades, (select count(*) from markets)::int as markets, (select count(*) from markets_with_stats)::int as view_rows`)[0] as Row;
  console.log(`seed: ${JSON.stringify(counts)}\n`);

  // ── E1: trade feed ─────────────────────────────────────────────────────────
  console.log("== E1 price-ws trade feed (WIRE-MEASURED at the proxy) ==");
  const oldScript = readFileSync(resolve(OLD_DIR, "local-price-ws-server.ts.txt"), "utf8");
  const m = /tradeSql\.unsafe\(\s*`([\s\S]*?)`/.exec(oldScript);
  if (!m) throw new Error("could not find the old trade-feed SQL in the base price-ws script");
  const OLD_FEED_SQL = m[1];
  const oldFeedPath: string = resolve(OLD_DIR, "trade-feed.ts");
  const oldMod = (await import(oldFeedPath)) as { createTradeFeed: CreateFeed };
  const newMod = await import("../../lib/chart/trade-feed");

  const POLLS = 60;
  const results: Array<{ variant: string; pinH: number; bytesPerPoll: number; liveDelivered: number; liveInserted: number }> = [];
  for (const pinH of [1, 24]) {
    for (const variant of ["old", "new"] as const) {
      await direct`delete from trades where trader = 'perf-live'`;
      const t0 = Date.now() - pinH * 3_600_000;
      let first = true;
      const now = () => (first ? t0 : Date.now());
      const emitted: TradeMessageLike[] = [];
      const feed: FeedLike = variant === "old"
        ? oldMod.createTradeFeed({
            query: ((slabs: string[], sinceIso: string) => sql.unsafe(OLD_FEED_SQL, [slabs, "devnet", sinceIso])) as never,
            watched: () => WATCHED, emit: (x) => emitted.push(x), now,
          })
        : newMod.createTradeFeed({
            query: newMod.pgTradeQuery(sql as never, "devnet"),
            watched: () => WATCHED, emit: (x) => emitted.push(x as TradeMessageLike), now,
          });
      // Subscribe at t0 (the idle slab has been watched for pinH hours), then measure steady state.
      await feed.poll();
      first = false;
      await feed.poll();
      proxy.reset();
      emitted.length = 0;
      let inserted = 0;
      for (let i = 0; i < POLLS; i++) {
        if (i % 3 === 0) {
          // ~one live fill every 3 s on a busy slab (production-shaped: a few per minute), via the
          // direct connection so the insert is not counted as feed egress.
          await direct`insert into trades (slab_address, trader, side, size, price, created_at) values (${BUSY1}, 'perf-live', 'long', 1000000, 100.5, now())`;
          inserted++;
        }
        await feed.poll();
      }
      const bytesPerPoll = proxy.serverToClient / POLLS;
      const liveDelivered = emitted.filter((e) => e.slab === BUSY1).length;
      results.push({ variant, pinH, bytesPerPoll, liveDelivered, liveInserted: inserted });
    }
  }
  await direct`delete from trades where trader = 'perf-live'`;
  console.log("| pinned for | variant | bytes/poll (wire) | bytes/day @1 s poll | live fills delivered |");
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.pinH} h | ${r.variant} | ${fmt(r.bytesPerPoll)} | ${gb(r.bytesPerPoll * 86_400)} | ${r.liveDelivered}/${r.liveInserted} |`);
  }
  console.log("");

  // ── E2: markets list ───────────────────────────────────────────────────────
  console.log("== E2 /api/markets + /api/stats registry read ==");
  console.log("(supabase-js/PostgREST cannot run here: the SAME SQL is issued against local pg; WIRE = pg protocol bytes,");
  console.log(" JSON = computed size of the rows as PostgREST would return them)");
  const oldReg = readFileSync(resolve(OLD_DIR, "market-registry.ts.txt"), "utf8");
  const fieldsMatch = /MARKET_SELECT_FIELDS =\s*([\s\S]*?);/.exec(oldReg);
  if (!fieldsMatch) throw new Error("could not find MARKET_SELECT_FIELDS in the base registry");
  const FIELDS = fieldsMatch[1].replace(/["+\s]/g, "");
  const numeric = new Set(["last_price", "volume_24h", "trade_count_24h", "decimals", "max_leverage", "trading_fee_bps"]);
  const jsonBytes = (rows: Row[]) => Buffer.byteLength(JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, numeric.has(k) && v !== null ? Number(v) : v])))));
  const baseWhere = `network = 'devnet' AND slab_address IS NOT NULL AND (indexer_excluded IS NULL OR indexer_excluded <> true)`;
  const measureQuery = async (q: string) => {
    proxy.reset();
    const rows = (await sql.unsafe(q)) as unknown as Row[];
    return { rows: rows.length, wire: proxy.serverToClient, json: jsonBytes(rows) };
  };
  const foreign = ((await direct`select slab_address from markets where symbol like 'OLD%'`) as unknown as Row[]).map((r) => `'${String(r.slab_address)}'`).join(",");
  const e2: Array<[string, { rows: number; wire: number; json: number }]> = [];
  e2.push(["as live per ledger (86 old rows status=closed): old query", await measureQuery(`SELECT ${FIELDS} FROM markets_with_stats WHERE ${baseWhere}`)]);
  e2.push(["as live per ledger: new query", await measureQuery(`SELECT ${FIELDS} FROM markets_with_stats WHERE ${baseWhere} AND status <> 'closed'`)]);
  await direct`update markets set status = 'active' where symbol like 'OLD%'`;
  e2.push(["drifted (86 old rows still active): old query", await measureQuery(`SELECT ${FIELDS} FROM markets_with_stats WHERE ${baseWhere}`)]);
  e2.push(["drifted: new query, first read of an instance", await measureQuery(`SELECT ${FIELDS} FROM markets_with_stats WHERE ${baseWhere} AND status <> 'closed'`)]);
  e2.push(["drifted: new query, after the proven-dead set is known", await measureQuery(`SELECT ${FIELDS} FROM markets_with_stats WHERE ${baseWhere} AND status <> 'closed' AND slab_address NOT IN (${foreign})`)]);
  await direct`update markets set status = 'closed' where symbol like 'OLD%'`;
  console.log("| scenario | rows | wire bytes/read | JSON bytes/read (computed) |");
  console.log("|---|---|---|---|");
  for (const [k, v] of e2) console.log(`| ${k} | ${v.rows} | ${fmt(v.wire)} | ${fmt(v.json)} |`);
  console.log("");

  // ── E3: candles ────────────────────────────────────────────────────────────
  console.log("== E3 /api/candles/[slab] (route handler called IN-PROCESS; DB bytes WIRE-MEASURED, body = response bytes) ==");
  const { NextRequest } = await import("next/server");
  const oldRoutePath: string = resolve(OLD_DIR, "candles-route.ts");
  const oldRoute = (await import(oldRoutePath)) as { GET: RouteGet };
  const newRoute = (await import("../../app/api/candles/[slab]/route")) as unknown as { GET: RouteGet };
  const nowSec = Math.floor(Date.now() / 1000);
  const cases: Array<[string, string, number, number, boolean, string]> = [
    ["TV 1m first page (2 d, fill)", "1", nowSec - 2 * 86_400, nowSec, true, BUSY1],
    ["TV 1h first page (45 d, fill)", "60", nowSec - 45 * 86_400, nowSec, true, BUSY1],
    ["TV 1D first page (1095 d, fill)", "1D", nowSec - 1095 * 86_400, nowSec, true, BUSY1],
    ["header stats 1h x 30 h (no fill)", "60", nowSec - 30 * 3_600, nowSec, false, BUSY1],
    ["TV 1h on a normal slab (45 d, fill)", "60", nowSec - 45 * 86_400, nowSec, true, NORMAL],
  ];
  console.log("| request | variant | DB wire bytes | response body bytes | bars | Cache-Control |");
  console.log("|---|---|---|---|---|---|");
  for (const [label, res, from, to, fill, slab] of cases) {
    for (const [variant, route] of [["old", oldRoute], ["new", newRoute]] as const) {
      const url = `http://localhost/api/candles/${slab}?resolution=${res}&from=${from}&to=${to}${fill ? "&fill=1" : ""}`;
      await route.GET(new NextRequest(url), { params: Promise.resolve({ slab }) }); // warm the pool
      proxy.reset();
      const r = await route.GET(new NextRequest(url), { params: Promise.resolve({ slab }) });
      const body = await r.text();
      const bars = (JSON.parse(body) as { t?: unknown[] }).t?.length ?? 0;
      console.log(`| ${label} | ${variant} | ${fmt(proxy.serverToClient)} | ${fmt(Buffer.byteLength(body))} | ${bars} | ${r.headers.get("cache-control")} |`);
    }
  }

  await sql.end();
  await direct.end();
  await proxy.close();
}

main().then(
  () => process.exit(0),
  (e: unknown) => { console.error(e); process.exit(1); },
);
