/**
 * Attributing a failed transaction's `Custom(n)` to the program that returned it.
 *
 * `{"InstructionError":[index, {"Custom": n}]}` carries a number and the index of the failing TOP-LEVEL instruction, nothing
 * about which program's error table the number belongs to. System, SPL Token and the matcher all return Custom codes of their
 * own, so naming `n` from the wrapper's table whatever program failed gives wrong names (System "insufficient lamports" read as
 * the wrapper's InvalidVersion) and can even map to a wrong API code. A code is named, and mapped to an API code, ONLY when the
 * program that returned it is a Percolator wrapper.
 *
 * The owner of the code is the INNERMOST failing program: a CPI failure is logged by the callee first ("Program X failed: ..."),
 * so the first such log line wins; else the program of the instruction at `index` when the caller has the instruction list.
 * Neither known: the code is reported unnamed (the safe reading).
 */
import { PublicKey } from "@solana/web3.js";
import { onchainErrorName, type OnchainError } from "@/lib/bot-api/errors";
import { wrapperPrograms } from "@/lib/bot-api/reads/common";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LABELS: Record<string, string> = { [SYSTEM]: "System program", [TOKEN]: "SPL Token program", [TOKEN_2022]: "Token-2022 program" };

export interface InstructionFailure {
  /** Index of the failing top-level instruction in the simulated / landed list. */
  index: number | null;
  /** The Custom(n) code; null when the error is not a Custom one. */
  custom: number | null;
}

/** `{InstructionError:[i, {Custom:n}]}` (or its JSON text, e.g. inside a refusal message). */
export function instructionFailureOf(errOrText: unknown): InstructionFailure {
  const text = typeof errOrText === "string" ? errOrText : JSON.stringify(errOrText ?? null);
  const m = /"InstructionError"\s*:\s*\[\s*(\d+)\s*,\s*\{\s*"Custom"\s*:\s*(\d+)\s*\}/.exec(text);
  if (m) return { index: Number(m[1]), custom: Number(m[2]) };
  const c = /"Custom"\s*:\s*(\d+)/.exec(text);
  const i = /"InstructionError"\s*:\s*\[\s*(\d+)/.exec(text);
  return { index: i ? Number(i[1]) : null, custom: c ? Number(c[1]) : null };
}

/** The program that returned the error: the first "Program X failed" log line, else the program of the instruction at `index`. */
export function failingProgramOf(logs: readonly string[], index: number | null, programAt?: (i: number) => string | null | undefined): string | null {
  for (const l of logs) {
    const m = /^Program (\w{32,44}) failed/.exec(l);
    if (m) return m[1];
  }
  if (index !== null && programAt) return programAt(index) ?? null;
  return null;
}

export function isWrapperProgram(programId: string | null): boolean {
  if (!programId) return false;
  return wrapperPrograms().some((p: PublicKey) => p.toBase58() === programId);
}

export interface OnchainAttribution {
  onchain: OnchainError;
  /** True when the code belongs to the wrapper's table (named, and mappable to an API code). */
  wrapper: boolean;
  programLabel: string | null;
}

/** null when the error is not a Custom(n). */
export function attributeFailure(errOrText: unknown, logs: readonly string[], programAt?: (i: number) => string | null | undefined): OnchainAttribution | null {
  const f = instructionFailureOf(errOrText);
  if (f.custom === null) return null;
  const program = failingProgramOf(logs, f.index, programAt);
  const wrapper = isWrapperProgram(program);
  return {
    wrapper,
    programLabel: program ? LABELS[program] ?? null : null,
    onchain: { code: f.custom, name: wrapper ? onchainErrorName(f.custom) : null, program, ...(f.index !== null ? { instructionIndex: f.index } : {}) },
  };
}
