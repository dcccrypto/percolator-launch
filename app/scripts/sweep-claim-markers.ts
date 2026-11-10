#!/usr/bin/env npx tsx
/**
 * Refund the rent held by Sim-USDC claim markers (lib/sim-usdc-claim-guard.ts, Council r4 N4 / #3784) to the faucet
 * authority. DEVNET ONLY: refuses any cluster whose genesis hash is not devnet's.
 *
 * Each no-database claim creates a 0-byte System account at createWithSeed(authority, seed(wallet, UTC day)) holding
 * the rent the authority paid. Once that day (and the next, see isMarkerSweepable) is over the marker blocks nothing,
 * so a transferWithSeed of its whole balance back to the authority closes it. Markers are found from the authority's
 * own transaction history, and every address is re-derived from (authority, seed) before it is touched.
 *
 *   npx tsx scripts/sweep-claim-markers.ts --since 2026-11-10                 # dry run: list what would be swept
 *   DEVNET_MINT_AUTHORITY_KEYPAIR=... npx tsx scripts/sweep-claim-markers.ts --since 2026-11-10 --execute
 *
 * Flags:
 *   --since <iso|unix>   oldest authority tx to scan (default: 2026-11-10, the day the markers shipped)
 *   --authority <pubkey> faucet authority (default: the Sim-USDC mint authority read from chain)
 *   --rpc <url>          devnet RPC (default: https://api.devnet.solana.com)
 *   --execute            send the sweep txs (needs DEVNET_MINT_AUTHORITY_KEYPAIR for the same authority)
 * Never prints key material.
 */
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getDevnetMintSigner } from "../lib/devnet-signer";
import { buildMarkerSweepInstruction, claimMarkerCreatesIn, isMarkerSweepable } from "../lib/sim-usdc-claim-guard";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SIM_USDC_MINT = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");
const MARKERS_PER_TX = 8;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 6) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

async function main() {
  const execute = process.argv.includes("--execute");
  const sinceArg = arg("since") ?? "2026-11-10T00:00:00Z";
  const sinceSec = /^\d+$/.test(sinceArg) ? Number(sinceArg) : Date.parse(sinceArg) / 1000;
  if (!Number.isFinite(sinceSec)) throw new Error(`bad --since ${sinceArg}`);
  const conn = new Connection(arg("rpc") ?? "https://api.devnet.solana.com", "confirmed");
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("refusing: RPC is not devnet");

  let authority: PublicKey;
  if (arg("authority")) authority = new PublicKey(arg("authority")!);
  else {
    const mint = await conn.getParsedAccountInfo(SIM_USDC_MINT);
    const data = mint.value?.data as { parsed?: { info?: { mintAuthority?: string } } } | undefined;
    const ma = data?.parsed?.info?.mintAuthority;
    if (!ma) throw new Error("Sim-USDC mint has no authority; pass --authority");
    authority = new PublicKey(ma);
  }
  console.log(`authority ${authority.toBase58()}  since ${new Date(sinceSec * 1000).toISOString()}  ${execute ? "EXECUTE" : "DRY RUN"}`);

  const sigs: { signature: string; blockTime: number }[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await retry(() => conn.getSignaturesForAddress(authority, { before, limit: 1000 }));
    if (page.length === 0) break;
    for (const s of page) if (!s.err && (s.blockTime ?? 0) >= sinceSec) sigs.push({ signature: s.signature, blockTime: s.blockTime ?? 0 });
    before = page[page.length - 1].signature;
    if ((page[page.length - 1].blockTime ?? 0) < sinceSec) break;
  }

  const found = new Map<string, { address: string; seed: string; createdAtMs: number; createdSig: string }>();
  for (const s of sigs) {
    const tx = await retry(() => conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
    for (const m of await claimMarkerCreatesIn(tx, authority)) {
      found.set(m.address, { ...m, createdAtMs: s.blockTime * 1000, createdSig: s.signature });
    }
    await sleep(150);
  }

  const markers = [...found.values()];
  const infos = markers.length
    ? await retry(() => conn.getMultipleAccountsInfo(markers.map((m) => new PublicKey(m.address))))
    : [];
  const now = Date.now();
  const todo: { address: PublicKey; seed: string; lamports: number }[] = [];
  markers.forEach((m, i) => {
    const info = infos[i];
    let state: string;
    if (!info || info.lamports === 0) state = "closed";
    else if (!info.owner.equals(PublicKey.default) || info.data.length !== 0) state = "skip (not a bare System account)";
    else if (!isMarkerSweepable(m.createdAtMs, now)) state = "keep (still blocks a claim today)";
    else {
      state = "SWEEP";
      todo.push({ address: new PublicKey(m.address), seed: m.seed, lamports: info.lamports });
    }
    console.log(`${m.address}  created ${new Date(m.createdAtMs).toISOString()}  ${info?.lamports ?? 0} lamports  ${state}`);
  });
  const total = todo.reduce((a, t) => a + t.lamports, 0);
  console.log(`markers seen ${markers.length}, sweepable ${todo.length}, total ${total} lamports (${total / 1e9} SOL)`);
  if (!execute || todo.length === 0) return;

  const signer = getDevnetMintSigner();
  if (!signer || signer.publicKey() !== authority.toBase58()) throw new Error("DEVNET_MINT_AUTHORITY_KEYPAIR missing or not the authority");
  for (let i = 0; i < todo.length; i += MARKERS_PER_TX) {
    const batch = todo.slice(i, i + MARKERS_PER_TX);
    const tx = new Transaction();
    for (const t of batch) tx.add(buildMarkerSweepInstruction(authority, t, t.lamports));
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority;
    const signed = signer.signTransaction(tx) as Transaction;
    const sig = await conn.sendRawTransaction(signed.serialize());
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`sweep tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
    console.log(`swept ${batch.length} markers (${batch.reduce((a, t) => a + t.lamports, 0)} lamports): ${sig}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
