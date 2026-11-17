import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { wrapperEventTokensV22, LOG_TRUNCATED_V22, type WrapperTokensV22 } from "@/lib/v22/sdk/v22-fill-events";

// Verbatim pre-memo implementation (feat/v22-app ffb64d77): the oracle the memoised walk must equal.
const RUNTIME_LINE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (.*)$/s;
const INVOKE_TAIL = /^invoke \[([0-9]+)\]$/;
function oldLine(line: string): { id: string; tail: string } | null {
  const m = RUNTIME_LINE.exec(line);
  if (!m) return null;
  try {
    if (new PublicKey(m[1]).toBase58() !== m[1]) return null;
  } catch {
    return null;
  }
  return { id: m[1], tail: m[2] };
}
function oldWalk(logs: readonly string[] | null | undefined, wrapper: PublicKey): WrapperTokensV22 {
  if (!logs || logs.length === 0) return { ok: false, unknown: "no-logs" };
  if (logs.includes(LOG_TRUNCATED_V22)) return { ok: false, unknown: "truncated" };
  const w = wrapper.toBase58();
  const stack: string[] = [];
  const tokens: string[] = [];
  for (const line of logs) {
    const rl = oldLine(line);
    if (rl) {
      const inv = INVOKE_TAIL.exec(rl.tail);
      if (inv) {
        if (Number(inv[1]) !== stack.length + 1) return { ok: false, unknown: "bad-invoke-depth" };
        stack.push(rl.id);
      } else if (rl.tail === "success" || rl.tail.startsWith("failed: ")) {
        if (stack[stack.length - 1] !== rl.id) return { ok: false, unknown: "bad-return" };
        stack.pop();
      }
      continue;
    }
    if (line.startsWith("Program data: ")) {
      const top = stack[stack.length - 1];
      if (top === undefined) return { ok: false, unknown: "data-outside-frame" };
      if (top === w) for (const t of line.slice("Program data: ".length).split(" ")) if (t !== "") tokens.push(t);
    }
  }
  if (stack.length !== 0) return { ok: false, unknown: "unclosed-frame" };
  return { ok: true, tokens };
}

// Deterministic PRNG (mulberry32).
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

describe("wrapperEventTokensV22 memo == pre-memo walk", () => {
  it("matches on 30,000 random + hostile log arrays", () => {
    const r = rng(0x5eed);
    const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
    const wrappers = [0, 1, 2].map(() => new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256))));
    const good = [...wrappers.map((k) => k.toBase58()), "11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111"];
    const randId = () => Array.from({ length: 32 + Math.floor(r() * 13) }, () => pick([...B58])).join("");
    // Valid-charset ids that decode to != 32 bytes or non-canonical (e.g. leading '1' padding variants).
    const hostileIds = [randId(), "1" + good[0].slice(0, 43), good[0] + "1", good[0].slice(0, 40), "1".repeat(44), "z".repeat(44), "z".repeat(32), "0OIl" + good[0], randId(), randId()];
    const ids = () => (r() < 0.85 ? pick(good) : pick(hostileIds));
    const tok = () => pick(["AAAA", "QUJD", "AAA", "A B", "", "====", "QUJD=", "zzz+/"]);
    const line = (): string => {
      const x = r();
      if (x < 0.25) return `Program ${ids()} invoke [${pick([1, 1, 2, 3, 4, 0, 99])}]`;
      if (x < 0.45) return `Program ${ids()} success`;
      if (x < 0.5) return `Program ${ids()} failed: custom program error: 0x1`;
      if (x < 0.55) return `Program ${ids()} consumed 100 of 200 compute units`;
      if (x < 0.75) return `Program data: ${Array.from({ length: Math.floor(r() * 4) }, tok).join(pick([" ", "  ", " "]))}`;
      if (x < 0.8) return pick([LOG_TRUNCATED_V22, "Program log: hi", "", "Program", "Program  success", `Program ${ids()}`, `Program ${ids()} invoke [1]\nProgram ${ids()} success`, "program data: x"]);
      if (x < 0.85) return `Program ${ids()} ${pick(["invoke [1]", "success", "invoke [01]", "invoke [1] ", "failed: x", "failed:"])}`;
      return `Program log: ${randId()}`;
    };
    // Well-formed nested frames for a decent share of cases that reach the token branch.
    const wellFormed = (): string[] => {
      const out: string[] = [];
      const st: string[] = [];
      const n = 1 + Math.floor(r() * 12);
      for (let i = 0; i < n; i++) {
        const y = r();
        if (y < 0.4 && st.length < 4) { const id = ids(); st.push(id); out.push(`Program ${id} invoke [${st.length}]`); }
        else if (y < 0.7 && st.length) out.push(`Program ${st.pop()} success`);
        else out.push(`Program data: ${tok()} ${tok()}`);
      }
      while (st.length && r() < 0.9) out.push(`Program ${st.pop()} success`);
      return out;
    };
    let mismatches = 0, okCount = 0, N = 30000;
    for (let i = 0; i < N; i++) {
      const w = pick(wrappers);
      let logs: string[] | null | undefined;
      const k = r();
      if (k < 0.02) logs = null; else if (k < 0.04) logs = []; else if (k < 0.5) logs = wellFormed();
      else logs = Array.from({ length: Math.floor(r() * 25) }, line);
      const a = JSON.stringify(wrapperEventTokensV22(logs, w));
      const b = JSON.stringify(oldWalk(logs, w));
      if (a !== b) mismatches++;
      if (b.startsWith('{"ok":true')) okCount++;
    }
    expect(mismatches).toBe(0);
    expect(okCount).toBeGreaterThan(1000); // the generator must reach the success path, not only error exits
  }, 240_000);

  it("memo stays correct across eviction (>512 distinct ids) and repeats", () => {
    const w = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
    const r = rng(7);
    for (let i = 0; i < 1500; i++) {
      const id = new PublicKey(Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256))).toBase58();
      const logs = [`Program ${id} invoke [1]`, "Program data: AAAA", `Program ${id} success`, `Program ${id} invoke [1]`, `Program ${id} success`];
      expect(wrapperEventTokensV22(logs, w)).toEqual(oldWalk(logs, w));
    }
  }, 120_000);
});
