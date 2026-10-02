/**
 * Local-validator helpers. EVERY function here refuses a non-local RPC URL:
 * this harness must never send a transaction to devnet/mainnet.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import crypto from "node:crypto";

export function assertLocal(url: string): void {
  const h = new URL(url).hostname;
  if (!["127.0.0.1", "localhost"].includes(h)) throw new Error(`REFUSING non-local RPC ${url}`);
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  assertLocal(url);
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string; code: number } };
  if (j.error) throw new Error(`${method}: ${j.error.code} ${j.error.message}`);
  return j.result as T;
}

export function sha256(b: Uint8Array): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

export const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_UPGRADEABLE)[0];
}

/** Returns the ELF bytes stored in an upgradeable program's programdata (full allocation). */
export async function readProgramBytes(conn: Connection, programId: PublicKey): Promise<{ data: Buffer; authority: string | null }> {
  const pd = programDataAddress(programId);
  const ai = await conn.getAccountInfo(pd, "confirmed");
  if (!ai) throw new Error(`no programdata for ${programId.toBase58()}`);
  // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority: Option<Pubkey> } = 4 + 8 + 1 + 32 = 45
  const hasAuth = ai.data[12] === 1;
  const authority = hasAuth ? new PublicKey(ai.data.subarray(13, 45)).toBase58() : null;
  return { data: Buffer.from(ai.data.subarray(45)), authority };
}

export async function slotNow(conn: Connection): Promise<number> {
  return conn.getSlot("confirmed");
}
