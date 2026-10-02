/**
 * DEX price source without a second surfpool: snapshot (READ-ONLY, public mainnet RPC)
 * the pool accounts the seed + keeper price off — each pool, its vaults and mints, and
 * the SOL/USD reference pool — into .run/cache/mainnet-dex.json once, then load them
 * into the local validator with surfnet_setAccount. The keeper's MAINNET_RPC_URL and
 * the seed's mainnet reads then point at the same local validator.
 * Usage: tsx lib/mainnet-snapshot.ts <localRpc> <cacheFile>
 */
import fs from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { parseDexPool, detectDexType } from "@percolatorct/sdk";
import { rpc, assertLocal } from "./chain.ts";

const LOCAL = process.argv[2]; const CACHE = process.argv[3];
assertLocal(LOCAL);
const POOLS = [
  "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj", "HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL",
  "9d9mb8kooFfaD3SctgZtkxQypkshx6ezhbKio89ixyy2", "DdMA1cHcHEqYfttc1z1sJEY978CcU1pyjNuTWTNmdvzU",
  "5tYFviFWQRKV9BJSTHGitbdqEYC1BGUgRUDnSADUXqJP", "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW",
  ...(process.env.EXTRA_POOLS ?? "").split(",").filter(Boolean),
];
type Snap = Record<string, { owner: string; lamports: number; data: string; executable: boolean }>;
async function snapshot(): Promise<Snap> {
  const m = new Connection(process.env.MAINNET_READ_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const out: Snap = {};
  const put = (k: PublicKey, a: { owner: PublicKey; lamports: number; data: Buffer; executable: boolean }) =>
    (out[k.toBase58()] = { owner: a.owner.toBase58(), lamports: a.lamports, data: a.data.toString("hex"), executable: a.executable });
  const pools = await m.getMultipleAccountsInfo(POOLS.map((p) => new PublicKey(p)));
  const extra = new Set<string>();
  pools.forEach((a, i) => {
    if (!a) throw new Error(`pool ${POOLS[i]} missing on mainnet`);
    put(new PublicKey(POOLS[i]), a);
    const t = detectDexType(a.owner);
    try {
      const p = parseDexPool(t as any, new PublicKey(POOLS[i]), new Uint8Array(a.data)) as any;
      for (const k of ["baseVault", "quoteVault", "baseMint", "quoteMint"]) if (p[k]) extra.add(p[k].toBase58());
    } catch (e) { console.warn(`parse ${POOLS[i]} (${t}): ${(e as Error).message}`); }
  });
  const ex = [...extra];
  const infos = await m.getMultipleAccountsInfo(ex.map((k) => new PublicKey(k)));
  infos.forEach((a, i) => { if (a) put(new PublicKey(ex[i]), a); });
  return out;
}
async function main() {
  let snap: Snap;
  if (fs.existsSync(CACHE)) snap = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  else { snap = await snapshot(); fs.writeFileSync(CACHE, JSON.stringify({ ...snap })); }
  for (const [k, a] of Object.entries(snap))
    await rpc(LOCAL, "surfnet_setAccount", [k, { lamports: a.lamports, data: a.data, owner: a.owner, executable: a.executable }]);
  console.log(`mainnet DEX snapshot: ${Object.keys(snap).length} accounts loaded from ${CACHE}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
