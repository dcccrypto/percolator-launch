import { Connection, Transaction, TransactionInstruction, ComputeBudgetProgram, SendTransactionError, SystemProgram, TransactionExpiredBlockheightExceededError, VersionedTransaction } from "@solana/web3.js";
import { MAX_TX_COMPUTE_UNITS, sizeComputeUnitLimit, type CuSizing } from "@/lib/compute-budget";
import bs58 from "bs58";
import type { PublicKey, Signer } from "@solana/web3.js";
import { getNetwork } from "@/lib/config";
import { connectionSelfHealDeps, describeRepair, isSelfHealEnabled, planSelfHeal } from "@/lib/self-heal";
import {
  connectionVaultLpRepairDeps,
  isVaultLpSelfHealEnabled,
  planVaultLpRepair,
  type VaultLpRepairResult,
} from "@/lib/limits/vault-lp-repair";
import {
  connectionSeniorDrawRepairDeps,
  planSeniorDrawRepair,
  type SeniorDrawRepairResult,
} from "@/lib/limits/senior-draw-repair";
import type { AccountMeta } from "@solana/web3.js";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import type { SelfHealResult } from "@/lib/self-heal";
import { getMaintenanceConfig, MaintenanceError } from "@/lib/maintenance";
import { readU64LE } from "@/lib/u64le";

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
  /**
   * Finish the simulation BEFORE the wallet prompt, and also when `signers`
   * are present (simulation uses sigVerify:false, so missing keypair
   * signatures don't matter). Default false, which keeps the latency-optimised
   * ordering where the popup and the simulation overlap on devnet.
   *
   * Use it when a revert is plausible: with the overlapped ordering the wallet
   * simulates first and shows the user its own generic "this transaction may
   * fail" warning, and our decoded explanation only arrives after they have
   * already been asked to sign. The create-market wizard sets it on every step.
   */
  simulateBeforeSign?: boolean;
  /**
   * P0b client self-heal (lib/self-heal.ts). When set, sendTx reads this
   * market (overlapped with the blockhash fetch) and, only if the user's
   * transaction would revert Custom(19)/Custom(21) because of a lapsed backing
   * bucket or a ResetPending side, prepends the permissionless repairs
   * (ExpireBackingBucket 89 / FinalizeResetSide 45) to THIS transaction.
   * Steady state (nothing to repair) costs one overlapped account read.
   */
  selfHeal?: {
    programId: PublicKey;
    market: PublicKey;
    /** UX WP-2: repair a lagging engine clock with catch-up cranks of this LP (null = bound vault LP). */
    catchUp?: { portfolio: PublicKey | null; oracleTail?: AccountMeta[] };
  };
  /** Test/diagnostic hook: receives the self-heal decision once per sendTx. */
  onSelfHeal?: (result: SelfHealResult) => void;
  /**
   * P3-L2 self-repair (lib/limits/vault-lp-repair.ts): on a vault-owned-LP market, when
   * the user's Earn tx would revert VaultLpValuationStale, prepend the permissionless
   * crank of the vault LP into THIS tx. Planned after the P0b self-heal, on every attempt.
   */
  vaultLpRepair?: { programId: PublicKey; market: PublicKey; oracleTail?: AccountMeta[] };
  /**
   * Size the ComputeBudget limit from a simulation of THIS instruction list (after any
   * self-heal / vault-LP repair): consumed + margin, clamped to `cap` (lib/compute-budget.ts).
   * When set, `computeUnits` is ignored. Trades, closes and batches use it (P1: CPI trades
   * need ~13k more CU; a single-leg batch on asset 1 needs 216k > the 200k default).
   */
  computeUnitsFromSim?: CuSizing;
  /** Test/diagnostic hook: the limit sendTx set and the consumed CU it was sized from. */
  onComputeUnits?: (r: { limit: number; consumed: number | null }) => void;
  onVaultLpRepair?: (result: VaultLpRepairResult) => void;
  /** Test/diagnostic hook: the senior-draw repair's outcome (runs whenever vaultLpRepair is set). */
  onSeniorDrawRepair?: (result: SeniorDrawRepairResult) => void;
}

/**
 * UX WP-1 (SH-1): a simulation refused the transaction, so the wallet was NOT opened.
 * Carries what the message resolver (lib/limits/user-message.ts) needs; the message keeps
 * the historic "Transaction simulation failed: …" prefix so older string classifiers work.
 */
export class SimulationRefusal extends Error {
  readonly err: unknown;
  readonly logs: string[];
  /** Custom program error code, when the refusal is one. */
  readonly code: number | null;
  /** Index of the failing instruction in the simulated list, when known. */
  readonly instructionIndex: number | null;
  /** Program id of the failing instruction (from the list, else the "Program X failed" log). */
  readonly programId: string | null;
  constructor(err: unknown, logs: readonly string[] = [], instructions: readonly TransactionInstruction[] = []) {
    const failing = logs.filter((l) => l.includes("Error") || l.includes("failed") || l.includes("Program log:")).slice(-3).join("\n");
    super(`Transaction simulation failed: ${JSON.stringify(err)}` + (failing ? `\n${failing}` : ""));
    this.name = "SimulationRefusal";
    this.err = err;
    this.logs = [...logs];
    const ie = (err as { InstructionError?: unknown } | null)?.InstructionError;
    let index: number | null = null;
    let code: number | null = null;
    if (Array.isArray(ie) && typeof ie[0] === "number") {
      index = ie[0];
      const inner = ie[1] as { Custom?: unknown } | null;
      if (inner && typeof inner === "object" && typeof inner.Custom === "number") code = inner.Custom;
    }
    this.code = code;
    this.instructionIndex = index;
    // The INNERMOST failing program owns the code (a CPI failure is logged by the callee
    // first): take the first "Program X failed" log line, else the failing instruction.
    let pid: string | null = null;
    for (const l of logs) {
      const m = /^Program (\w{32,44}) failed/.exec(l);
      if (m) { pid = m[1]; break; }
    }
    if (!pid && index !== null && instructions[index]) pid = instructions[index].programId.toBase58();
    this.programId = pid;
  }
}

export interface GateSimulation {
  consumed: number | null;
  err: unknown;
  logs: string[];
  /** The simulation RPC itself failed: no verdict (never a refusal). */
  rpcFailed: boolean;
  /** The exact list simulated (compute-budget prefix included), for refusal attribution. */
  simulated: TransactionInstruction[];
}

/**
 * Simulate `instructions` under the full heap frame and the maximum CU limit (sigVerify off,
 * blockhash replaced). One RPC gives both the CU sizing and the pre-sign verdict (SH-1).
 */
export async function simulateForGate(
  connection: Connection,
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<GateSimulation> {
  const simulated = [
    ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_TX_COMPUTE_UNITS }),
    ...instructions,
  ];
  try {
    const tx = new Transaction();
    for (const ix of simulated) tx.add(ix);
    tx.feePayer = feePayer;
    tx.recentBlockhash = "11111111111111111111111111111111"; // placeholder; replaceRecentBlockhash
    const sim = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
      replaceRecentBlockhash: true,
      sigVerify: false,
      commitment: "confirmed",
    });
    const u = sim.value.unitsConsumed;
    return {
      consumed: !sim.value.err && typeof u === "number" && u > 0 ? u : null,
      err: sim.value.err ?? null,
      logs: sim.value.logs ?? [],
      rpcFailed: false,
      simulated,
    };
  } catch {
    return { consumed: null, err: null, logs: [], rpcFailed: true, simulated };
  }
}

/**
 * Units consumed by `instructions` under the full heap frame and the maximum CU limit
 * (sigVerify off, blockhash replaced). null when the simulation errors or the RPC fails:
 * the caller then uses its cap, and sendTx's own simulation surfaces the real error.
 */
export async function simulateConsumedUnits(
  connection: Connection,
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<number | null> {
  return (await simulateForGate(connection, feePayer, instructions)).consumed;
}

/**
 * Simulate `tx` (unsigned or partially signed) and throw a SimulationRefusal ("Transaction
 * simulation failed: …", carrying the program error and the failing log lines) if it would
 * revert. RPC errors during the simulation itself are logged and do NOT throw — the
 * broadcast's own preflight still guards the send.
 */
export async function presimulateOrThrow(
  connection: Connection,
  tx: Transaction,
): Promise<void> {
  try {
    const simTx = new VersionedTransaction(tx.compileMessage());
    const simResult = await connection.simulateTransaction(simTx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
      commitment: "confirmed",
    });
    if (simResult.value.err) {
      throw new SimulationRefusal(simResult.value.err, simResult.value.logs ?? [], tx.instructions);
    }
  } catch (simError) {
    if (simError instanceof SimulationRefusal) throw simError;
    console.warn("[presimulateOrThrow] simulation RPC failed (non-blocking):", simError);
  }
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

function pushTxErrorString(out: string[], value: unknown) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed) out.push(trimmed);
}

/** Only log lines carrying a failure signal belong in a thrown message —
 *  success/invoke noise ("Program X invoke [1]", "Program X success",
 *  "Program log: Instruction: Trade") drowns the failing line AND creates
 *  false positives in downstream substring classifiers (e.g. a PASSING
 *  Lighthouse assertion's invoke line must not trigger the wallet-security
 *  message, and a successful Tokenkeg CPI line must not route an unrelated
 *  engine error to "insufficient token balance"). */
const TX_ERROR_LOG_LINE_RE =
  /error|failed|failure|panicked|insufficient|exceeded|denied|custom program error/i;
/** Hard cap on log lines admitted into a thrown message. */
const TX_ERROR_LOG_LINE_CAP = 12;

/** Keep only failure-relevant log lines (order preserved, capped). */
function filterTxErrorLogLines(lines: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = (typeof raw === "string" ? raw : String(raw)).trim();
    if (!line || !TX_ERROR_LOG_LINE_RE.test(line)) continue;
    out.push(line);
    if (out.length >= TX_ERROR_LOG_LINE_CAP) break;
  }
  return out;
}

function pushTxErrorLogs(out: string[], value: unknown) {
  if (!Array.isArray(value)) return;
  for (const line of filterTxErrorLogLines(value)) {
    out.push(line);
  }
}

export function extractTxErrorMessage(error: unknown): string {
  const out: string[] = [];
  const seen = new Set<object>();

  const visit = (value: unknown, depth = 0) => {
    if (value == null || depth > 4) return;

    if (typeof value === "string") {
      pushTxErrorString(out, value);
      return;
    }

    if (typeof value !== "object") {
      pushTxErrorString(out, String(value));
      return;
    }

    if (seen.has(value)) return;
    seen.add(value);

    if (value instanceof Error) {
      pushTxErrorString(out, value.message);
    }

    const record = value as Record<string, unknown>;
    pushTxErrorString(out, record.message);
    pushTxErrorString(out, record.transactionMessage);
    pushTxErrorLogs(out, record.logs);
    pushTxErrorLogs(out, record.transactionLogs);

    visit(record.cause, depth + 1);
    visit(record.error, depth + 1);
    visit(record.err, depth + 1);
  };

  visit(error);

  const unique = Array.from(new Set(out));
  return unique.length > 0 ? unique.join("\n") : "Unexpected error";
}

/**
 * True only when the extracted message carries an actual Lighthouse FAILURE
 * signal:
 *  - a line with exactly error code 0x1900 (Anchor ConstraintAddress — the
 *    code Lighthouse assertions fail with), or
 *  - a line naming Lighthouse alongside a failure word, or
 *  - a line where the Lighthouse program id itself appears with a failure word.
 *
 * Mere PRESENCE of the Lighthouse program id anywhere in the message is not
 * enough: nested transaction logs legitimately contain "Program L2TExM…
 * invoke"/"success" lines for PASSING assertions, and attributing an unrelated
 * program failure to "wallet security" would hide the real error.
 */
function isLighthouseFailureMessage(msg: string): boolean {
  for (const rawLine of msg.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // \b keeps 0x1900 from matching longer codes (e.g. 0x19001).
    if (/custom program error:\s*0x1900\b/i.test(line)) return true;
    if (/Lighthouse/i.test(line) && /error|failed|failure|blocked|denied/i.test(line)) return true;
    if (line.includes(LIGHTHOUSE_PROGRAM_ID) && /error|failed|failure/i.test(line)) return true;
  }
  return false;
}

/**
 * Final thrown message for a failed sendRawTransaction: the filtered extract
 * of everything already on the error object, plus — for SendTransactionError,
 * whose logs sometimes only materialize via getLogs() — any failure-relevant
 * log lines the extract didn't already surface. Line-wise deduped so the
 * message carries ONE copy of each failing log line (previously the same
 * failing lines could appear up to three times: embedded in web3.js's own
 * message, again via the error's log array, and a third time via a manual
 * "relevant logs" append).
 */
async function buildSendErrorMessage(connection: Connection, sendErr: unknown): Promise<string> {
  const sendMsg = extractTxErrorMessage(sendErr);
  if (!(sendErr instanceof SendTransactionError)) return sendMsg;
  try {
    const logs = await sendErr.getLogs(connection);
    if (logs && logs.length > 0) {
      const seen = new Set(sendMsg.split("\n").map((l) => l.trim()));
      const fresh = filterTxErrorLogLines(logs).filter((l) => !seen.has(l));
      if (fresh.length > 0) return `${sendMsg}\n${fresh.join("\n")}`;
    }
  } catch {
    // Best-effort log fetch — the extract alone is already informative.
  }
  return sendMsg;
}

/**
 * Get dynamic priority fee based on recent network conditions.
 * Cached for PRIORITY_FEE_CACHE_MS; falls back to hardcoded value if the RPC
 * call fails.
 */
export async function getPriorityFee(connection: Connection): Promise<number> {
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
    // Cap at 10x fallback to prevent massive spikes
    if (dynamicFee > 0) {
      return Math.min(dynamicFee, PRIORITY_FEE_FALLBACK * 10);
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

export async function getFreshBlockhash(connection: Connection, forceFresh = false): Promise<string> {
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
export async function pollConfirmation(
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
    total += Number(readU64LE(ix.data, 4));
  }
  return total;
}

/**
 * GH#2623: thrown by `sendTx` (and the create-market batch pipeline in
 * useCreateMarket.ts) instead of prompting a fresh wallet signature once the
 * caller's `abortSignal` has fired. Distinct from a plain `Error` so a caller
 * can choose not to surface it as a failure (the operation was abandoned, not
 * rejected) — see `isTxCancelledError`.
 */
export class TxCancelledError extends Error {
  constructor(message = "Transaction cancelled — the page was left before this step started.") {
    super(message);
    this.name = "TxCancelledError";
  }
}

export function isTxCancelledError(err: unknown): boolean {
  return err instanceof TxCancelledError;
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
  simulateBeforeSign = false,
  selfHeal,
  onSelfHeal,
  vaultLpRepair,
  onVaultLpRepair,
  onSeniorDrawRepair,
  computeUnitsFromSim,
  onComputeUnits,
}: SendTxParams): Promise<string> {
  if (!wallet.publicKey || (!wallet.signTransaction && !wallet.signAndSendTransaction)) {
    throw new Error("Wallet not connected");
  }
  // GH#2623: a caller (the create-market wizard, on unmount) may cancel a
  // multi-step chain BETWEEN steps. Without this, `create()`'s sequential
  // per-step flow kept calling sendTx for the NEXT step after the component
  // had already unmounted — a wallet popup for a market the user had already
  // navigated away from. Checked before any tx is built or signed; a step
  // already broadcast when the signal fires is left to confirm normally (see
  // the retry-loop check below and pollConfirmation's own abort check — both
  // stop FUTURE signatures, never an already-submitted one).
  if (abortSignal?.aborted) {
    throw new TxCancelledError();
  }
  // Maintenance with writes blocked: refuse before any tx is built or signed.
  if (getMaintenanceConfig().blockWrites) {
    throw new MaintenanceError();
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

  // P0b self-heal. Planned from the ORIGINAL instructions on EVERY attempt:
  // a repair that someone else (the keeper) landed meanwhile makes its engine
  // gate false, and resending that stale repair would revert the whole tx on
  // each retry (security review 2026-09-29, LOW). Attempt 0's plan starts
  // before the first blockhash fetch so the market read overlaps it.
  const feePayer = wallet.publicKey;
  const selfHealOn = !!selfHeal && isSelfHealEnabled() && !skipPreflight;
  const planHeal = (): Promise<SelfHealResult | null> =>
    selfHeal && selfHealOn
      ? planSelfHeal(
          {
            programId: selfHeal.programId,
            market: selfHeal.market,
            instructions,
            computeUnits,
            catchUp: selfHeal.catchUp ? { cranker: feePayer, portfolio: selfHeal.catchUp.portfolio, oracleTail: selfHeal.catchUp.oracleTail } : undefined,
          },
          connectionSelfHealDeps(connection, selfHeal.market, feePayer),
        )
      : Promise.resolve(null);
  let selfHealPromise: Promise<SelfHealResult | null> = planHeal();
  let healedInstructions = instructions;
  let healedComputeUnits = computeUnits;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Latency: kick the blockhash fetch off FIRST so it overlaps the fee
      // lookup below (both usually resolve instantly from their caches after
      // a prewarmTxLanding call; retries force a fresh blockhash since a
      // stale one is a plausible cause of the failure being retried).
      const blockhashPromise = getFreshBlockhash(connection, attempt > 0);
      if (selfHealOn) {
        if (attempt > 0) selfHealPromise = planHeal();
        const heal = await selfHealPromise;
        healedInstructions = instructions;
        healedComputeUnits = computeUnits;
        if (heal) {
          onSelfHeal?.(heal);
          if (heal.outcome === "repaired") {
            healedInstructions = heal.instructions;
            healedComputeUnits = heal.computeUnits;
            console.info(`[self-heal] prepended ${heal.repairs.map(describeRepair).join(", ")}`);
          }
        }
      }
      if (vaultLpRepair && !skipPreflight && isVaultLpSelfHealEnabled()) {
        // Planned from the (P0b-healed) list on EVERY attempt, like P0b: a crank someone
        // else landed meanwhile makes the valuation current and the repair is dropped.
        if (!selfHealOn) {
          healedInstructions = instructions;
          healedComputeUnits = computeUnits;
        }
        const r = await planVaultLpRepair(
          {
            programId: vaultLpRepair.programId,
            market: vaultLpRepair.market,
            cranker: feePayer,
            instructions: healedInstructions,
            computeUnits: healedComputeUnits,
            oracleTail: vaultLpRepair.oracleTail,
          },
          connectionVaultLpRepairDeps(connection, vaultLpRepair.market, feePayer),
        );
        onVaultLpRepair?.(r);
        if (r.outcome === "repaired") {
          healedInstructions = r.instructions;
          healedComputeUnits = r.computeUnits;
          console.info("[vault-lp-repair] prepended the vault-LP refresh crank");
        }
        // d119eebd senior draw: 87 -> crank the vault LP; 88 -> recall (98) before the 77.
        const d = await planSeniorDrawRepair(
          {
            programId: vaultLpRepair.programId,
            market: vaultLpRepair.market,
            cranker: feePayer,
            instructions: healedInstructions,
            computeUnits: healedComputeUnits,
            oracleTail: vaultLpRepair.oracleTail,
          },
          connectionSeniorDrawRepairDeps(connection, feePayer),
        );
        onSeniorDrawRepair?.(d);
        if (d.outcome === "cranked" || d.outcome === "recalled" || d.outcome === "other-pot") {
          healedInstructions = d.instructions;
          healedComputeUnits = d.computeUnits;
          console.info(`[senior-draw-repair] ${d.outcome}${d.recallAtoms !== undefined ? ` ${d.recallAtoms}` : ""}`);
        }
      }

      // SH-1: the CU-sizing simulation IS the pre-sign verdict when it runs — a refusal
      // here never opens the wallet, and a green one is not simulated a second time.
      let gateGreen = false;
      if (computeUnitsFromSim) {
        const g = await simulateForGate(connection, feePayer, healedInstructions);
        if (g.err && !skipPreflight) throw new SimulationRefusal(g.err, g.logs, g.simulated);
        gateGreen = !g.err && !g.rpcFailed;
        healedComputeUnits = sizeComputeUnitLimit(g.consumed, computeUnitsFromSim);
        onComputeUnits?.({ limit: healedComputeUnits, consumed: g.consumed });
      }

      // Get dynamic priority fee on first attempt (cached 45s)
      const priorityFee = attempt === 0 ? await getPriorityFee(connection) : PRIORITY_FEE_FALLBACK;

      // Pre-flight fee estimation and balance check (first attempt only).
      // Started here, awaited just before signing — it runs CONCURRENTLY with
      // the blockhash fetch + tx build instead of adding its own serial RPC
      // round-trip to the popup latency.
      let balanceCheckPromise: Promise<void> | null = null;
      if (attempt === 0) {
        const numSignatures = 1 + signers.length; // wallet + additional signers
        const fees = estimateFees(healedComputeUnits, priorityFee, numSignatures);
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
      const cleanInstructions = healedInstructions.filter(
        (ix) => ix.programId.toBase58() !== LIGHTHOUSE_PROGRAM_ID
      );

      const tx = new Transaction();
      // v17 wrapper installs a custom 128KB heap allocator and aborts ("Access
      // violation in heap section") on its first heap allocation unless the tx
      // requests the full heap frame. Must be the FIRST instruction. (issue #176)
      tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: healedComputeUnits }));
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
      //
      // The atomic path is MAINNET-ONLY. With signAndSendTransaction the wallet
      // picks the cluster it SUBMITS to, and Solflare resolves that to mainnet
      // even when we pass chain "solana:devnet" — its popup blocks with "Network
      // mismatch … this transaction is for mainnet", and only on the steps that
      // reach this branch (single-signer: Initialize LP, Deposit & finalize),
      // never on the multi-signer steps that sign-then-we-submit below. On devnet
      // we therefore always sign, then submit through our own RPC — the path every
      // multi-signer step already takes on devnet. PERC-8388's reason for the
      // atomic path (no post-sign window for Lighthouse/Blowfish to inject
      // assertion instructions) is a mainnet wallet-guard concern.
      const usesAtomicSend =
        !!wallet.signAndSendTransaction && signers.length === 0 && getNetwork() !== "devnet";
      const runSimulation = (): Promise<void> => presimulateOrThrow(connection, tx);
      // UX WP-1 (SH-1): simulate BEFORE the wallet opens, on every network and also with
      // keypair signers (sigVerify:false, so missing signatures don't matter). A refusal
      // throws SimulationRefusal and the wallet is never prompted. The only skips: the
      // Lighthouse fallback (skipPreflight) and a green CU-sizing simulation of this exact
      // list above. `simulateBeforeSign` is kept for callers; it is now the default.
      void simulateBeforeSign;
      const wantSimulation = !skipPreflight && !gateGreen;
      if (wantSimulation) {
        await runSimulation();
      }
      // ================================================================
      // PERC-8388: Use signAndSendTransaction when available.
      // This is the definitive fix for Lighthouse/Blowfish injection.
      // The wallet signs and broadcasts atomically — there is no post-sign
      // window for middleware to inject assertion instructions.
      // ================================================================
      if (usesAtomicSend && wallet.signAndSendTransaction) {
        // Only use atomic sign+send when there are no extra signers.
        // signAndSendTransaction may drop partial signatures from keypair signers.
        try {
          const sigBytes = await wallet.signAndSendTransaction(tx);
          // Privy returns raw signature bytes (64 bytes). Convert to base58.
          lastSignature = bs58.encode(sigBytes);
        } catch (sendErr) {
          const sendMsg = extractTxErrorMessage(sendErr);
          // Lighthouse-specific failure → user-friendly message. Gated on an
          // actual failure signal, not mere program-id presence: nested logs
          // can contain PASSING Lighthouse assertion lines while the real
          // failure lives elsewhere.
          if (isLighthouseFailureMessage(sendMsg)) {
            throw new Error(
              "Transaction blocked by wallet security (Blowfish/Lighthouse). " +
              "Your wallet's transaction guard flagged this as unknown. " +
              "Try disabling transaction simulation in your wallet settings, " +
              "or use a different wallet. This is a known issue for new DeFi programs.",
              { cause: sendErr }
            );
          }
          // Throw the EXTRACTED message: wallets (notably Privy) wrap program
          // failures in a generic "Unexpected error" whose real detail lives
          // in nested cause/logs — rethrowing sendErr verbatim discarded it.
          // The original error rides along as `cause` for debugging.
          throw new Error(sendMsg, { cause: sendErr });
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

        try {
          lastSignature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: skipPreflight ?? false,
            maxRetries: 5,
          });
        } catch (sendErr) {
          const sendMsg = extractTxErrorMessage(sendErr);
          const isBatchError =
            sendMsg.includes("Missing response from batch") ||
            sendMsg.includes("failed to get recent blockhash") ||
            sendMsg.includes("RPC response error");

          if (isBatchError) {
            console.warn(
              `[sendTx] Batch RPC error (attempt ${attempt + 1}); will retry.`
            );
            throw sendErr;
          }
          // One source of log lines: the filtered extract (+ getLogs() lines
          // it couldn't see), deduped — see buildSendErrorMessage. Original
          // error preserved as `cause`.
          throw new Error(await buildSendErrorMessage(connection, sendErr), { cause: sendErr });
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

      // Use the shared predicate so every blockhash-miss spelling is retried —
      // notably the RPC's own "BlockhashNotFound" (no spaces), which the old
      // inline `includes("Blockhash not found")` check missed, so a preflight/
      // send blockhash lag on the load-balanced RPC was thrown straight to the
      // user instead of retried with a fresh blockhash.
      const isBlockhashExpired = isBlockhashExpiredError(lastError);

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

        // GH#2623: re-checked here (not just at entry) because the signal can
        // fire WHILE this attempt was in flight — e.g. the component unmounted
        // during the R2-S7 status check above. Without this, a blockhash-expiry
        // retry would rebuild and re-sign (a fresh wallet popup) for a step the
        // caller has already abandoned.
        if (abortSignal?.aborted) {
          throw new TxCancelledError();
        }

        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("Transaction failed after retries");
}

/**
 * True if `err` indicates the transaction's blockhash/blockheight expired
 * (it never landed within its ~150-slot, ~60-90s validity window) rather
 * than some other send/simulation failure. Used by the market-launch batch
 * pipeline (`hooks/useCreateMarket.ts`'s `attemptFreshBatchedLaunch`) to
 * decide whether a broadcast failure is worth recovering from — refreshing
 * the blockhash and re-signing just the not-yet-landed remainder of the
 * batch — versus a generic error that should simply propagate.
 *
 * Matches:
 *  - web3.js's `TransactionExpiredBlockheightExceededError` class.
 *  - The message variants this file's own retry logic already recognizes
 *    above (`isBlockhashExpired` in `sendTx`): "Blockhash not found", "block
 *    height exceeded".
 *  - The raw JSON-RPC "BlockhashNotFound" transaction-error string some
 *    `sendRawTransaction` failures surface verbatim.
 *
 * Deliberately does NOT match generic send failures (program errors,
 * insufficient funds, network hiccups, "Missing response from batch", etc.)
 * — only genuine expiry should trigger an extra re-approval popup.
 */
export function isBlockhashExpiredError(err: unknown): boolean {
  if (err instanceof TransactionExpiredBlockheightExceededError) return true;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes("blockhash not found") ||
    lower.includes("block height exceeded") ||
    lower.includes("blockhashnotfound") ||
    // Consistency with `sendTx`'s own retry predicate above, which also treats
    // "has expired" as an expiry signal.
    lower.includes("has expired")
  );
}

/**
 * True if `err` is `pollConfirmation`'s "Confirmation timeout" — the tx WAS
 * submitted (it has a signature) but didn't confirm within MAX_POLL_TIME_MS
 * (~= the blockhash validity window). Distinct from `isBlockhashExpiredError`:
 * an expiry error means the send was REJECTED (never accepted, no signature),
 * whereas a timeout means the tx may have landed and MUST be status-checked
 * (via `checkSignatureLanded`) before any rebuild — re-broadcasting a rebuilt
 * tx whose original actually landed would re-run a createAccount that already
 * succeeded and hard-fail the operation.
 */
export function isConfirmationTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return msg.toLowerCase().includes("confirmation timeout");
}

/**
 * GH#2804: the signature of a submitted tx whose confirmation timed out, or null. `broadcastSignedTx`
 * attaches it as `err.signature`; `sendTx` does not, but `pollConfirmation`'s message ends with
 * "Check explorer: <sig>". Null for any other error (nothing was submitted, or no signature known).
 */
export function timedOutSignature(err: unknown): string | null {
  if (!isConfirmationTimeoutError(err)) return null;
  const attached = (err as { signature?: unknown } | null)?.signature;
  if (typeof attached === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(attached)) return attached;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = /check explorer:\s*([1-9A-HJ-NP-Za-km-z]{64,88})\b/i.exec(msg);
  return m ? m[1] : null;
}

/**
 * Definitive on-chain status of a submitted signature, for the "did it land
 * before I rebuild?" check (mirrors `sendTx`'s R2-S7 landing check). Uses
 * `searchTransactionHistory: true` so a confirmed-but-status-aged tx isn't
 * mis-reported as missing.
 *  - "landed"    → confirmed/finalized with no error: treat as success, do NOT rebuild.
 *  - "not-found" → genuinely absent (dropped): safe to rebuild against a fresh blockhash.
 *  - "unknown"   → on-chain error, or an RPC failure that leaves it indeterminate:
 *                  caller must NOT rebuild (could double-execute) and should propagate.
 *
 * GH#2623: a "not-found" verdict authorizes the caller to rebuild + re-sign
 * (a fresh wallet popup), so a false negative here is not free — it re-prompts
 * the user for a step that already landed. On the load-balanced devnet RPC
 * (the same "BlockhashNotFound" propagation-lag gremlin as eb10959 / #2603 /
 * #2598 / #2400), a single query can land on a backend node that has not yet
 * indexed a signature confirmed moments earlier by a DIFFERENT node. One
 * short-delay retry before concluding "not-found" — cheap (one extra read)
 * and only taken on the rare path where the first query already missed.
 */
export async function checkSignatureLanded(
  connection: Connection,
  signature: string,
): Promise<"landed" | "not-found" | "unknown"> {
  const queryOnce = async (): Promise<"landed" | "not-found" | "unknown"> => {
    try {
      const resp = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const st = resp.value[0];
      if (st?.err) return "unknown"; // failed on-chain — a rebuild would just fail again
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "landed";
      if (!st) return "not-found";
      return "unknown"; // processed-but-not-yet-confirmed — indeterminate, don't rebuild
    } catch {
      return "unknown"; // RPC hiccup — indeterminate, fail safe
    }
  };
  const first = await queryOnce();
  if (first !== "not-found") return first;
  // Give a lagging RPC backend a moment to catch up, then ask once more.
  // Still "not-found" after this is treated as genuinely absent — unchanged
  // behaviour for the actually-dropped case this function exists to detect.
  await new Promise((r) => setTimeout(r, 800));
  return queryOnce();
}

// ============================================================================
// Batch signing (market-launch wizard fast path)
// ============================================================================
//
// The primitives below let a caller build several INDEPENDENT transactions
// (each with its own recentBlockhash — they don't need to match, and in
// practice the keeper-cosign tx below is built server-side against its own
// blockhash), get them all signed in ONE wallet approval via
// `signAllTransactions` (falling back to N sequential `signTransaction`
// popups — never worse than today), then broadcast+confirm each one with the
// exact same polling semantics `sendTx` already uses. See
// hooks/useCreateMarket.ts's `attemptFreshBatchedLaunch` for the orchestration
// that uses these to collapse the fresh quick-launch flow from 12 tx
// approvals down to one.

/**
 * Build a Transaction with the same heap-frame + compute-budget instructions
 * `sendTx` prepends, plus the caller's instructions, blockhash, and fee payer.
 * Does NOT sign or send — the caller (the batch pipeline) owns both, since
 * signing happens once for the whole batch and keypair partial-signing must
 * happen AFTER the wallet signs (Privy embedded wallets can strip unknown
 * signatures added before their signing flow runs — mirrors the ordering
 * `sendTx` already uses for `signers`, see above).
 */
export function buildBatchTx(params: {
  instructions: TransactionInstruction[];
  computeUnits: number;
  priorityFeeMicroLamports: number;
  blockhash: string;
  feePayer: PublicKey;
}): Transaction {
  const { instructions, computeUnits, priorityFeeMicroLamports, blockhash, feePayer } = params;
  // PERC-8388: same defensive Lighthouse-injection filter sendTx applies.
  const cleanInstructions = instructions.filter(
    (ix) => ix.programId.toBase58() !== LIGHTHOUSE_PROGRAM_ID
  );
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
  for (const ix of cleanInstructions) {
    tx.add(ix);
  }
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
  return tx;
}

/**
 * Sign N independent transactions with ONE wallet approval when the wallet
 * exposes `signAllTransactions` (wallet-adapter's native method, or Privy's
 * variadic `useSignTransaction().signTransaction` bridged the same way in
 * PrivyProviderClient.tsx). Falls back to N sequential `signTransaction`
 * popups when unavailable — identical total approval count to the
 * pre-batching flow, so this is never a regression.
 */
export async function signAllCompat(
  wallet: {
    signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
    signTransaction?: (tx: Transaction) => Promise<Transaction>;
  },
  txs: Transaction[],
): Promise<Transaction[]> {
  if (wallet.signAllTransactions) {
    console.info(`[signAllCompat] batch-signing ${txs.length} txs in ONE approval`);
    return wallet.signAllTransactions(txs);
  }
  if (!wallet.signTransaction) {
    throw new Error("Wallet does not support signAllTransactions or signTransaction");
  }
  // Diagnosis breadcrumb: when users report "I still signed N times", this
  // line distinguishes "wallet path exposes no batch signing" (this branch,
  // one prompt per merged tx) from "old bundle / sequential resume flow"
  // (this function never runs at all there).
  console.warn(`[signAllCompat] wallet exposes no signAllTransactions — falling back to ${txs.length} sequential prompts`);
  const signed: Transaction[] = [];
  for (const tx of txs) {
    signed.push(await wallet.signTransaction(tx));
  }
  return signed;
}

/**
 * Broadcast an already fully-signed transaction and poll for confirmation —
 * the exact post-sign path `sendTx` uses for its `signTransaction` fallback
 * branch (raw send + `pollConfirmation`), extracted so the batch pipeline can
 * reuse identical confirmation semantics per-tx instead of re-implementing
 * polling. Does not retry on blockhash expiry — the batch pipeline's own
 * failure handling decides whether to rebuild + re-prompt (never re-broadcasts
 * a stale pre-signed tx, per the batch-launch expiry contract).
 */
export async function broadcastSignedTx(
  connection: Connection,
  signedTx: Transaction,
  opts: { skipPreflight?: boolean; onProgress?: (elapsedMs: number) => void; abortSignal?: AbortSignal } = {},
): Promise<string> {
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: opts.skipPreflight ?? false,
      maxRetries: 5,
    });
  } catch (sendErr) {
    // Same semantics as sendTx's legacy send path: filtered extracted message
    // (single deduped source of log lines), original error kept as `cause`.
    throw new Error(await buildSendErrorMessage(connection, sendErr), { cause: sendErr });
  }
  try {
    await pollConfirmation(connection, signature, opts.onProgress, opts.abortSignal);
  } catch (confirmErr) {
    // The tx WAS submitted (we have its signature) but confirmation failed —
    // attach the signature so a caller (the batch pipeline) can status-check it
    // before deciding to rebuild, instead of blindly re-broadcasting. Only the
    // send path above (a rejected tx) has no signature to attach.
    if (confirmErr && typeof confirmErr === "object") {
      try {
        (confirmErr as { signature?: string }).signature = signature;
      } catch {
        // Frozen/exotic error object — leave it; caller falls back to no-sig handling.
      }
    }
    throw confirmErr;
  }
  return signature;
}

/** UX WP-2 (principle 3): re-simulation backoff while waiting for the market, before any prompt. */
export const WAIT_DELAYS_MS = [1_500, 3_000, 5_000, 8_000, 12_000];

/**
 * Wrapper codes the keeper normally clears quickly (no duration is promised) (engine / oracle catching up) and the P2
 * matcher's stale-mark codes. Only a SimulationRefusal (the wallet was never opened) is waited on.
 */
const WAITABLE_WRAPPER = new Set<number>([WRAPPER_ERR.EngineStale, WRAPPER_ERR.EngineBStale, WRAPPER_ERR.EngineLockActive, WRAPPER_ERR.OracleStale, WRAPPER_ERR.OracleInvalid]);
const WAITABLE_MATCHER = new Set<number>([8002, 8003]);

export function isWaitableRefusal(e: unknown): e is SimulationRefusal {
  if (!(e instanceof SimulationRefusal) || e.code === null) return false;
  const ids = resolveDevnetProgramIds();
  if (e.programId === ids.wrapper) return WAITABLE_WRAPPER.has(e.code);
  if (e.programId === ids.matcher) return WAITABLE_MATCHER.has(e.code);
  return false;
}

/**
 * sendTx, but a refusal the market clears on its own (engine/oracle catching up) is
 * re-simulated on WAIT_DELAYS_MS instead of surfacing — the wallet opens as soon as the
 * simulation is green (self-heal / catch-up cranks re-planned each round). `onWaiting(true)`
 * while waiting ("Waiting for the latest price…"), `onWaiting(false)` when done either way.
 */
export async function sendTxWaiting(
  params: SendTxParams & {
    onWaiting?: (waiting: boolean) => void;
    waitDelaysMs?: readonly number[];
    /**
     * UX WP-3 (§3.3): keep re-simulating on the last delay after the schedule ends (the
     * ticket says "We'll keep trying" and offers Stop = `abortSignal`), instead of throwing.
     */
    keepWaiting?: boolean;
    /** Called once when the wait passes `longWaitMs` (default 30 s). */
    onWaitingLong?: () => void;
    longWaitMs?: number;
  },
): Promise<string> {
  const { onWaiting, waitDelaysMs = WAIT_DELAYS_MS, keepWaiting = false, onWaitingLong, longWaitMs = 30_000, ...rest } = params;
  let waited = 0;
  let saidLong = false;
  for (let i = 0; ; i++) {
    try {
      const sig = await sendTx(rest);
      if (i > 0) onWaiting?.(false);
      return sig;
    } catch (e) {
      const exhausted = i >= waitDelaysMs.length && !(keepWaiting && waitDelaysMs.length > 0);
      if (!isWaitableRefusal(e) || exhausted || rest.abortSignal?.aborted) {
        if (i > 0) onWaiting?.(false);
        if (rest.abortSignal?.aborted && isWaitableRefusal(e)) throw new WaitStoppedError();
        throw e;
      }
      onWaiting?.(true);
      const delay = waitDelaysMs[Math.min(i, waitDelaysMs.length - 1)];
      const stopped = await abortableSleep(delay, rest.abortSignal);
      waited += delay;
      if (!saidLong && waited >= longWaitMs) {
        saidLong = true;
        onWaitingLong?.();
      }
      if (stopped) {
        onWaiting?.(false);
        throw new WaitStoppedError();
      }
    }
  }
}

/** The user pressed Stop while the app was waiting for the market: nothing was sent. */
export class WaitStoppedError extends Error {
  constructor() {
    super("Stopped waiting for the market; nothing was sent.");
    this.name = "WaitStoppedError";
  }
}

/** Resolves true when `signal` aborted during the sleep. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
