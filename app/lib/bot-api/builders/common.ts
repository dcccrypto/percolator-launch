/**
 * Shared pieces of the bot-API builders: strict body parsing, mapping builder refusals to API errors, and the final
 * simulation of the EXACT message each returned transaction carries (real blockhash, sigVerify off). The builders'
 * own simulations size compute and pick repairs on a sibling message (lib/tx.ts simulateForGate: 1.4M CU, replaced
 * blockhash); this one proves the bytes the caller signs. Nothing is signed or sent here.
 */
import { createHash } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, Transaction, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { ApiError, apiCodeForOnchain, type ErrorCode } from "@/lib/bot-api/errors";
import { attributeFailure } from "@/lib/bot-api/onchain";
import { TradeBuildRefusal } from "@/lib/v22/trade-build";

export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_I128_ABS = (1n << 127n) - 1n;

// ── strict parsing ─────────────────────────────────────────────────────────────

export function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new ApiError("bad_request", `unknown field(s): ${extra.slice(0, 5).join(", ")}`);
}

export function pubkeyField(body: Record<string, unknown>, name: string, required: true): PublicKey;
export function pubkeyField(body: Record<string, unknown>, name: string, required: false): PublicKey | undefined;
export function pubkeyField(body: Record<string, unknown>, name: string, required: boolean): PublicKey | undefined {
  const v = body[name];
  if (v === undefined && !required) return undefined;
  if (typeof v === "string" && v.length >= 32 && v.length <= 44) {
    try {
      const pk = new PublicKey(v);
      if (pk.toBase58() === v) return pk;
    } catch {
      /* fall through */
    }
  }
  throw new ApiError("bad_request", `${name} must be a base58 public key`);
}

/** Unsigned integer given as a decimal STRING (amounts can exceed 2^53; a JSON number has already lost precision). */
export function uintStringField(body: Record<string, unknown>, name: string, opts: { required: boolean; max: bigint; positive?: boolean }): bigint | undefined {
  const v = body[name];
  if (v === undefined && !opts.required) return undefined;
  if (typeof v !== "string" || !/^\d{1,40}$/.test(v)) throw new ApiError("bad_request", `${name} must be a non-negative integer as a decimal string`);
  const n = BigInt(v);
  if (n > opts.max) throw new ApiError("bad_request", `${name} is out of range`);
  if (opts.positive && n === 0n) throw new ApiError("bad_request", `${name} must be > 0`);
  return n;
}

export function intField(body: Record<string, unknown>, name: string, opts: { min: number; max: number; overCode?: ErrorCode }): number | undefined {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < opts.min) throw new ApiError("bad_request", `${name} must be an integer >= ${opts.min}`);
  if (v > opts.max) throw new ApiError(opts.overCode ?? "bad_request", `${name} must be <= ${opts.max}`);
  return v;
}

export function numberField(body: Record<string, unknown>, name: string, opts: { minExclusive: number; max: number }): number | undefined {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= opts.minExclusive || v > opts.max) {
    throw new ApiError("bad_request", `${name} must be a number in (${opts.minExclusive}, ${opts.max}]`);
  }
  return v;
}

export function boolField(body: Record<string, unknown>, name: string): boolean | undefined {
  const v = body[name];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ApiError("bad_request", `${name} must be true or false`);
  return v;
}

// ── refusals ───────────────────────────────────────────────────────────────────

const REFUSAL_TO_API: Record<string, ErrorCode> = {
  maintenance: "maintenance",
  bad_size: "bad_request",
  bad_limit: "bad_request",
  market_not_found: "market_not_found",
  unknown_program: "market_not_found",
  not_v22: "market_unsupported",
  multi_asset_unsupported: "market_unsupported",
  lots_unsupported: "market_unsupported",
  market_unreadable: "market_unreadable",
  price_unreadable: "market_unreadable",
  no_lp: "no_lp",
  rpc: "rpc_unavailable",
  no_portfolio: "no_portfolio",
  bad_portfolio: "bad_portfolio",
  fee_unreadable: "fee_unreadable",
  fee_above_max: "fee_above_max",
  fee_raise_required: "fee_raise_required",
  too_large: "too_large",
};

/**
 * no_portfolio: the wallet has no trading account on this market. The API can create one: POST /v1/deposits with `newPortfolio`
 * (a fresh keypair's public key, which co-signs the returned transaction).
 */
export function noTradingAccount(): ApiError {
  return new ApiError(
    "no_portfolio",
    "this wallet has no trading account on this market. Create one with POST /api/v1/deposits {owner, market, amount, newPortfolio: <public key of a fresh keypair>} and co-sign the returned transaction with that keypair, then retry",
    { details: { next: "POST /api/v1/deposits", needs: "newPortfolio" } },
  );
}

/** Builder refusal -> API error. A failed simulation keeps its decoded on-chain code and the last log lines. */
export function refusalToApi(e: TradeBuildRefusal): ApiError {
  if (e.code === "simulation_failed") return simulationError(e.message, e.logs);
  // The shared builder's texts point at the app ("deposit in the app first") and say "portfolio"; the API says "trading
  // account" and names its own way to create one. /api/v22/trade keeps its text.
  if (e.code === "no_portfolio") return noTradingAccount();
  if (e.code === "bad_portfolio") return new ApiError("bad_portfolio", "the named portfolio is not this wallet's trading account on this market");
  if (e.code === "rpc") return new ApiError("rpc_unavailable");
  return new ApiError(REFUSAL_TO_API[e.code] ?? "internal", e.message, e.logs.length > 0 ? { logs: e.logs } : {});
}

/**
 * A failed simulation as an API error. `err` is the InstructionError (or text carrying it); `programAt` resolves the failing
 * instruction's program when the caller has the list. Only a code the WRAPPER returned is named and mapped to an API code
 * (lib/bot-api/onchain.ts); any other program's code is `simulation_failed` with the program and the number, unnamed.
 */
export function simulationError(err: unknown, logs: readonly string[], programAt?: (i: number) => string | null | undefined): ApiError {
  const tail = logs.slice(-12);
  const a = attributeFailure(err, logs, programAt);
  if (!a) return new ApiError("simulation_failed", undefined, { logs: tail });
  const { onchain, wrapper } = a;
  if (wrapper) return new ApiError(apiCodeForOnchain(onchain.code), `simulation failed: ${onchain.name ?? `Custom(${onchain.code})`}`, { onchain, logs: tail });
  const who = onchain.program ? (a.programLabel ? `${a.programLabel} (${onchain.program})` : `program ${onchain.program}`) : "a program that could not be identified";
  // The program's own last "Program log:" line is usually the reason (System: "Transfer: insufficient lamports X, need Y").
  const why = [...logs].reverse().map((l) => /^Program log: (.+)$/.exec(l)?.[1]).find((x) => x !== undefined);
  return new ApiError("simulation_failed", `simulation failed in ${who}: Custom(${onchain.code})${why ? `: ${why}` : ""}`, { onchain, logs: tail });
}

// ── transactions ───────────────────────────────────────────────────────────────

/** Same frame as lib/v22/trade-build.ts wrap(): heap frame FIRST (the wrapper aborts on its first heap allocation without it). */
export function wrapTx(ixs: TransactionInstruction[], cuLimit: number, priorityFee: number, feePayer: PublicKey, blockhash: string): Transaction {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
  for (const ix of ixs) tx.add(ix);
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  return tx;
}

export interface ReturnedTx {
  purpose: string;
  /** Unsigned legacy transaction, base64. */
  transaction: string;
  /** sha256 of the message bytes, hex: what the simulation below ran and what the signers sign. */
  messageHash: string;
  /** Every key that must sign, fee payer first. */
  signers: string[];
  computeUnitLimit: number;
  simulation: { unitsConsumed: number | null; logsTail: string[] };
}

/**
 * Simulates exactly `tx` (its blockhash, compute budget, priority fee and instructions; sigVerify off) and returns it
 * ready for the caller, or throws the refusal. An unknown blockhash or an RPC failure is retryable, never "clean".
 */
export async function finalizeTx(connection: Connection, tx: Transaction, purpose: string, meta?: { rpcCalls: number; sims: number }): Promise<ReturnedTx> {
  const message = tx.compileMessage();
  const messageBytes = message.serialize();
  let sim: Awaited<ReturnType<Connection["simulateTransaction"]>>;
  try {
    if (meta) {
      meta.rpcCalls++;
      meta.sims++;
    }
    sim = await connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" });
  } catch {
    throw new ApiError("rpc_unavailable", "simulation RPC failed, try again");
  }
  const err = sim.value.err;
  if (err) {
    if (JSON.stringify(err).includes("BlockhashNotFound")) throw new ApiError("rpc_unavailable", "the RPC does not know the blockhash yet, try again");
    throw simulationError(err, sim.value.logs ?? [], (i) => tx.instructions[i]?.programId.toBase58());
  }
  const signers = message.accountKeys.slice(0, message.header.numRequiredSignatures).map((k) => k.toBase58());
  return {
    purpose,
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    messageHash: createHash("sha256").update(messageBytes).digest("hex"),
    signers,
    computeUnitLimit: computeUnitLimitOf(tx),
    simulation: { unitsConsumed: typeof sim.value.unitsConsumed === "number" ? sim.value.unitsConsumed : null, logsTail: (sim.value.logs ?? []).slice(-6) },
  };
}

function computeUnitLimitOf(tx: Transaction): number {
  for (const ix of tx.instructions) {
    // SetComputeUnitLimit = discriminator 2, then u32 LE.
    if (ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2 && ix.data.length >= 5) return ix.data.readUInt32LE(1);
  }
  return 0;
}
