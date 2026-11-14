/**
 * A small fixture-backed Solana JSON-RPC server for load tests (no network, no keys). It serves the recorded devnet SOL
 * market with its LP portfolio and matcher context, and the GATO market, from __tests__/fixtures, plus ONE taker portfolio
 * (MOCK_OWNER's flat trading account on the SOL market, made from the recorded LP portfolio bytes: owner patched, matcher
 * disabled, legs cleared, 1,000 USD capital). It answers the read methods the /api/v1 reads use AND simulateTransaction
 * (always clean, with unitsConsumed), so a build for MOCK_OWNER reaches a clean simulated 200 and the load test can measure
 * the build path. It never sends or signs anything: sendTransaction is not served. Usage as a server (to point `next start`
 * at it with DEVNET_RPC_URL):
 *   npx tsx scripts/bot-api/mock-rpc.ts [port=3918]
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_IDENTITY_TRAILER_LEN } from "@percolatorct/sdk";
import { portfolioLegGeometry } from "@/lib/v22/layout";
import { LEG_ACTIVE, PF_CAPITAL } from "@/lib/limits/constants";

const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, "../../__tests__/fixtures", p), "utf8"));
const sol = fx("v22-spread-size-aware-sol.json");
const gato = fx("v22-trade-build/gato-market.json");

export const MOCK_SLOT = sol.slot as number;
export const MOCK_BLOCK_HEIGHT = 400_000_000;
export const MOCK_MARKETS = { sol: sol.market as string, gato: gato.slab as string };
export const MOCK_WRAPPER = gato.owner as string;

interface Acct {
  owner: string;
  data: Buffer;
}
const lpData = Buffer.from(sol.lpB64, "base64");
// The LP portfolio carries its matcher config (program, ctx, delegate, control) just before the identity trailer; the ctx account
// must be owned by that matcher program. Read it by offset so this does not depend on any env flag.
const cfgOff = lpData.length - 104 - V17_PORTFOLIO_IDENTITY_TRAILER_LEN;
const matcherProg = new PublicKey(lpData.subarray(cfgOff, cfgOff + 32)).toBase58();
/** A wallet that has a flat trading account on the mock SOL market (use it as `owner` in builds). Any 32 bytes are a public key. */
export const MOCK_OWNER = new PublicKey(Buffer.alloc(32, 9)).toBase58();
const MOCK_TAKER = new PublicKey(Buffer.alloc(32, 10)).toBase58();
export const MOCK_TAKER_CAPITAL_ATOMS = 1_000_000_000n; // 1,000 USD of 6-decimal Sim-USDC

/** The recorded LP portfolio turned into a taker's: owner and account id patched, matcher control zeroed, legs cleared, capital set. */
function takerPortfolio(): Buffer {
  const d = Buffer.from(lpData);
  new PublicKey(MOCK_OWNER).toBuffer().copy(d, 116); // mutable owner (OWNER_PORTFOLIO_OWNER_OFF)
  new PublicKey(MOCK_OWNER).toBuffer().copy(d, 80); // provenance owner
  new PublicKey(MOCK_TAKER).toBuffer().copy(d, 48); // account id = its own address
  d.writeBigUInt64LE(0n, cfgOff + 96); // matcher control: disabled, so it is nobody's LP
  const geo = portfolioLegGeometry(new Uint8Array(d));
  if (!geo) throw new Error("mock rpc: the recorded portfolio has an unknown layout (set NEXT_PUBLIC_V22=1)");
  for (let i = 0; i < geo.legCount; i++) d[geo.legsOff + i * geo.legStride + LEG_ACTIVE] = 0;
  d.writeBigUInt64LE(MOCK_TAKER_CAPITAL_ATOMS & ((1n << 64n) - 1n), PF_CAPITAL);
  d.writeBigUInt64LE(0n, PF_CAPITAL + 8);
  return d;
}

const ACCOUNTS = new Map<string, Acct>([
  [sol.market, { owner: MOCK_WRAPPER, data: Buffer.from(sol.marketB64, "base64") }],
  [sol.lp, { owner: MOCK_WRAPPER, data: lpData }],
  [sol.ctx, { owner: matcherProg, data: Buffer.from(sol.ctxB64, "base64") }],
  [gato.slab, { owner: MOCK_WRAPPER, data: Buffer.from(gato.data, "base64") }],
  [MOCK_TAKER, { owner: MOCK_WRAPPER, data: takerPortfolio() }],
]);

type Memcmp = { memcmp?: { offset: number; bytes: string; encoding?: string } };
function matches(a: Acct, filters: Memcmp[] = []): boolean {
  return filters.every((f) => {
    if (!f.memcmp) return true;
    const want = f.memcmp.encoding === "base64" ? Buffer.from(f.memcmp.bytes, "base64") : Buffer.from(bs58.decode(f.memcmp.bytes));
    return a.data.subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want);
  });
}

const ctx = () => ({ slot: MOCK_SLOT, apiVersion: "2.0.0" });
function acctJson(a: Acct, slice?: { offset: number; length: number }) {
  const d = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
  return { data: [d.toString("base64"), "base64"], executable: false, lamports: 1_000_000_000, owner: a.owner, rentEpoch: 0, space: a.data.length };
}

function handle(method: string, p: unknown[]): unknown {
  switch (method) {
    case "getSlot":
      return MOCK_SLOT;
    case "getBlockHeight":
      return MOCK_BLOCK_HEIGHT;
    case "getAccountInfo": {
      const a = ACCOUNTS.get(p[0] as string);
      return { context: ctx(), value: a ? acctJson(a) : null };
    }
    case "getMultipleAccounts":
      return { context: ctx(), value: (p[0] as string[]).map((k) => (ACCOUNTS.has(k) ? acctJson(ACCOUNTS.get(k)!) : null)) };
    case "getProgramAccounts": {
      const cfg = (p[1] ?? {}) as { filters?: Memcmp[]; dataSlice?: { offset: number; length: number }; withContext?: boolean };
      const value = [...ACCOUNTS.entries()]
        .filter(([, a]) => a.owner === (p[0] as string) && matches(a, cfg.filters))
        .map(([pubkey, a]) => ({ pubkey, account: acctJson(a, cfg.dataSlice) }));
      return cfg.withContext ? { context: ctx(), value } : value;
    }
    case "getSignatureStatuses":
      return { context: ctx(), value: (p[0] as string[]).map(() => null) };
    case "getSignaturesForAddress":
    case "getRecentPrioritizationFees":
      return [];
    case "simulateTransaction":
      // Clean for every transaction: what is measured is the API's build path, not the program. Nothing is executed or sent.
      return { context: ctx(), value: { err: null, logs: ["Program log: mock simulation"], accounts: null, unitsConsumed: 180_000, returnData: null } };
    case "getMinimumBalanceForRentExemption":
      return 60_000_000;
    case "getLatestBlockhash":
      return { context: ctx(), value: { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: MOCK_BLOCK_HEIGHT + 150 } };
    default:
      throw Object.assign(new Error(`mock rpc: ${method} not served`), { code: -32601 });
  }
}

function answer(req: { id?: unknown; method?: string; params?: unknown[] }) {
  try {
    return { jsonrpc: "2.0", id: req.id ?? null, result: handle(String(req.method), req.params ?? []) };
  } catch (e) {
    return { jsonrpc: "2.0", id: req.id ?? null, error: { code: (e as { code?: number }).code ?? -32000, message: e instanceof Error ? e.message : "error" } };
  }
}

/** Starts the server on `port` (0 = any free port) and returns its URL. Loopback only. */
export function startMockRpc(port = 0): Promise<{ url: string; server: Server; requests: () => number }> {
  let n = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      n++;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const out = Array.isArray(body) ? body.map(answer) : answer(body as never);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, requests: () => n })));
}

if (process.argv[1] && process.argv[1].endsWith("mock-rpc.ts")) {
  const port = Number(process.argv[2] ?? 3918);
  void startMockRpc(port).then((s) => console.log(`mock rpc on ${s.url}, markets ${MOCK_MARKETS.sol} ${MOCK_MARKETS.gato}`));
}

