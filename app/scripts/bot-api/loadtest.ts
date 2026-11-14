/**
 * Load test for /api/v1. Prints one JSON report: latency p50/p95/p99, throughput, error rate and status breakdown,
 * overall and per request class. Devnet only; nothing is signed or sent (builders only simulate, and the mock RPC cannot).
 *
 * Modes
 *   inproc (default)  calls the route handlers directly in this process. `--rpc mock` (default) serves them from a local
 *                     fixture RPC (scripts/bot-api/mock-rpc.ts), so it measures the API layer: auth, weighted limits,
 *                     idempotency, envelope, parsing, decoding. `--rpc env` uses the RPC the env configures (public devnet).
 *                     Throwaway keys are issued in-process (`--keys N`, tier mm); they never leave the process.
 *   http              sends real HTTP requests to `--base` (a running `next start`). The server has its own key store, so
 *                     builds need a key it knows: LOADTEST_API_KEY. Without one only anonymous reads run, and the anonymous
 *                     budget (60 weight/min per address) applies: pace with --rps. `--spread-ips N` rotates X-Forwarded-For
 *                     over N addresses, which only matters when the server runs with TRUSTED_PROXY_DEPTH=1.
 *
 * Usage (from app/; env on the command line, no .env):
 *   BOT_API_ENABLED=1 NEXT_PUBLIC_V22=1 NEXT_PUBLIC_DEFAULT_NETWORK=devnet NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE=1 \
 *   NEXT_PUBLIC_WRAPPER_PROGRAM_ID=5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe \
 *   npx tsx scripts/bot-api/loadtest.ts --mode inproc --rpc mock --concurrency 64 --requests 20000 --mix read=60,quote=30,build=10
 *   npx tsx scripts/bot-api/loadtest.ts --mode http --base http://127.0.0.1:3917 --concurrency 2 --requests 80 --rps 0.6 --mix read=70,quote=30
 * Flags: --concurrency N (16)  --requests N (1000) | --duration SEC  --warmup N (10)  --mix class=weight,...
 *   classes: read (health, markets, market, funding), quote (quote, depth), account (account, history), build (POST /orders)
 *   --rps N  --keys N (20)  --market ADDR  --owner ADDR  --discover-owners N  --spread-ips N  --label TEXT
 */
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { provenance } from "./provenance";

type Cls = "read" | "quote" | "account" | "build";
const CLASSES: Cls[] = ["read", "quote", "account", "build"];

function flag(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
}
const num = (name: string, d: number) => {
  const v = Number(flag(name, String(d)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} must be a non-negative number`);
  return v;
};

const mode = (flag("mode", "inproc") ?? "inproc") as "inproc" | "http";
const rpcMode = (flag("rpc", "mock") ?? "mock") as "mock" | "env";
const concurrency = Math.max(1, num("concurrency", 16));
const totalReq = num("requests", 1000);
const durationSec = num("duration", 0);
const warmup = num("warmup", 10);
const rps = num("rps", 0);
const nKeys = Math.max(1, num("keys", 20));
const spreadIps = num("spread-ips", 0);
const base = (flag("base", "http://127.0.0.1:3917") ?? "").replace(/\/+$/, "");

function parseMix(raw: string): Record<Cls, number> {
  const out: Record<Cls, number> = { read: 0, quote: 0, account: 0, build: 0 };
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=");
    if (!CLASSES.includes(k as Cls) || !Number.isFinite(Number(v)) || Number(v) < 0) throw new Error(`bad --mix entry "${part}"`);
    out[k as Cls] = Number(v);
  }
  if (CLASSES.every((c) => out[c] === 0)) throw new Error("--mix has no weight");
  return out;
}
const mix = parseMix(flag("mix", "read=60,quote=30,build=10")!);

interface Req {
  cls: Cls;
  method: "GET" | "POST";
  path: string;
  body?: string;
  idem?: string;
}
interface Sample {
  cls: Cls;
  status: number;
  ms: number;
  code: string | null;
}

const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const r2 = (n: number) => Math.round(n * 100) / 100;
function lat(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  return { count: s.length, min: r2(s[0] ?? 0), p50: r2(percentile(s, 50)), p95: r2(percentile(s, 95)), p99: r2(percentile(s, 99)), max: r2(s[s.length - 1] ?? 0), mean: r2(s.reduce((a, b) => a + b, 0) / (s.length || 1)) };
}

type Sender = (r: Req, i: number) => Promise<{ status: number; code: string | null }>;

async function main() {
  for (const k of ["NEXT_PUBLIC_DEFAULT_NETWORK"]) if (mode === "inproc" && process.env[k] !== "devnet") throw new Error(`${k}=devnet is required (devnet only)`);
  if (mode === "inproc" && (process.env.BOT_API_ENABLED !== "1" || process.env.NEXT_PUBLIC_V22 !== "1")) throw new Error("set BOT_API_ENABLED=1 and NEXT_PUBLIC_V22=1 on the command line");
  if (mode === "http" && /mainnet/i.test(base)) throw new Error("devnet only");

  let send: Sender;
  let mockRequests: (() => number) | null = null;
  let mockClose: (() => void) | null = null;
  let keys: string[] = [];
  let market = flag("market");
  let owner = flag("owner");
  const runId = randomBytes(4).toString("hex");
  const sampleWallet = Keypair.generate().publicKey.toBase58();

  if (mode === "inproc") {
    if (rpcMode === "mock") {
      const { startMockRpc, MOCK_MARKETS } = await import("./mock-rpc");
      const m = await startMockRpc(0);
      process.env.DEVNET_RPC_URL = m.url;
      process.env.DEVNET_RPC_FALLBACK_URLS = ""; // no fallback: the mock is the only upstream
      mockRequests = m.requests;
      mockClose = () => m.server.close();
      market = market ?? MOCK_MARKETS.sol;
    }
    if (!process.env.BOT_API_KEY_PEPPER) process.env.BOT_API_KEY_PEPPER = randomBytes(32).toString("hex"); // throwaway
    const { issueKey } = await import("@/lib/bot-api/keys");
    for (let i = 0; i < nKeys; i++) keys.push((await issueKey({ scopes: ["read", "build"], tier: "mm", label: "loadtest" })).key);
    const R = {
      health: (await import("@/app/api/v1/health/route")).GET,
      markets: (await import("@/app/api/v1/markets/route")).GET,
      market: (await import("@/app/api/v1/markets/[market]/route")).GET,
      funding: (await import("@/app/api/v1/markets/[market]/funding/route")).GET,
      quote: (await import("@/app/api/v1/markets/[market]/quote/route")).GET,
      depth: (await import("@/app/api/v1/markets/[market]/depth/route")).GET,
      account: (await import("@/app/api/v1/accounts/[wallet]/route")).GET,
      history: (await import("@/app/api/v1/accounts/[wallet]/history/route")).GET,
      orders: (await import("@/app/api/v1/orders/route")).POST,
    };
    type H = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<Response>;
    const route = (path: string, method: string): { h: H; params: Record<string, string> } => {
      const seg = path.split("?")[0].replace(/^\/api\/v1/, "").split("/").filter(Boolean);
      if (method === "POST") return { h: R.orders as H, params: {} };
      if (seg[0] === "health") return { h: R.health as H, params: {} };
      if (seg[0] === "markets" && seg.length === 1) return { h: R.markets as H, params: {} };
      if (seg[0] === "markets") return { h: ({ undefined: R.market, funding: R.funding, quote: R.quote, depth: R.depth } as Record<string, H>)[String(seg[2])], params: { market: seg[1] } };
      return { h: (seg[2] === "history" ? R.history : R.account) as H, params: { wallet: seg[1] } };
    };
    send = async (r, i) => {
      const { h, params } = route(r.path, r.method);
      const headers: Record<string, string> = { Authorization: `Bearer ${keys[i % keys.length]}` };
      if (r.body) headers["Content-Type"] = "application/json";
      if (r.idem) headers["Idempotency-Key"] = r.idem;
      const res = await h(new NextRequest(`http://loadtest.local${r.path}`, { method: r.method, headers, body: r.body }), { params: Promise.resolve(params) });
      const text = await res.text();
      return { status: res.status, code: res.status >= 400 ? errCode(text) : null };
    };
  } else {
    const apiKey = process.env.LOADTEST_API_KEY;
    send = async (r, i) => {
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (spreadIps > 0) headers["X-Forwarded-For"] = `10.77.${Math.floor((i % spreadIps) / 250)}.${(i % spreadIps) % 250 + 1}`;
      if (r.body) headers["Content-Type"] = "application/json";
      if (r.idem) headers["Idempotency-Key"] = r.idem;
      try {
        const res = await fetch(`${base}${r.path}`, { method: r.method, headers, body: r.body });
        const text = await res.text();
        return { status: res.status, code: res.status >= 400 ? errCode(text) : null };
      } catch {
        return { status: 0, code: "transport" };
      }
    };
    if (mix.build > 0 && !apiKey) {
      console.error("note: no LOADTEST_API_KEY, so build requests are dropped from the mix (the server would answer 401)");
      mix.build = 0;
      if (CLASSES.every((c) => mix[c] === 0)) throw new Error("nothing left to run");
    }
  }

  // Market and owner discovery (not measured).
  const get = async (path: string) => {
    if (mode === "http") {
      const res = await fetch(`${base}${path}`, { headers: process.env.LOADTEST_API_KEY ? { Authorization: `Bearer ${process.env.LOADTEST_API_KEY}` } : {} });
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    }
    return { status: 0, json: null };
  };
  if (!market) {
    if (mode === "http") {
      const r = await get("/api/v1/markets");
      const list = (r.json?.markets as Array<{ market: string; oracle?: { stale?: boolean } }> | undefined) ?? [];
      market = (list.find((m) => !m.oracle?.stale) ?? list[0])?.market;
    } else {
      const { GET } = await import("@/app/api/v1/markets/route");
      const res = await GET(new NextRequest("http://loadtest.local/api/v1/markets", { headers: { Authorization: `Bearer ${keys[0]}` } }));
      const list = ((await res.json()) as { markets?: Array<{ market: string; oracle?: { stale?: boolean } }> }).markets ?? [];
      market = (list.find((m) => !m.oracle?.stale) ?? list[0])?.market;
    }
  }
  if (!market) throw new Error("no market found; pass --market");
  if (mix.build > 0 && !owner) owner = Keypair.generate().publicKey.toBase58(); // a wallet without an account: the builder answers no_portfolio
  const discover = num("discover-owners", 0);
  if (discover > 0 && mode === "inproc" && rpcMode === "env") {
    const { getServerConnection } = await import("@/lib/server-rpc");
    const { OWNER_PORTFOLIO_MAGIC, OWNER_PORTFOLIO_MARKET_OFF, OWNER_PORTFOLIO_OWNER_OFF } = await import("@/lib/owner-portfolio");
    const { PublicKey } = await import("@solana/web3.js");
    const conn = getServerConnection("confirmed");
    const info = await conn.getAccountInfo(new PublicKey(market), "confirmed");
    if (info) {
      const rows = await conn.getProgramAccounts(info.owner, {
        commitment: "confirmed",
        dataSlice: { offset: OWNER_PORTFOLIO_OWNER_OFF, length: 32 },
        filters: [
          { memcmp: { offset: 0, bytes: OWNER_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
          { memcmp: { offset: OWNER_PORTFOLIO_MARKET_OFF, bytes: market } },
        ],
      });
      const owners = rows.map((r) => new PublicKey(r.account.data).toBase58()).slice(0, discover);
      if (owners.length > 0) owner = owners[0];
      console.error(`discovered ${owners.length} portfolio owner(s) on the market`);
    }
  }

  const mixTotal = CLASSES.reduce((a, c) => a + mix[c], 0);
  const pickClass = (): Cls => {
    let x = Math.random() * mixTotal;
    for (const c of CLASSES) if ((x -= mix[c]) < 0) return c;
    return "read";
  };
  const wallet = owner ?? sampleWallet;
  const make = (cls: Cls, n: number): Req => {
    const v1 = "/api/v1";
    if (cls === "read") return { cls, method: "GET", path: pick([`${v1}/health`, `${v1}/markets`, `${v1}/markets/${market}`, `${v1}/markets/${market}/funding`]) };
    if (cls === "quote") {
      return Math.random() < 0.75
        ? { cls, method: "GET", path: `${v1}/markets/${market}/quote?size=${Math.random() < 0.5 ? "" : "-"}${1_000_000 * (1 + Math.floor(Math.random() * 5))}&slippageBps=100` }
        : { cls, method: "GET", path: `${v1}/markets/${market}/depth` };
    }
    if (cls === "account") return { cls, method: "GET", path: pick([`${v1}/accounts/${wallet}`, `${v1}/accounts/${wallet}/history?limit=5`]) };
    return {
      cls,
      method: "POST",
      path: `${v1}/orders`,
      body: JSON.stringify({ owner: wallet, market, side: Math.random() < 0.5 ? "buy" : "sell", size: "1000000", slippageBps: 100 }),
      idem: `lt-${runId}-${n}`,
    };
  };

  // The handlers print one JSON log line per request on stdout; keep stdout for the report. (Formatting that line is still measured.)
  if (mode === "inproc") console.log = () => undefined;

  // Warmup (not measured): primes caches and connections.
  for (let i = 0; i < warmup; i++) await send(make("read", -1 - i), i);

  const samples: Sample[] = [];
  let issued = 0;
  const t0 = performance.now();
  const deadline = durationSec > 0 ? t0 + durationSec * 1000 : Number.POSITIVE_INFINITY;
  const budget = durationSec > 0 ? Number.POSITIVE_INFINITY : totalReq;
  const worker = async () => {
    for (;;) {
      if (issued >= budget || performance.now() >= deadline) return;
      const n = issued++;
      if (rps > 0) {
        const at = t0 + (n * 1000) / rps;
        const wait = at - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (performance.now() >= deadline) return;
      }
      const req = make(pickClass(), n);
      const s0 = performance.now();
      let out: { status: number; code: string | null };
      try {
        out = await send(req, n);
      } catch (e) {
        out = { status: 0, code: e instanceof Error ? e.name : "throw" };
      }
      samples.push({ cls: req.cls, status: out.status, ms: performance.now() - s0, code: out.code });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallSec = (performance.now() - t0) / 1000;

  const tally = (rows: Sample[]) => {
    const status: Record<string, number> = {};
    const codes: Record<string, number> = {};
    for (const s of rows) {
      status[String(s.status)] = (status[String(s.status)] ?? 0) + 1;
      if (s.code) codes[s.code] = (codes[s.code] ?? 0) + 1;
    }
    const serverErr = rows.filter((s) => s.status === 0 || s.status >= 500).length;
    const non2xx = rows.filter((s) => s.status < 200 || s.status >= 300).length;
    return {
      requests: rows.length,
      status,
      errorCodes: codes,
      errorRate: r2(serverErr / (rows.length || 1)),
      non2xxRate: r2(non2xx / (rows.length || 1)),
      latencyMs: lat(rows.map((s) => s.ms)),
      latencyServedMs: lat(rows.filter((s) => s.status !== 429).map((s) => s.ms)),
    };
  };
  const perClass: Record<string, ReturnType<typeof tally>> = {};
  for (const c of CLASSES) {
    const rows = samples.filter((s) => s.cls === c);
    if (rows.length) perClass[c] = tally(rows);
  }
  const report = {
    ...provenance(),
    label: flag("label", null as never) ?? null,
    mode,
    rpc: mode === "inproc" ? rpcMode : "server-configured",
    target: mode === "http" ? new URL(base).host : "in-process handlers",
    concurrency,
    mix,
    pacingRps: rps || null,
    keys: mode === "inproc" ? nKeys : process.env.LOADTEST_API_KEY ? 1 : 0,
    wallSeconds: r2(wallSec),
    throughputRps: r2(samples.length / wallSec),
    ...(mockRequests ? { mockRpcRequests: mockRequests() } : {}),
    ...tally(samples),
    byClass: perClass,
    notes: [
      "errorRate = transport failures + 5xx; non2xxRate also counts 4xx (rate limits, coded refusals).",
      "latencyServedMs leaves out 429s, which are answered before any work.",
      ...(rpcMode === "mock" && mode === "inproc" ? ["mock RPC cannot simulate: build requests stop at a coded refusal, so they measure auth, limits, idempotency, parsing and the market and owner reads, not trade building."] : []),
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  mockClose?.();
  void get;
}

function errCode(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: { code?: string } };
    return j.error?.code ?? null;
  } catch {
    return null;
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
