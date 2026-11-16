/**
 * Local fake Solana JSON-RPC for benchmarking /api/markets without a network or a database
 * (DEVNET only; nothing leaves the machine). Serves N synthetic, complete v2.1 market slabs owned by the
 * devnet wrapper, each RPC call delayed by RPC_LATENCY_MS (default 80 ms, a typical devnet round trip).
 *
 *   npx tsx scripts/bench-markets-fake-rpc.ts            # listens on 8899
 *   DEVNET_RPC_URL=http://localhost:8899 PLAYGROUND_SHOW_ALL_MARKETS=true pnpm start
 *   zsh scripts/bench-markets.sh 3111                         # 20 GETs, p50/p95/size
 *
 * Prints per-method call counts on SIGINT / every 20 s so the cost per request is visible.
 */
import http from "node:http";
import { PublicKey } from "@solana/web3.js";
import { deriveStakePool } from "@percolatorct/sdk";
import { DEVNET_PROGRAM_IDS } from "../lib/program-ids";
import { LAYOUT_V21 } from "../lib/v22/sdk";
import { syntheticMarket } from "../__tests__/lib/v22/_stamp";

const PORT = Number(process.env.FAKE_RPC_PORT ?? 8899);
const LATENCY = Number(process.env.RPC_LATENCY_MS ?? 80);
const N = Number(process.env.FAKE_MARKETS ?? 12);
const wrapper = new PublicKey(DEVNET_PROGRAM_IDS.wrapper);
const stake = new PublicKey(DEVNET_PROGRAM_IDS.stake);

const accounts = new Map<string, Uint8Array>();
for (let i = 0; i < N; i++) {
  const key = new PublicKey(new Uint8Array(32).fill(i + 1));
  const d = syntheticMarket(LAYOUT_V21, 1, { insurance: BigInt(1000 + i) });
  d.set(deriveStakePool(key, stake)[0].toBytes(), 16); // complete market: marketauth == stake-pool PDA
  accounts.set(key.toBase58(), d);
}
const acct = (d: Uint8Array) => ({ data: [Buffer.from(d).toString("base64"), "base64"], executable: false, lamports: 1_000_000, owner: wrapper.toBase58(), rentEpoch: 0 });
const counts: Record<string, number> = {};

function handle(req: { method: string; params?: unknown[] }): unknown {
  counts[req.method] = (counts[req.method] ?? 0) + 1;
  const ctx = { slot: 1 };
  switch (req.method) {
    case "getProgramAccounts":
      return [...accounts].map(([pubkey, d]) => ({ pubkey, account: acct(d) }));
    case "getMultipleAccounts":
      return { context: ctx, value: ((req.params?.[0] as string[]) ?? []).map((k) => (accounts.has(k) ? acct(accounts.get(k)!) : null)) };
    case "getAccountInfo": {
      const k = req.params?.[0] as string;
      return { context: ctx, value: accounts.has(k) ? acct(accounts.get(k)!) : null };
    }
    case "getLatestBlockhash":
      return { context: ctx, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 } };
    default:
      return null;
  }
}

http
  .createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      setTimeout(() => {
        const j = JSON.parse(body);
        const out = Array.isArray(j) ? j.map((r) => ({ jsonrpc: "2.0", id: r.id, result: handle(r) })) : { jsonrpc: "2.0", id: j.id, result: handle(j) };
        rs.setHeader("content-type", "application/json");
        rs.end(JSON.stringify(out));
      }, LATENCY);
    });
  })
  .listen(PORT, () => console.log(`fake RPC on :${PORT}, ${N} markets, ${LATENCY} ms/call`));

const report = () => console.log("rpc calls:", JSON.stringify(counts));
setInterval(report, 20_000).unref();
process.on("SIGINT", () => { report(); process.exit(0); });
