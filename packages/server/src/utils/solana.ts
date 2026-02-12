import { Connection, Keypair, Transaction, TransactionInstruction, SendOptions, ComputeBudgetProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { acquireToken, getPrimaryConnection, getFallbackConnection, backoffMs } from "./rpc-client.js";

export { getPrimaryConnection as getConnection, getFallbackConnection };

// BH9: Maximum transaction size in bytes (Solana limit is 1232 bytes)
const MAX_TRANSACTION_SIZE = 1232;

export function loadKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

/**
 * BH11: Fetch recent priority fees from RPC to determine optimal priority fee.
 * BH6: Returns both priority fee and recommended compute units.
 * Falls back to defaults on error.
 */
export async function getRecentPriorityFees(connection: Connection): Promise<{
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
}> {
  try {
    await acquireToken();
    // Get recent prioritization fees for the last 150 slots
    const recentFees = await connection.getRecentPrioritizationFees();
    
    if (recentFees.length === 0) {
      console.warn("[getRecentPriorityFees] No recent fees found, using defaults");
      return { priorityFeeMicroLamports: 10_000, computeUnitLimit: 400_000 };
    }
    
    // Use 75th percentile to balance between cost and reliability
    const sorted = recentFees
      .map(f => f.prioritizationFee)
      .sort((a, b) => a - b);
    const p75Index = Math.floor(sorted.length * 0.75);
    const priorityFee = sorted[p75Index] || 10_000;
    
    // Ensure minimum fee during congestion
    const finalFee = Math.max(priorityFee, 1_000);
    
    // Default compute units (can be adjusted based on instruction complexity)
    const computeUnitLimit = 400_000;
    
    return { priorityFeeMicroLamports: finalFee, computeUnitLimit };
  } catch (err) {
    console.warn("[getRecentPriorityFees] Failed to fetch priority fees:", err);
    return { priorityFeeMicroLamports: 10_000, computeUnitLimit: 400_000 };
  }
}

/**
 * BH9: Check if transaction size exceeds Solana's limit (1232 bytes).
 * Throws error if oversized.
 */
export function checkTransactionSize(tx: Transaction): void {
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (serialized.length > MAX_TRANSACTION_SIZE) {
    throw new Error(
      `Transaction size ${serialized.length} bytes exceeds maximum ${MAX_TRANSACTION_SIZE} bytes`
    );
  }
}

function is429(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit");
  }
  return false;
}

/**
 * Poll getSignatureStatuses until confirmed or timeout.
 * More reliable than confirmTransaction which can falsely report expiry on devnet.
 */
export async function pollSignatureStatus(
  connection: Connection,
  signature: string,
  timeoutMs = 60_000,
): Promise<void> {
  // Validate signature format before polling to avoid wasting RPC calls
  const base58SigRegex = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
  if (!base58SigRegex.test(signature)) {
    throw new Error(`Invalid signature format: ${signature}`);
  }
  
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await acquireToken();
    const resp = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = resp.value[0];
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      if (status.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Transaction ${signature} not confirmed after ${timeoutMs}ms`);
}

export async function sendWithRetry(
  connection: Connection,
  ix: TransactionInstruction,
  signers: Keypair[],
  maxRetries = 3,
): Promise<string> {
  let lastErr: unknown;
  
  // BH6 + BH11: Get dynamic priority fees once (outside retry loop)
  const { priorityFeeMicroLamports, computeUnitLimit } = await getRecentPriorityFees(connection);
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await acquireToken();
      const tx = new Transaction();
      
      // BH6 + BH11: Add compute budget instructions
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports })
      );
      
      tx.add(ix);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);
      
      // BH9: Check transaction size before sending
      checkTransactionSize(tx);

      const opts: SendOptions = { skipPreflight: false, preflightCommitment: "confirmed" };
      await acquireToken();
      const sig = await connection.sendRawTransaction(tx.serialize(), opts);
      
      // Use getSignatureStatuses polling instead of confirmTransaction
      // (confirmTransaction can falsely report "block height exceeded" on devnet)
      await pollSignatureStatus(connection, sig);
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
