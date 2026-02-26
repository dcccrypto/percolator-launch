import { Connection, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import type { PublicKey, Signer } from "@solana/web3.js";
import { getConfig } from "./config";

/** Wallet shape compatible with both old wallet-adapter and Privy compat layer */
export interface WalletLike {
  publicKey: PublicKey | null;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
}

export interface SendTxParams {
  connection: Connection;
  wallet: WalletLike;
  instructions: TransactionInstruction[];
  computeUnits?: number;
  signers?: Signer[];
  /** Max retries on blockhash expiry (default 2) */
  maxRetries?: number;
  /** Optional callback for confirmation progress (elapsed time in ms) */
  onProgress?: (elapsedMs: number) => void;
  /** Optional AbortSignal to cancel confirmation polling */
  abortSignal?: AbortSignal;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_TIME_MS = 90_000;
const PRIORITY_FEE_FALLBACK = Number(process.env.NEXT_PUBLIC_PRIORITY_FEE ?? 100_000);

/**
 * Get dynamic priority fee based on recent network conditions.
 * Falls back to hardcoded value if RPC call fails.
 */
async function getPriorityFee(connection: Connection): Promise<number> {
  try {
    // @ts-ignore - getRecentPrioritizationFees not in @solana/web3.js types yet
    const fees = await connection.getRecentPrioritizationFees();
    
    if (!fees || fees.length === 0) {
      return PRIORITY_FEE_FALLBACK;
    }
    
    // Use 75th percentile of recent fees for better reliability
    const sorted = fees.map((f: any) => f.prioritizationFee).sort((a: number, b: number) => a - b);
    const p75Index = Math.floor(sorted.length * 0.75);
    const dynamicFee = sorted[p75Index] || 0;
    
    // Use dynamic fee if it's reasonable, otherwise fall back
    // Cap at 10x the fallback to avoid excessive fees
    if (dynamicFee > 0 && dynamicFee < PRIORITY_FEE_FALLBACK * 10) {
      return dynamicFee;
    }
    
    return PRIORITY_FEE_FALLBACK;
  } catch (error) {
    console.warn("[getPriorityFee] Failed to fetch dynamic fees, using fallback:", error);
    return PRIORITY_FEE_FALLBACK;
  }
}

// ============================================================================
// Clock drift detection
// ============================================================================

/** Maximum acceptable clock drift in seconds before warning */
const MAX_CLOCK_DRIFT_SECONDS = 30;
/** How often to re-check clock drift (ms) */
const CLOCK_DRIFT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastClockDriftCheckMs = 0;
let cachedClockDriftSeconds = 0;

/**
 * Detect clock drift between the client machine and the Solana cluster.
 * Large drift causes signature verification failures and blockhash expiry
 * because the wallet signs with a timestamp that the cluster considers stale.
 */
async function checkClockDrift(connection: Connection): Promise<void> {
  const now = Date.now();
  if (now - lastClockDriftCheckMs < CLOCK_DRIFT_CHECK_INTERVAL_MS) return;
  lastClockDriftCheckMs = now;

  try {
    const beforeMs = Date.now();
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot);
    const afterMs = Date.now();

    if (blockTime === null) return; // Some RPC providers don't support getBlockTime

    // Estimate the one-way latency and use midpoint
    const rttMs = afterMs - beforeMs;
    const clientTimeSec = Math.floor((beforeMs + rttMs / 2) / 1000);
    const driftSeconds = Math.abs(clientTimeSec - blockTime);
    cachedClockDriftSeconds = driftSeconds;

    if (driftSeconds > MAX_CLOCK_DRIFT_SECONDS) {
      console.warn(
        `[sendTx] Clock drift detected: ${driftSeconds}s between your machine and Solana cluster. ` +
        `This may cause signature verification failures. Please sync your system clock.`
      );
    }
  } catch {
    // Non-critical — don't block transactions if drift check fails
  }
}

/**
 * Get a user-facing clock drift warning message, or null if drift is acceptable.
 */
export function getClockDriftWarning(): string | null {
  if (cachedClockDriftSeconds > MAX_CLOCK_DRIFT_SECONDS) {
    return (
      `Your system clock is ${cachedClockDriftSeconds}s out of sync with the Solana network. ` +
      `This can cause transaction failures. Please sync your system clock ` +
      `(Settings → Date & Time → Set Automatically).`
    );
  }
  return null;
}

// ============================================================================
// Fee estimation
// ============================================================================

/** Base transaction fee per signature (lamports) */
const BASE_TX_FEE_LAMPORTS = 5000;

export interface FeeEstimate {
  /** Base fee in lamports (5000 per signature) */
  baseFee: number;
  /** Priority fee in lamports */
  priorityFee: number;
  /** Total estimated cost in lamports */
  total: number;
  /** Total estimated cost in SOL */
  totalSol: number;
}

/**
 * Estimate total transaction fees before sending.
 * Accounts for: base tx fee, compute unit price (priority fee), and number of signers.
 */
export function estimateFees(
  computeUnits: number,
  priorityFeeMicroLamports: number,
  numSignatures: number = 1,
): FeeEstimate {
  const baseFee = BASE_TX_FEE_LAMPORTS * numSignatures;
  // Priority fee: (computeUnits × microLamports) / 1_000_000
  const priorityFee = Math.ceil((computeUnits * priorityFeeMicroLamports) / 1_000_000);
  const total = baseFee + priorityFee;
  return {
    baseFee,
    priorityFee,
    total,
    totalSol: total / 1e9,
  };
}

/**
 * Check that the user has enough SOL to cover transaction fees.
 * Throws an informative error if the balance is insufficient.
 */
async function checkSufficientBalance(
  connection: Connection,
  payer: PublicKey,
  feeEstimate: FeeEstimate,
): Promise<void> {
  try {
    const balance = await connection.getBalance(payer);
    // Add 10% buffer for potential fee fluctuations
    const requiredWithBuffer = Math.ceil(feeEstimate.total * 1.1);

    if (balance < requiredWithBuffer) {
      const balanceSol = (balance / 1e9).toFixed(6);
      const requiredSol = (requiredWithBuffer / 1e9).toFixed(6);
      throw new Error(
        `Insufficient SOL for transaction fees. ` +
        `Balance: ${balanceSol} SOL, Required: ~${requiredSol} SOL ` +
        `(base fee: ${feeEstimate.baseFee} lamports + priority fee: ${feeEstimate.priorityFee} lamports). ` +
        `Please add at least ${((requiredWithBuffer - balance) / 1e9).toFixed(6)} SOL to your wallet.`
      );
    }
  } catch (e) {
    // Rethrow our own insufficient balance error
    if (e instanceof Error && e.message.includes("Insufficient SOL")) throw e;
    // Otherwise log and don't block — balance check is advisory
    console.warn("[checkSufficientBalance] Failed to check balance:", e);
  }
}

// ============================================================================
// Network validation
// ============================================================================

// Network detection cache — only check once per session
let networkValidated = false;
let lastGenesisHash: string | null = null;

/**
 * Validate that the wallet's connected network matches the app's expected network.
 * Throws an error if there's a mismatch (e.g. wallet on mainnet, app on devnet).
 */
async function validateNetwork(connection: Connection): Promise<void> {
  if (networkValidated) return; // Already validated this session
  
  try {
    const genesisHash = await connection.getGenesisHash();
    const cfg = getConfig();
    
    // Known genesis hashes for Solana clusters
    const GENESIS_HASHES = {
      mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    };
    
    const expectedHash = GENESIS_HASHES[cfg.network as keyof typeof GENESIS_HASHES];
    
    if (expectedHash && genesisHash !== expectedHash) {
      // Cache the detected hash to show in error message
      lastGenesisHash = genesisHash;
      
      // Determine which network the wallet is actually on
      let detectedNetwork = "unknown";
      for (const [net, hash] of Object.entries(GENESIS_HASHES)) {
        if (hash === genesisHash) {
          detectedNetwork = net;
          break;
        }
      }
      
      throw new Error(
        `Network mismatch: App is configured for ${cfg.network.toUpperCase()} but your wallet is connected to ${detectedNetwork.toUpperCase()}. ` +
        `Please switch your wallet to ${cfg.network.toUpperCase()} or change the app network in settings.`
      );
    }
    
    networkValidated = true;
    lastGenesisHash = genesisHash;
  } catch (error) {
    // If it's our network mismatch error, rethrow it
    if (error instanceof Error && error.message.includes("Network mismatch")) {
      throw error;
    }
    // Otherwise, log but don't block (RPC might not support getGenesisHash)
    console.warn("[validateNetwork] Failed to validate network:", error);
  }
}

/**
 * Poll getSignatureStatuses until confirmed or timeout.
 * More reliable than confirmTransaction which can falsely report expiry.
 * 
 * @param onProgress - Optional callback for progress updates (elapsed time in ms)
 * @param abortSignal - Optional AbortSignal to cancel polling
 */
async function pollConfirmation(
  connection: Connection,
  signature: string,
  onProgress?: (elapsedMs: number) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const start = Date.now();
  let pollCount = 0;

  while (Date.now() - start < MAX_POLL_TIME_MS) {
    // Check if aborted
    if (abortSignal?.aborted) {
      throw new Error("Transaction confirmation cancelled by user. Note: transaction may still land on-chain.");
    }
    
    pollCount++;
    const elapsed = Date.now() - start;
    
    // Report progress
    if (onProgress) {
      onProgress(elapsed);
    }
    
    try {
      const resp = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: pollCount > 5,
      });
      const status = resp.value[0];

      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return; // Success!
        }
      }
    } catch (e) {
      // If it's our own "Transaction failed" error, rethrow
      if (e instanceof Error && e.message.startsWith("Transaction failed:")) throw e;
      // Otherwise RPC hiccup — keep polling
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Confirmation timeout (${MAX_POLL_TIME_MS / 1000}s) — tx may still land. Check explorer: ${signature}`
  );
}

/**
 * Send a transaction with polling-based confirmation.
 *
 * Uses getSignatureStatuses polling instead of confirmTransaction,
 * which can falsely report "block height exceeded" when the tx
 * actually landed on-chain.
 */
export async function sendTx({
  connection,
  wallet,
  instructions,
  computeUnits = 200_000,
  signers = [],
  maxRetries = 2,
  onProgress,
  abortSignal,
}: SendTxParams): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error("Wallet not connected");
  }
  
  // Validate network before sending any transactions
  await validateNetwork(connection);

  // Check clock drift (non-blocking, warns in console; cached 5min)
  await checkClockDrift(connection);
  const driftWarning = getClockDriftWarning();
  if (driftWarning) {
    // Log prominently — UI layer can also call getClockDriftWarning() to display a toast
    console.warn(`⚠️ ${driftWarning}`);
  }

  let lastError: Error | null = null;
  let lastSignature: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Get dynamic priority fee on first attempt
      const priorityFee = attempt === 0 ? await getPriorityFee(connection) : PRIORITY_FEE_FALLBACK;

      // Pre-flight fee estimation and balance check (first attempt only)
      if (attempt === 0) {
        const numSignatures = 1 + signers.length; // wallet + additional signers
        const fees = estimateFees(computeUnits, priorityFee, numSignatures);
        await checkSufficientBalance(connection, wallet.publicKey, fees);
      }
      
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
      for (const ix of instructions) {
        tx.add(ix);
      }

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;

      if (signers.length > 0) {
        tx.partialSign(...signers);
      }

      // Pre-sign simulation: catch program errors before the user signs.
      // This gives a clear error message instead of a cryptic post-sign failure.
      // We pass existing signers for account-creation txs; wallet sig is not
      // needed since simulateTransaction with signers array skips sig verify.
      try {
        const simResult = await connection.simulateTransaction(tx, signers.length > 0 ? signers : undefined);
        if (simResult.value.err) {
          const logs = simResult.value.logs ?? [];
          // Extract the most useful log line (program error or custom message)
          const errorLog = logs
            .filter((l: string) => l.includes("Error") || l.includes("failed") || l.includes("Program log:"))
            .slice(-3)
            .join("\n");
          throw new Error(
            `Transaction simulation failed: ${JSON.stringify(simResult.value.err)}` +
            (errorLog ? `\n${errorLog}` : "")
          );
        }
      } catch (simError) {
        // If it's our own simulation error, rethrow with clear message
        if (simError instanceof Error && simError.message.startsWith("Transaction simulation failed")) {
          throw simError;
        }
        // Otherwise RPC error during simulation — log but don't block
        // (the tx may still succeed; skipPreflight: false will catch it again)
        console.warn("[sendTx] Pre-sign simulation failed (non-blocking):", simError);
      }

      const signed = await wallet.signTransaction(tx);

      lastSignature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
      });

      // Poll for confirmation instead of using confirmTransaction
      // (confirmTransaction falsely reports "block height exceeded" on devnet)
      await pollConfirmation(connection, lastSignature, onProgress, abortSignal);

      return lastSignature;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = e instanceof Error ? e : new Error(msg);

      const isBlockhashExpired =
        msg.includes("block height exceeded") ||
        msg.includes("Blockhash not found") ||
        msg.includes("has expired");

      // If clock drift is large, enrich the error message for the user
      if (isBlockhashExpired && cachedClockDriftSeconds > MAX_CLOCK_DRIFT_SECONDS) {
        lastError = new Error(
          `${msg} — Your system clock is ${cachedClockDriftSeconds}s out of sync. ` +
          `Please sync your system clock (Settings → Date & Time → Set Automatically) and retry.`
        );
      }

      if (isBlockhashExpired && attempt < maxRetries) {
        // R2-S7: Before retrying, check if the original tx actually landed
        if (lastSignature) {
          try {
            const statusResp = await connection.getSignatureStatuses([lastSignature], {
              searchTransactionHistory: true,
            });
            const prevStatus = statusResp.value[0];
            if (
              prevStatus &&
              !prevStatus.err &&
              (prevStatus.confirmationStatus === "confirmed" ||
                prevStatus.confirmationStatus === "finalized")
            ) {
              return lastSignature; // Already landed — no retry needed
            }
          } catch {
            // RPC error checking status — proceed with retry
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Transaction failed after retries");
}
