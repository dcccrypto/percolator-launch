/**
 * Install the candidate program set into the LOCAL (offline) surfpool, WITHOUT any
 * real key or deploy tx: each program is created as an upgradeable-loader program
 * (program + programdata accounts) via surfnet_setAccount, upgrade authority = the
 * harness's throwaway authority. Then byte-verified by reading programdata back.
 *   wrapper → WRAPPER_PROGRAM_ID (default ETDLAdi…)   stake → GCHhcgw…   nft → CNGBPZR…
 *   matcher → 4seJWjv3… from MATCHER_SO, else the cached live devnet matcher (sha must be 659eaf9d…)
 * Usage: tsx lib/install-programs.ts <rpc> <authorityPubkey> <manifest.json out>
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import { sha256, readProgramBytes, assertLocal } from "./chain.ts";
import { putProgram } from "./offline-programs.ts";

const RPC = process.argv[2] ?? "http://127.0.0.1:28899";
const AUTH = new PublicKey(process.argv[3]);
const OUT = process.argv[4] ?? ".run/programs.json";
assertLocal(RPC);
const CACHE = path.join(path.dirname(OUT), "cache");
const LIVE_MATCHER_SHA = "659eaf9dfd90e7253154a621fa98f3664df95179860cbef0814cc2fc7d0a62c6";
const MATCHER_ID = process.env.MATCHER_PROGRAM_ID ?? "4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT";

function liveMatcher(): string {
  const p = path.join(CACHE, "matcher-devnet.so");
  if (!fs.existsSync(p)) {
    fs.mkdirSync(CACHE, { recursive: true });
    // READ-ONLY dump of the live devnet matcher (no tx, no key)
    execFileSync("solana", ["program", "dump", MATCHER_ID, p + ".raw", "-u", "https://api.devnet.solana.com"], { stdio: "inherit" });
    const raw = fs.readFileSync(p + ".raw");
    const len = Number(raw.readBigUInt64LE(0x28)) + raw.readUInt16LE(0x3a) * raw.readUInt16LE(0x3c);
    fs.writeFileSync(p, raw.subarray(0, len));
  }
  const s = sha256(fs.readFileSync(p));
  if (s !== LIVE_MATCHER_SHA) throw new Error(`cached matcher sha ${s} != live ${LIVE_MATCHER_SHA}`);
  return p;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const targets: [string, string, string][] = [
    ["wrapper", process.env.WRAPPER_PROGRAM_ID ?? "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB", process.env.WRAPPER_SO!],
    ["stake", "GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3", process.env.STAKE_SO!],
    ["nft", "CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3", process.env.NFT_SO!],
    ["matcher", MATCHER_ID, process.env.MATCHER_SO || liveMatcher()],
  ];
  const manifest: Record<string, unknown> = { rpc: RPC, mode: "offline-setAccount", installedAt: new Date().toISOString() };
  for (const [name, id, soPath] of targets) {
    const bytes = fs.readFileSync(soPath);
    await putProgram(RPC, new PublicKey(id), bytes, AUTH, bytes.length + 16_384);
    const after = await readProgramBytes(conn, new PublicKey(id));
    const head = after.data.subarray(0, bytes.length);
    const tailZero = after.data.subarray(bytes.length).every((b) => b === 0);
    const ok = sha256(head) === sha256(bytes) && tailZero && after.authority === AUTH.toBase58();
    manifest[name] = { id, so: soPath, soSha256: sha256(bytes), soLen: bytes.length, onchainSha256: sha256(head), tailZero, authority: after.authority, ok };
    console.log(`${ok ? "OK  " : "FAIL"} ${name} ${id} so=${sha256(bytes).slice(0, 12)} onchain=${sha256(head).slice(0, 12)} tailZero=${tailZero} auth=${after.authority}`);
    if (!ok) throw new Error(`${name} byte-verify failed`);
  }
  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
