/**
 * Read-only bench for lib/v22/trade-build.ts. For each v2.2 market in the list, takes real portfolio owners (getProgramAccounts),
 * builds small buy / sell orders for them and records whether the returned order simulated clean (sigVerify off).
 * Nothing is signed or sent. Usage (from app/):
 *   NEXT_PUBLIC_V22=1 NEXT_PUBLIC_DEFAULT_NETWORK=devnet NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE=1 NEXT_PUBLIC_WRAPPER_PROGRAM_ID=<wrapper> \
 *   npx tsx scripts/trade-api/bench.ts <markets.json> [ownersPerMarket=3] [notionalUsd=25]
 */
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { buildV22Trade, TradeBuildRefusal } from "@/lib/v22/trade-build";
import { portfolioScanFilters } from "@/lib/v22/layout";
import { OWNER_PORTFOLIO_OWNER_OFF } from "@/lib/owner-portfolio";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { quantizeQToLotsV22 } from "@/lib/v22/sdk/v22-lot";
import { parsePortfolio } from "@/lib/v22/layout";

const rpc = process.env.BENCH_RPC ?? "https://api.devnet.solana.com";
const [file, perArg, notionalArg] = process.argv.slice(2);
const per = Number(perArg ?? 3);
const notionalE6 = BigInt(Math.round(Number(notionalArg ?? 25) * 1e6));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const conn = new Connection(rpc, "confirmed");
  const markets = JSON.parse(readFileSync(file, "utf8")) as { slab: string; symbol: string }[];
  const rows: string[] = [];
  let ok = 0, total = 0;
  const codes: Record<string, number> = {};
  for (const m of markets) {
    const slab = new PublicKey(m.slab);
    const info = await conn.getAccountInfo(slab, "confirmed");
    if (!info) { rows.push(`${m.symbol}\tmarket missing`); continue; }
    const eng = decodeMarketEngineView(new Uint8Array(info.data));
    const px = eng?.effectivePriceE6 ?? 0n;
    const f = portfolioScanFilters();
    const accts = await conn.getProgramAccounts(info.owner, {
      filters: [{ dataSize: f.dataSize }, ...(f.versionMemcmp ? [{ memcmp: f.versionMemcmp }] : []), { memcmp: { offset: 16, bytes: slab.toBase58() } }],
    });
    // Portfolio facts for the verdict table: an LP (matcher on) or a 0-capital account is expected to be refused.
    const facts = new Map<string, string>();
    for (const a of accts) {
      const o = new PublicKey(a.account.data.subarray(OWNER_PORTFOLIO_OWNER_OFF, OWNER_PORTFOLIO_OWNER_OFF + 32)).toBase58();
      try {
        const pf = parsePortfolio(new Uint8Array(a.account.data));
        facts.set(o, `cap=${pf.capital} lp=${pf.matcherEnabled ? 1 : 0} legs=${pf.legs.filter((l) => l.active).length}`);
      } catch {
        facts.set(o, "unparsed");
      }
    }
    const owners = [...facts.keys()].slice(0, per);
    let q = px > 0n ? (notionalE6 * 1_000_000n) / px : 1_000_000n;
    q = quantizeQToLotsV22(q).q || 1_000_000n;
    for (const o of owners) {
      for (const side of [1n, -1n]) {
        total++;
        const t0 = Date.now();
        let verdict: string;
        try {
          const r = await buildV22Trade(conn, { owner: new PublicKey(o), slab, size: side * q });
          const p = r.transactions.map((t) => t.purpose).join("+");
          verdict = `OK ${p}${r.resubmitAfter ? " (resubmit)" : ""} cu=${r.transactions.at(-1)?.unitsConsumed} fee=${r.summary.feeBps} repairs=${r.summary.repairs.join(",") || "-"}`;
          if (!r.resubmitAfter) ok++;
          codes.ok = (codes.ok ?? 0) + 1;
        } catch (e) {
          const code = e instanceof TradeBuildRefusal ? e.code : "throw";
          codes[code] = (codes[code] ?? 0) + 1;
          verdict = `FAIL ${code}: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`;
        }
        rows.push(`${m.symbol}\t${o}\t${facts.get(o)}\t${side > 0n ? "buy " : "sell"}\t${q}\t${Date.now() - t0}ms\t${verdict}`);
        console.log(rows.at(-1));
        await sleep(Number(process.env.BENCH_GAP_MS ?? 1500));
      }
    }
  }
  console.log(`\nSUMMARY order simulated clean ${ok}/${total}; by code ${JSON.stringify(codes)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
