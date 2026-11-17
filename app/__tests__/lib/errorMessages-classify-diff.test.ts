import { describe, it, expect } from "vitest";
import {
  isTransientError,
  isRateLimitText,
  detectWalletError,
  isOracleStaleError,
  isEngineStaleAtSend,
  isEngineLockError,
  extractErrorCode,
  humanizeError,
} from "@/lib/errorMessages";

const SIG = "5".repeat(20) + "429" + "Zx9".repeat(20);
const CORPUS: string[] = [
  "Transaction simulation failed: Blockhash not found",
  "block height exceeded",
  "Transaction 5Kx has expired",
  "429 Too Many Requests",
  '{"jsonrpc":"2.0","error":{"code":-32429,"message":"rate limit"}}',
  "Rate limit exceeded for this endpoint",
  "request rate-limited, 429 rate limit",
  "Transaction confirmation timeout " + SIG + " may still land",
  "failed to send transaction: custom program error: 0x1b",
  "custom program error: 0x14",
  "custom program error: 0x1900",
  '{"InstructionError":[0,{"Custom":6400}]}',
  '{"InstructionError":[2,{"Custom":27}]}',
  "Program log: Instruction: Trade Custom(21)",
  "User rejected the request.",
  "WalletSignTransactionError: User rejected the request 4001",
  "Ledger 0x6985 denied by the user",
  "The requested account has not been authorized by the user",
  "wallet is locked, please unlock",
  "Wallet not connected",
  "Transaction rejected by policy",
  "insufficient funds for fee",
  "Failed to fetch",
  "TypeError: NetworkError when attempting to fetch resource.",
  "Program EDKKgRaVHna6FCxiY1kgMzegD9rpaN1nwJNSzAzeBUBX failed: custom program error: 0x13",
  "Attempt to debit an account but found no record of a prior credit.",
  "Something unexpected " + "lorem ipsum dolor sit amet ".repeat(8),
  "Error Code: 0x15 " + SIG,
  "SendTransactionError: Simulation failed. Logs: [Program 11111111111111111111111111111111 invoke [1], Program log: Instruction: Deposit, Program consumed 12000 of 200000 compute units, Program failed: custom program error: 0x1a]",
  "",
];
// pad to >= 200 with deterministic variants
for (let i = 0; CORPUS.length < 240; i++) {
  const base = CORPUS[i % 30];
  CORPUS.push(base + (i % 3 === 0 ? ` [id=${i}]` : i % 3 === 1 ? ` (retry ${i})` : ""));
}

const FNS: Record<string, (m: string) => boolean | unknown> = {
  isTransientError,
  isRateLimitText,
  detectWalletError,
  isOracleStaleError,
  isEngineStaleAtSend,
  isEngineLockError,
  extractErrorCode,
  humanizeError: (m) => humanizeError(m),
};

describe.skipIf(!process.env.EM_BENCH)("errorMessages bench", () => {
  it("measures", () => {
    const out: Record<string, number> = {};
    let sink = 0;
    for (const [name, fn] of Object.entries(FNS)) {
      const runs: number[] = [];
      for (let r = 0; r < 5; r++) {
        for (const m of CORPUS) fn(m); // warmup
        const iters = 200;
        const t0 = performance.now();
        for (let k = 0; k < iters; k++) for (const m of CORPUS) if (fn(m)) sink++;
        const t1 = performance.now();
        runs.push(((t1 - t0) * 1000) / (iters * CORPUS.length));
      }
      runs.sort((a, b) => a - b);
      out[name] = Number(runs[2].toFixed(3));
    }
    console.log("BENCH_US_PER_MSG " + JSON.stringify(out) + ` n=${CORPUS.length} sink=${sink}`);
    expect(CORPUS.length).toBeGreaterThanOrEqual(200);
  });
});

// ---- Differential test: verbatim pre-optimisation implementations vs current exports ----
const LEG_USER_DECLINED_RE =
  /user rejected|rejected the request|rejected by the user|user declined|user denied|user disapproved|request declined|signing cancell?ed by user|transaction cancell?ed|user exited the modal|\b0x6985\b/i;
function legDetect(msg: string) {
  if (/has not been authori[sz]ed by the user|\b4100\b.*authori[sz]|wallet is locked|locked wallet|WalletNotConnected|wallet not connected|please unlock/i.test(msg)) return "locked";
  if (LEG_USER_DECLINED_RE.test(msg) || /transaction rejected|request rejected|\b4001\b/i.test(msg)) return "rejected";
  return null;
}
function legExtract(msg: string): number | null {
  const m = msg.match(/(?:custom program error|Error Code)[:\s]+0x([0-9a-fA-F]+)/i);
  if (m) return parseInt(m[1], 16);
  const mJson = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (mJson) return parseInt(mJson[1], 10);
  const m2 = msg.match(/Custom\((\d+)\)/);
  if (m2) return parseInt(m2[1], 10);
  const m3 = msg.match(/\b0x([0-9a-fA-F]+)\b/);
  if (m3) return parseInt(m3[1], 16);
  return null;
}
function legRate(msg: string) {
  if (/confirmation timeout|may still land/i.test(msg)) return false;
  return /too many requests|rate.?limits? exceeded|rate.?limited/i.test(msg) || (/\b429\b/.test(msg) && /rate.?limit/i.test(msg)) || /"code"\s*:\s*-32429\b/.test(msg);
}
function legTransient(msg: string) {
  if (/confirmation timeout|may still land/i.test(msg)) return false;
  const code = legExtract(msg);
  if (code !== null && [20, 26, 27].includes(code)) return true;
  if (msg.includes("Blockhash not found")) return true;
  if (msg.includes("block height exceeded")) return true;
  if (msg.includes("has expired")) return true;
  if (/too many requests/i.test(msg)) return true;
  if (legRate(msg)) return true;
  if (/\b429\b/.test(msg) && /rate.?limit/i.test(msg)) return true;
  return false;
}
function legStale(msg: string) {
  if (/confirmation timeout|may still land/i.test(msg)) return false;
  return legExtract(msg) === 19;
}

const TOKENS = [
  "429", " ", "rate limit", "Rate-Limited", "too many requests", "RATE LIMITS EXCEEDED", '"code":-32429', '"code" : -32429',
  "0x", "0X14", "0x1b", "0x6985", "Custom(", "Custom(27)", '"Custom":20', '"Custom" : 19', "custom program error: 0x13",
  "Error Code: 0x1a", "confirmation timeout", "may still land", "Blockhash not found", "block height exceeded", "has expired",
  "4001", "4100", "authorized", "authorised by the user", "wallet is locked", "user rejected", "Transaction rejected", "request rejected",
  "WalletNotConnected", "please unlock", "\n", "a", "Z", "9", ":", "{", "}", "custom", "CUSTOM", "rate", "limit", "ratelimit", "rate_limit",
];
function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("errorMessages differential (optimised vs legacy)", () => {
  it("0 mismatches over corpus + 20k mutated strings", () => {
    const r = rng(12345);
    const inputs: string[] = [...CORPUS];
    for (let i = 0; i < 20000; i++) {
      let s = CORPUS[Math.floor(r() * CORPUS.length)];
      const n = 1 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const t = TOKENS[Math.floor(r() * TOKENS.length)];
        const pos = Math.floor(r() * (s.length + 1));
        const op = r();
        if (op < 0.5) s = s.slice(0, pos) + t + s.slice(pos);
        else if (op < 0.8) s = s.slice(0, pos) + s.slice(pos + 1 + Math.floor(r() * 6));
        else s = r() < 0.5 ? s.toUpperCase() : s.toLowerCase();
      }
      inputs.push(s);
    }
    let mismatches = 0;
    const seen = { transient: 0, rate: 0, wallet: 0, code: 0 };
    for (const m of inputs) {
      const a = [isTransientError(m), isRateLimitText(m), detectWalletError(m), extractErrorCode(m), isEngineStaleAtSend(m)];
      const b = [legTransient(m), legRate(m), legDetect(m), legExtract(m), legStale(m)];
      if (a[0]) seen.transient++;
      if (a[1]) seen.rate++;
      if (a[2]) seen.wallet++;
      if (a[3] !== null) seen.code++;
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches++;
    }
    expect(inputs.length).toBeGreaterThanOrEqual(10000);
    // the mutation set must actually exercise the positive branches
    expect(seen.transient).toBeGreaterThan(500);
    expect(seen.rate).toBeGreaterThan(200);
    expect(seen.wallet).toBeGreaterThan(500);
    expect(seen.code).toBeGreaterThan(500);
    expect(mismatches).toBe(0);
  });
});
