/**
 * Read-only live check of the /v1 builders against devnet v2.2 markets: for real portfolio owners it builds orders (buy and
 * sell), a close (when a position is open), a small withdraw (when flat with capital) and a small deposit (when the wallet
 * holds collateral), and records whether the returned bytes simulated clean or which coded refusal came back.
 * NOTHING is signed or sent: every build ends in simulateTransaction (sigVerify off). Uses the public devnet RPC unless
 * BENCH_RPC is set. Usage (from app/):
 *   NEXT_PUBLIC_V22=1 NEXT_PUBLIC_DEFAULT_NETWORK=devnet NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE=1 \
 *   NEXT_PUBLIC_WRAPPER_PROGRAM_ID=5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe \
 *   npx tsx scripts/bot-api/sim-live.ts <markets.json> [ownersPerMarket=4] [notionalUsd=25]
 */
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { portfolioScanFilters, parsePortfolio } from "@/lib/v22/layout";
import { OWNER_PORTFOLIO_OWNER_OFF } from "@/lib/owner-portfolio";
import { decodeMarketEngineView, signedPositionForAsset } from "@/lib/limits/decode";
import { quantizeQToLotsV22 } from "@/lib/v22/sdk/v22-lot";
import { buildOrder, buildClose } from "@/lib/bot-api/builders/order";
import { buildDeposit, buildWithdraw } from "@/lib/bot-api/builders/transfer";
import { txStatus } from "@/lib/bot-api/builders/status";
import { ApiError } from "@/lib/bot-api/errors";

const rpc = process.env.BENCH_RPC ?? "https://api.devnet.solana.com";
const [file, perArg, notionalArg] = process.argv.slice(2);
const per = Number(perArg ?? 4);
const notionalE6 = BigInt(Math.round(Number(notionalArg ?? 25) * 1e6));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GAP = Number(process.env.BENCH_GAP_MS ?? 1200);

type Row = { market: string; owner: string; action: string; facts: string; ms: number; result: string };

async function attempt(action: string, f: () => Promise<{ transactions: { simulation: { unitsConsumed: number | null } }[]; resubmitAfter?: boolean }>): Promise<{ ms: number; result: string; ok: boolean }> {
  const t0 = Date.now();
  try {
    const r = await f();
    const cu = r.transactions.map((t) => t.simulation.unitsConsumed).join("+");
    return { ms: Date.now() - t0, result: `OK sim-clean cu=${cu}${r.resubmitAfter ? " (crank first, resubmit)" : ""}`, ok: true };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "throw";
    const on = e instanceof ApiError && e.extra.onchain ? ` ${e.extra.onchain.name ?? e.extra.onchain.code}` : "";
    return { ms: Date.now() - t0, result: `REFUSED ${code}${on}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 110)}`, ok: false };
  }
}

async function main() {
  const conn = new Connection(rpc, "confirmed");
  const markets = JSON.parse(readFileSync(file, "utf8")) as { slab: string; symbol: string }[];
  const rows: Row[] = [];
  const tally: Record<string, Record<string, number>> = {};
  const note = (action: string, result: string) => {
    const k = result.startsWith("OK") ? "ok" : result.split(":")[0].replace("REFUSED ", "");
    tally[action] = tally[action] ?? {};
    tally[action][k] = (tally[action][k] ?? 0) + 1;
  };
  let sampleSig: string | null = null;
  for (const m of markets) {
    const slab = new PublicKey(m.slab);
    const info = await conn.getAccountInfo(slab, "confirmed");
    if (!info) continue;
    const eng = decodeMarketEngineView(new Uint8Array(info.data));
    const px = eng?.effectivePriceE6 ?? 0n;
    const f = portfolioScanFilters();
    const accts = await conn.getProgramAccounts(info.owner, {
      filters: [{ dataSize: f.dataSize }, ...(f.versionMemcmp ? [{ memcmp: f.versionMemcmp }] : []), { memcmp: { offset: 16, bytes: slab.toBase58() } }],
    });
    // Takers with capital first: those are the ones a bot would be.
    const cands = accts
      .map((a) => {
        try {
          const pf = parsePortfolio(new Uint8Array(a.account.data));
          const owner = new PublicKey(a.account.data.subarray(OWNER_PORTFOLIO_OWNER_OFF, OWNER_PORTFOLIO_OWNER_OFF + 32));
          const pos = eng?.marketId != null ? signedPositionForAsset(new Uint8Array(a.account.data), 0, eng.marketId) : 0n;
          return { owner, portfolio: a.pubkey, capital: pf.capital, lp: pf.matcherEnabled, pos };
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null && !x.lp)
      .sort((a, b) => (b.capital > a.capital ? 1 : b.capital < a.capital ? -1 : 0))
      .slice(0, per);
    let q = px > 0n ? (notionalE6 * 1_000_000n) / px : 1_000_000n;
    q = quantizeQToLotsV22(q).q || 1_000_000n;
    for (const c of cands) {
      const facts = `cap=${c.capital} pos=${c.pos}`;
      const owner = c.owner.toBase58();
      const meta = { rpcCalls: 0, sims: 0 };
      const acts: [string, () => Promise<never>][] = [];
      for (const side of ["buy", "sell"] as const) {
        acts.push([`order-${side}`, () => buildOrder(conn, { owner: c.owner, market: slab, size: side === "buy" ? q : -q, portfolio: c.portfolio }, meta) as Promise<never>]);
      }
      if (c.pos !== 0n) acts.push(["close", () => buildClose(conn, { owner, market: m.slab, portfolio: c.portfolio.toBase58() }, meta) as Promise<never>]);
      if (c.pos === 0n && c.capital > 1_000_000n) acts.push(["withdraw", () => buildWithdraw(conn, { owner, market: m.slab, amount: "1000000", portfolio: c.portfolio.toBase58() }, meta) as Promise<never>]);
      acts.push(["deposit", () => buildDeposit(conn, { owner, market: m.slab, amount: "1000000", portfolio: c.portfolio.toBase58() }, meta) as Promise<never>]);
      for (const [action, f] of acts) {
        const r = await attempt(action, f);
        rows.push({ market: m.symbol, owner, action, facts, ms: r.ms, result: r.result });
        note(action, r.result);
        console.log(`${m.symbol}\t${owner.slice(0, 8)}\t${facts}\t${action}\t${r.ms}ms\t${r.result}`);
        await sleep(GAP);
      }
      if (!sampleSig) {
        const sigs = await conn.getSignaturesForAddress(c.portfolio, { limit: 1 }).catch(() => []);
        sampleSig = sigs[0]?.signature ?? null;
      }
    }
  }
  if (sampleSig) {
    const s = await txStatus(conn, sampleSig, null, { rpcCalls: 0 });
    console.log(`\ntx status of a real portfolio signature ${sampleSig.slice(0, 12)}...: ${s.status} slot=${s.slot} err=${s.err ? JSON.stringify(s.err.onchain) : "none"}`);
    const fake = await txStatus(conn, "1".repeat(64), 1, { rpcCalls: 0 }).catch((e) => ({ status: `refused ${(e as ApiError).code}` }));
    console.log(`tx status of a never-sent signature with lastValidBlockHeight=1: ${fake.status}`);
  }
  console.log(`\nSUMMARY by action: ${JSON.stringify(tally)}`);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))];
  console.log(`build latency over ${ms.length} builds (public devnet RPC, with 429 back-off): p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${ms.at(-1)} ms`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
