import { Connection, Transaction, TransactionInstruction, ComputeBudgetProgram, SendTransactionError, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import type { PublicKey, Signer } from "@solana/web3.js";

/**
 * PERC-8388: Lighthouse v2 program ID — Blowfish/Phantom wallet middleware injects
 * assertion instructions from this program into transactions. These assertions can
 * fail on-chain for programs Blowfish doesn't understand, causing tx reverts even
 * though the actual program logic is correct.
 */
export const LIGHTHOUSE_PROGRAM_ID = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

/** Wallet shape compatible with both old wallet-adapter and Privy compat layer */
export interface WalletLike {
  publicKey: PublicKey | null;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  /**
   * PERC-8388: Atomic sign+send bypasses Lighthouse/Blowfish injection.
   * The wallet signs and sends in one step, so there is no post-sign window
   * for middleware to inject assertion instructions that break our tx.
   * Returns the raw transaction signature bytes.
   */
  signAndSendTransaction?: (tx: Transaction) => Promise<Uint8Array>;
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
  /**
   * Skip preflight simulation on the RPC node. Use as a fallback when wallet
   * middleware (e.g. Blowfish/Lighthouse) injects assertion instructions that
   * fail during simulation but may succeed on-chain once the middleware is
   * addressed. Default: false.
   */
  skipPreflight?: boolean;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_TIME_MS = 90_000;
const PRIORITY_FEE_FALLBACK = Number(process.env.NEXT_PUBLIC_PRIORITY_FEE ?? 100_000);

/** How long a fetched priority fee stays reusable. Fee conditions move on
 *  the order of minutes, not milliseconds — paying a full RPC round-trip for
 *  a fresh 75th-percentile on EVERY submit added user-visible latency between
 *  the confirm click and the wallet popup for no pricing benefit. */
const PRIORITY_FEE_CACHE_MS = 45_000;
let cachedPriorityFee: { fee: number; ts: number } | null = null;

/**
 * Get dynamic priority fee based on recent network conditions.
 * Cached for PRIORITY_FEE_CACHE_MS; falls back to hardcoded value if the RPC
 * call fails.
 */
async function getPriorityFee(connection: Connection): Promise<number> {
  if (cachedPriorityFee && Date.now() - cachedPriorityFee.ts < PRIORITY_FEE_CACHE_MS) {
    return cachedPriorityFee.fee;
  }
  const fee = await fetchPriorityFee(connection);
  cachedPriorityFee = { fee, ts: Date.now() };
  return fee;
}

async function fetchPriorityFee(connection: Connection): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees();
    
    if (!fees || fees.length === 0) {
      return PRIORITY_FEE_FALLBACK;
    }
    
    // Use 75th percentile of recent fees for better reliability
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
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
// Blockhash cache + tx-landing prewarm
// ============================================================================

/** How long a fetched blockhash is reused for NEW submissions. Blockhashes
 *  stay valid for ~60-90s (150 slots) on-chain; reusing one that is ≤20s old
 *  is completely safe and removes an entire RPC round-trip from the
 *  confirm-click → wallet-popup critical path. Retries always force-refresh
 *  (a stale blockhash is a plausible cause of the failure being retried). */
const BLOCKHASH_FRESH_MS = 20_000;
let cachedBlockhash: { blockhash: string; ts: number } | null = null;

async function getFreshBlockhash(connection: Connection, forceFresh = false): Promise<string> {
  if (!forceFresh && cachedBlockhash && Date.now() - cachedBlockhash.ts < BLOCKHASH_FRESH_MS) {
    return cachedBlockhash.blockhash;
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  cachedBlockhash = { blockhash, ts: Date.now() };
  return blockhash;
}

/**
 * Prewarm every cache the tx-submission path reads, so that by the time the
 * user clicks the final confirm button, sendTx reaches the wallet popup with
 * ZERO blocking RPC round-trips of its own. Call this the moment intent is
 * clear — e.g. when a trade/close confirmation modal OPENS (the seconds the
 * user spends reading it are free prefetch time). Fire-and-forget safe:
 * every branch swallows its own errors; sendTx falls back to fetching live.
 */
export function prewarmTxLanding(connection: Connection): void {
  void checkClockDrift(connection).catch(() => {});
  void getPriorityFee(connection).catch(() => {});
  void getFreshBlockhash(connection).catch(() => {});
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
 * Check that the user has enough SOL to cover transaction fees — and, for
 * flows that create an on-chain account (BUG 17), the rent-exemption lamports
 * that account's CreateAccount instruction will move out of the payer.
 * Throws an informative error if the balance is insufficient.
 */
async function checkSufficientBalance(
  connection: Connection,
  payer: PublicKey,
  feeEstimate: FeeEstimate,
  accountCreationLamports: number = 0,
): Promise<void> {
  try {
    const balance = await connection.getBalance(payer);
    // Add 10% buffer for potential fee fluctuations, plus the exact rent this
    // tx will pay to create an account (0 for a plain trade — never over-charge
    // it), plus MIN_SOL_BALANCE_LAMPORTS as extra headroom on ONLY the
    // account-creation flows (so the wallet doesn't land back below
    // rent-exemption immediately after paying it).
    const requiredWithBuffer =
      Math.ceil(feeEstimate.total * 1.1) +
      accountCreationLamports +
      (accountCreationLamports > 0 ? MIN_SOL_BALANCE_LAMPORTS : 0);

    if (balance < requiredWithBuffer) {
      const balanceSol = (balance / 1e9).toFixed(6);
      const requiredSol = (requiredWithBuffer / 1e9).toFixed(6);
      const rentNote =
        accountCreationLamports > 0
          ? ` + ~${(accountCreationLamports / 1e9).toFixed(6)} SOL account rent`
          : "";
      throw new Error(
        `Insufficient SOL for transaction fees${accountCreationLamports > 0 ? " and account rent" : ""}. ` +
        `Balance: ${balanceSol} SOL, Required: ~${requiredSol} SOL ` +
        `(base fee: ${feeEstimate.baseFee} lamports + priority fee: ${feeEstimate.priorityFee} lamports${rentNote}). ` +
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

    // Adaptive cadence: a tx typically confirms within 1-2 slots (~0.4-0.8s),
    // so a flat 2s interval made the USER wait ~+1.2s on average purely for
    // the confirmation FEEDBACK after the chain was already done. Poll fast
    // while confirmation is imminent, then back off — worst case this adds a
    // handful of extra getSignatureStatuses calls (cheap, unbatched) in the
    // first seconds; the common case exits after 2-3 fast polls.
    const elapsedNow = Date.now() - start;
    const interval =
      elapsedNow < 5_000 ? 350 :
      elapsedNow < 15_000 ? 1_000 :
      POLL_INTERVAL_MS;
    await new Promise((r) => setTimeout(r, interval));
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

/** Flat safety buffer stacked on top of exact fees/rent (BUG 17). */
const MIN_SOL_BALANCE_LAMPORTS = 10_000_000; // 0.01 SOL safety buffer

/**
 * BUG 17: Sum the lamports moved by any SystemProgram CreateAccount instructions
 * in this transaction. The v17 first-deposit/InitPortfolio flow (useDeposit.ts,
 * useInitUser.ts, useCreateMarket.ts) prepends a CreateAccount instruction that
 * transfers rent-exempt lamports (currently ~0.066 SOL for the 9347-byte v17
 * portfolio) from the payer to the new account — lamports the fee-only
 * pre-flight balance check below never counted, so a low-SOL wallet passed
 * pre-flight and then failed on-chain with a raw System/SPL error.
 *
 * Detecting this by inspecting the instructions (rather than threading a new
 * "createsAccount" flag through every sendTx() call site) means a plain trade
 * — which never includes a CreateAccount instruction — is never over-charged.
 */
function getAccountCreationLamports(instructions: TransactionInstruction[]): number {
  let total = 0;
  for (const ix of instructions) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;
    // System Program instruction layout (borsh): u32 discriminant | ...
    // CreateAccount (discriminant 0): u32 | u64 lamports | u64 space | Pubkey owner
    if (ix.data.length < 12) continue;
    if (ix.data.readUInt32LE(0) !== 0) continue; // only CreateAccount is used by these flows
    total += Number(ix.data.readBigUInt64LE(4));
  }
  return total;
}

export async function sendTx({
  connection,
  wallet,
  instructions,
  computeUnits = 200_000,
  signers = [],
  maxRetries = 2,
  onProgress,
  abortSignal,
  skipPreflight = false,
}: SendTxParams): Promise<string> {
  if (!wallet.publicKey || (!wallet.signTransaction && !wallet.signAndSendTransaction)) {
    throw new Error("Wallet not connected");
  }

  // Check clock drift — genuinely non-blocking now (it was awaited serially
  // here despite its own "non-blocking" comment, costing two RPC round-trips
  // on the first submission of a session before the wallet popup could
  // appear). It self-caches for 5min; the warning below reads whatever the
  // last completed check found.
  void checkClockDrift(connection).catch(() => {});
  const driftWarning = getClockDriftWarning();
  if (driftWarning) {
    // Log prominently — UI layer can also call getClockDriftWarning() to display a toast
    console.warn(`⚠️ ${driftWarning}`);
  }

  let lastError: Error | null = null;
  let lastSignature: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Latency: kick the blockhash fetch off FIRST so it overlaps the fee
      // lookup below (both usually resolve instantly from their caches after
      // a prewarmTxLanding call; retries force a fresh blockhash since a
      // stale one is a plausible cause of the failure being retried).
      const blockhashPromise = getFreshBlockhash(connection, attempt > 0);

      // Get dynamic priority fee on first attempt (cached 45s)
      const priorityFee = attempt === 0 ? await getPriorityFee(connection) : PRIORITY_FEE_FALLBACK;

      // Pre-flight fee estimation and balance check (first attempt only).
      // Started here, awaited just before signing — it runs CONCURRENTLY with
      // the blockhash fetch + tx build instead of adding its own serial RPC
      // round-trip to the popup latency.
      let balanceCheckPromise: Promise<void> | null = null;
      if (attempt === 0) {
        const numSignatures = 1 + signers.length; // wallet + additional signers
        const fees = estimateFees(computeUnits, priorityFee, numSignatures);
        // BUG 17: only non-zero when this tx actually creates an account (e.g.
        // init/first-deposit's InitPortfolio) — a plain trade's instructions
        // contain no CreateAccount ix, so this is 0 and behavior is unchanged.
        const accountCreationLamports = getAccountCreationLamports(instructions);
        balanceCheckPromise = checkSufficientBalance(connection, wallet.publicKey, fees, accountCreationLamports);
      }

      // PERC-8388: Strip any Lighthouse assertion instructions that may have been
      // injected into the instruction array by wallet middleware or upstream hooks.
      // This is a defensive filter — our code doesn't add these, but wallet extensions
      // or provider wrappers might contaminate the instruction list before it reaches sendTx.
      const cleanInstructions = instructions.filter(
        (ix) => ix.programId.toBase58() !== LIGHTHOUSE_PROGRAM_ID
      );

      const tx = new Transaction();
      // v17 wrapper installs a custom 128KB heap allocator and aborts ("Access
      // violation in heap section") on its first heap allocation unless the tx
      // requests the full heap frame. Must be the FIRST instruction. (issue #176)
      tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
      for (const ix of cleanInstructions) {
        tx.add(ix);
      }

      tx.recentBlockhash = await blockhashPromise;
      tx.feePayer = wallet.publicKey;

      // Balance sufficiency must still resolve BEFORE the user is asked to
      // sign (its "add X SOL" error beats a cryptic on-chain failure) — but
      // it ran concurrently with everything above instead of serially.
      if (balanceCheckPromise) await balanceCheckPromise;

      // Simulation: catch program errors before anything is broadcast.
      // Skipped when skipPreflight is true (PERC-8388: wallet middleware injects
      // assertion IXs that fail simulation but aren't in our actual tx).
      // Skipped when extra signers are present — the wallet hasn't signed yet
      // so simulation would fail with MissingRequiredSignature.
      //
      // WHERE it runs depends on the signing path:
      // - signAndSendTransaction (atomic sign+broadcast): the wallet puts the
      //   tx on the wire the moment the user approves, so simulation must
      //   complete BEFORE the popup — unchanged behavior.
      // - signTransaction (we broadcast ourselves): the simulation and the
      //   wallet-approval popup run CONCURRENTLY, and the broadcast below is
      //   gated on the simulation verdict. Identical safety property —
      //   nothing that fails simulation is ever broadcast — but the popup
      //   appears one full RPC round-trip sooner, and the user's reading/
      //   approval time absorbs the simulation latency entirely.
      const usesAtomicSend = !!wallet.signAndSendTransaction && signers.length === 0;
      const runSimulation = async (): Promise<void> => {
        try {
          const simResult = await connection.simulateTransaction(tx);
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
      };
      const wantSimulation = !skipPreflight && signers.length === 0;
      if (wantSimulation && usesAtomicSend) {
        await runSimulation();
      }
      // Settled-result wrapper so a simulation rejection can't become an
      // unhandled rejection while we're awaiting the wallet popup.
      const concurrentSimGate: Promise<Error | null> | null =
        wantSimulation && !usesAtomicSend
          ? runSimulation().then(
              () => null,
              (e) => (e instanceof Error ? e : new Error(String(e))),
            )
          : null;

      // ================================================================
      // PERC-8388: Use signAndSendTransaction when available.
      // This is the definitive fix for Lighthouse/Blowfish injection.
      // The wallet signs and broadcasts atomically — there is no post-sign
      // window for middleware to inject assertion instructions.
      // ================================================================
      if (wallet.signAndSendTransaction && signers.length === 0) {
        // Only use atomic sign+send when there are no extra signers.
        // signAndSendTransaction may drop partial signatures from keypair signers.
        try {
          const sigBytes = await wallet.signAndSendTransaction(tx);
          // Privy returns raw signature bytes (64 bytes). Convert to base58.
          lastSignature = bs58.encode(sigBytes);
        } catch (sendErr) {
          const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          // Check for Lighthouse-specific errors and provide user-friendly message
          if (
            sendMsg.includes(LIGHTHOUSE_PROGRAM_ID) ||
            sendMsg.includes("0x1900") ||
            sendMsg.includes("Lighthouse")
          ) {
            throw new Error(
              "Transaction blocked by wallet security (Blowfish/Lighthouse). " +
              "Your wallet's transaction guard flagged this as unknown. " +
              "Try disabling transaction simulation in your wallet settings, " +
              "or use a different wallet. This is a known issue for new DeFi programs."
            );
          }
          throw sendErr;
        }
      } else if (wallet.signTransaction) {
        // Fallback: signTransaction + sendRawTransaction (legacy path)
        const signed = await wallet.signTransaction(tx);

        // Add keypair signatures AFTER wallet signs — Privy embedded wallets
        // may strip unknown signatures during their signing flow.
        if (signers.length > 0) {
          for (const signer of signers) {
            signed.partialSign(signer);
          }
        }

        // PERC-8388: Detect Lighthouse injection and warn
        const lighthouseIxs = signed.instructions.filter(
          (ix) => ix.programId.toBase58() === LIGHTHOUSE_PROGRAM_ID
        );
        if (lighthouseIxs.length > 0) {
          console.warn(
            `[sendTx] PERC-8388: Wallet injected ${lighthouseIxs.length} Lighthouse IX(s). ` +
            `Sending with skipPreflight=true as workaround.`
          );
          skipPreflight = true;
        }

        // Gate the broadcast on the concurrent simulation's verdict (started
        // before the wallet popup, see above). If simulation reported a
        // program error, the user's signature is simply never broadcast —
        // same safety property as the old simulate-then-popup ordering.
        if (concurrentSimGate) {
          const simErr = await concurrentSimGate;
          if (simErr) throw simErr;
        }

        try {
          lastSignature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: skipPreflight ?? false,
            maxRetries: 5,
          });
        } catch (sendErr) {
          const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          const isBatchError =
            sendMsg.includes("Missing response from batch") ||
            sendMsg.includes("failed to get recent blockhash") ||
            sendMsg.includes("RPC response error");

          if (isBatchError) {
            console.warn(
              `[sendTx] Batch RPC error (attempt ${attempt + 1}); will retry.`
            );
            throw sendErr;
          } else if (sendErr instanceof SendTransactionError) {
            try {
              const logs = await sendErr.getLogs(connection);
              if (logs && logs.length > 0) {
                const relevantLogs = logs
                  .filter((l: string) =>
                    l.includes("Error") || l.includes("failed") || l.includes("Program log:")
                  )
                  .slice(-5)
                  .join("\n");
                throw new Error(`${sendMsg}${relevantLogs ? `\n${relevantLogs}` : ""}`);
              }
            } catch (logsErr) {
              if (logsErr instanceof Error && logsErr.message !== sendMsg) throw logsErr;
            }
            throw sendErr;
          } else {
            throw sendErr;
          }
        }
      } else {
        throw new Error("Wallet not connected — no sign method available");
      }

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

        // SAFETY: If the wallet used signAndSendTransaction (atomic sign+broadcast),
        // do NOT rebuild and re-send — the first tx may still land on-chain, and
        // re-sending would execute the operation twice (double trade, double fee).
        // Instead, only extend polling for the existing signature.
        if (wallet.signAndSendTransaction && lastSignature) {
          // Give the original tx more time to land before giving up
          await new Promise((r) => setTimeout(r, 4000));
          try {
            const retryStatus = await connection.getSignatureStatuses([lastSignature], {
              searchTransactionHistory: true,
            });
            const s = retryStatus.value[0];
            if (s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
              return lastSignature;
            }
          } catch { /* fall through to throw */ }
          throw lastError;
        }

        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Transaction failed after retries");
}
