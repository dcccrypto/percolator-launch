#!/usr/bin/env npx tsx
/**
 * One-time backfill of MARK candles from on-chain PushAuthMark transactions.
 * See lib/chart/chain-backfill.ts. Read-only against the chain; writes chart_candles (src='chain').
 *
 *   set -a; . ~/.openclaw/credentials/deploy-tokens.env; set +a     # never echo these
 *   INDEXER_DATABASE_URL=... \
 *   npx tsx scripts/backfill-chain-marks.ts --dry-run               # list + count, no fetch, no writes
 *   npx tsx scripts/backfill-chain-marks.ts                         # run (resumes if interrupted)
 *
 * Environment:
 *   INDEXER_DATABASE_URL | CANDLES_DATABASE_URL   Postgres with chart_candles + chart_chain_backfill (apply the migrations first)
 *   CHAIN_RPC_URL                                 full devnet RPC URL, or
 *   CHART_BACKFILL_HELIUS_KEY | HELIUS_CHARTS_API_KEY   the dedicated charts key (default 25 rps; use --rps 50 for full speed), or
 *   HELIUS_KEEPER_API_KEY                         last resort: the LIVE KEEPER's key, so the default is a gentle 8 rps
 *
 * Flags:
 *   --slabs a,b,c        markets to rebuild (default: every active devnet market in the markets table)
 *   --authority <pubkey> keeper wallet that signed the pushes (default: the fee payer of the newest push tx on the first market)
 *   --program <pubkey>   wrapper program (default: the owner of the first slab)
 *   --since <unix|iso>   ignore anything older (default: the earliest created_at of the markets being rebuilt, minus
 *                        one hour. The keeper wallet also signed for older program deployments, so an
 *                        unbounded listing would page through all of that history for nothing)
 *   --rps <n>            sustained RPC requests/second (default 25 on the charts key, 8 on the keeper's key)
 *   --chunk <n>          transactions per saved chunk (default 100)
 *   --max-chunks <n>     stop after n chunks; a later run resumes
 *   --sample-seconds <n> only fetch txs in the first n seconds of each minute (about n/60 of the cost; see chain-backfill.ts)
 *   --restart            ignore saved progress and redo (output is identical)
 *   --dry-run            plan only
 */
import { createPgProgressStore, runChainBackfill, type RpcTx } from "../lib/chart/chain-backfill";
import { createHttpRpc, resolveBackfillRpc } from "../lib/chart/chain-rpc";
import { getPgCandleStore, getPgSql } from "../lib/chart/pg-store";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const sql = getPgSql(process.env, 2);
  const store = getPgCandleStore(process.env, 2);
  if (!sql || !store) throw new Error("INDEXER_DATABASE_URL (or CANDLES_DATABASE_URL) is not set");

  const resolved = resolveBackfillRpc(process.env);
  if (!resolved) throw new Error("set CHAIN_RPC_URL, CHART_BACKFILL_HELIUS_KEY or HELIUS_CHARTS_API_KEY");
  const url = resolved.url;
  // The dedicated charts key can take 25-50 rps; the live keeper's key stays at the gentle default.
  const rps = Number(arg("rps") ?? (resolved.usedKeeperKey ? 8 : 25));
  const rpc = createHttpRpc({ url, rps });

  let slabs = (arg("slabs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (slabs.length === 0) {
    const rows = await sql.unsafe(`SELECT slab_address FROM markets WHERE network = 'devnet' AND keeper_status = 'active'`);
    slabs = rows.map((r) => String(r.slab_address));
  }
  if (slabs.length === 0) throw new Error("no markets to backfill");

  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return ((await r.json()) as { result: T }).result;
  };
  let programId = arg("program");
  if (!programId) {
    const acc = await call<{ value: { owner: string } | null }>("getAccountInfo", [slabs[0], { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    if (!acc.value) throw new Error(`slab ${slabs[0]} not found`);
    programId = acc.value.owner;
  }
  let authority = arg("authority");
  if (!authority) {
    // The signer (fee payer, account 0) of the newest successful tx touching the first market that carries a push.
    const sigs = await rpc.getSignatures(slabs[0], undefined, 20);
    const txs = await rpc.getTransactions(sigs.filter((s) => !s.err).map((s) => s.signature));
    const t = txs.find((x): x is RpcTx => x !== null && x.transaction.message.instructions.some((ix) => x.transaction.message.accountKeys[ix.programIdIndex] === programId && ix.data.length >= 40));
    authority = t?.transaction.message.accountKeys[0];
    if (!authority) throw new Error("could not infer the keeper authority; pass --authority");
  }
  const since = arg("since");
  let sinceSec: number | undefined = since === undefined ? undefined : /^\d+$/.test(since) ? Number(since) : Math.floor(Date.parse(since) / 1000);
  if (sinceSec === undefined) {
    const r = await sql.unsafe(`SELECT MIN(created_at) AS t FROM markets WHERE slab_address = ANY($1::text[])`, [slabs]);
    const t = r[0]?.t ? new Date(r[0].t as string | Date).getTime() : NaN;
    if (Number.isFinite(t)) sinceSec = Math.floor(t / 1000) - 3600;
    else console.log("[chain-backfill] no created_at found: listing the keeper wallet's whole history (pass --since to bound it)");
  }
  if (sinceSec !== undefined) console.log(`[chain-backfill] since ${new Date(sinceSec * 1000).toISOString()}`);

  console.log(`[chain-backfill] ${slabs.length} markets, program ${programId.slice(0, 8)}…, authority ${authority.slice(0, 8)}…, ${rps} rps${resolved.usedKeeperKey ? " (LIVE KEEPER KEY)" : ""}`);
  const t0 = Date.now();
  const summary = await runChainBackfill(
    {
      slabs, authority, programId, sinceSec,
      chunk: arg("chunk") ? Number(arg("chunk")) : undefined,
      maxChunks: arg("max-chunks") ? Number(arg("max-chunks")) : undefined,
      sampleSeconds: arg("sample-seconds") ? Number(arg("sample-seconds")) : undefined,
      restart: flag("restart"), dryRun: flag("dry-run"),
    },
    { rpc, store, progress: createPgProgressStore(sql), log: (l) => console.log(`[chain-backfill] ${l}`) },
  );
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`[chain-backfill] ${summary.status}: ${JSON.stringify(summary)} in ${secs}s, ${rpc.requests()} RPC requests`);
  if (summary.status === "dry-run") {
    const req = summary.listed + Math.ceil(summary.listed / 1000);
    console.log(`[chain-backfill] a full run would make about ${req} RPC requests, about ${Math.round(req / rps / 60)} min at ${rps} rps`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("[chain-backfill] failed:", e instanceof Error ? e.message : e); process.exit(1); });
