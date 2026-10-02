/**
 * Build the sandbox HOME the P0a seed + keeper run under. Every key in it is a
 * THROWAWAY generated in-session; the real ~/.config/solana keys are never read.
 * Also rewrites the local-fork Sim-USDC mint authority to the throwaway mint
 * authority (surfnet_setMintAccount — a local cheatcode, not a devnet tx) and
 * airdrops local SOL.
 * Usage: tsx lib/sandbox.ts <runDir> <devnetForkRpc> <mainnetForkRpc>
 */
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { rpc, assertLocal } from "./chain.ts";

const RUN = path.resolve(process.argv[2] ?? ".run");
const RPC = process.argv[3] ?? "http://127.0.0.1:28899";
const MRPC = process.argv[4] ?? "http://127.0.0.1:38899";
assertLocal(RPC); assertLocal(MRPC);
export const SIM_USDC = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

function kp(file: string): Keypair {
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  const k = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  return k;
}

async function main() {
  const home = path.join(RUN, "home");
  const sol = path.join(home, ".config", "solana");
  const admin = kp(path.join(sol, "percolator-v17-devnet.json")); // seed's admin == marketauth == oracle authority == keeper
  const mintAuth = kp(path.join(sol, "percolator-devnet-mint-authority.json"));
  fs.mkdirSync(path.join(home, "percolator-oracle-keeper"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "percolator-oracle-keeper", ".env"),
    `# e2e-fork sandbox — LOCAL ONLY\nMAINNET_RPC_URL=${MRPC}\nDEVNET_RPC_URL=${RPC}\n`,
  );
  const conn = new Connection(RPC, "confirmed");
  // OFFLINE: create the Sim-USDC mint at its devnet address (SPL Mint, 82 B, 6 dp),
  // mint authority = the throwaway mint authority. Local cheatcode, not a devnet tx.
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0); mintAuth.publicKey.toBuffer().copy(data, 4); // mint_authority
  data.writeBigUInt64LE(0n, 36); data[44] = 6; data[45] = 1;              // supply, decimals, is_initialized
  await rpc(RPC, "surfnet_setAccount", [SIM_USDC, { data: data.toString("hex"), owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", lamports: 1_461_600 }]);
  const mi = await conn.getParsedAccountInfo(new PublicKey(SIM_USDC));
  const parsed = (mi.value?.data as { parsed?: { info?: { mintAuthority?: string } } })?.parsed?.info;
  if (parsed?.mintAuthority !== mintAuth.publicKey.toBase58()) throw new Error(`Sim-USDC mint authority not rewritten: ${JSON.stringify(parsed)}`);
  for (const k of [admin, mintAuth]) {
    await rpc(RPC, "surfnet_setAccount", [k.publicKey.toBase58(), { lamports: 1000 * LAMPORTS_PER_SOL }]);
  }
  const out = { home, admin: admin.publicKey.toBase58(), mintAuth: mintAuth.publicKey.toBase58(), simUsdc: SIM_USDC };
  fs.writeFileSync(path.join(RUN, "sandbox.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out));
}
main().catch((e) => { console.error(e); process.exit(1); });
