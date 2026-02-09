import { Connection, Keypair, Transaction, TransactionInstruction, SendOptions } from "@solana/web3.js";
import bs58 from "bs58";
import { acquireToken, getPrimaryConnection, getFallbackConnection, backoffMs } from "./rpc-client.js";

export { getPrimaryConnection as getConnection, getFallbackConnection };

export function loadKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function is429(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit");
  }
  return false;
}

export async function sendWithRetry(
  connection: Connection,
  ix: TransactionInstruction,
  signers: Keypair[],
  maxRetries = 3,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await acquireToken();
      const tx = new Transaction().add(ix);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);

      const opts: SendOptions = { skipPreflight: false, preflightCommitment: "confirmed" };
      await acquireToken();
      const sig = await connection.sendRawTransaction(tx.serialize(), opts);
      await acquireToken();
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    } catch (err) {
      lastErr = err;
      const delay = is429(err)
        ? backoffMs(attempt, 2000, 30_000)
        : Math.min(1000 * 2 ** attempt, 8000);
      console.warn(`[sendWithRetry] Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
