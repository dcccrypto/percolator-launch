// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { parseFailure } from "@/lib/limits/user-message";
import { quoteExit, sendExit, withExitBudget, type ExitRunDeps, type ExitRunInput, type SimResult } from "@/lib/v22/earn-exit-run";
import type { ExitContext } from "@/lib/v22/earn-exit";

const k = () => Keypair.generate().publicKey;
const ctx = (): ExitContext => ({
  market: { programId: new PublicKey(resolveDevnetProgramIds().wrapper), market: k(), registryDomain: 0 },
  redeemer: k(),
  redeemerLpAta: k(),
  redeemerDest: k(),
  vaultToken: k(),
  sourceDomain: 0,
  shares: 1_000n,
});
const input = (mode: ExitRunInput["mode"] = "execute"): ExitRunInput => ({ ctx: ctx(), mode });
const stale = (n: number) => Array.from({ length: n }, () => ({ key: k(), legs: 1 }));
const ok = (after: bigint): SimResult => ({ err: null, logs: [], destAfter: after });
const prog = (code: number): SimResult => ({ err: { InstructionError: [0, { Custom: code }] }, logs: [`Program x failed: custom program error: 0x${code.toString(16)}`], destAfter: null });
const exec77 = (ixs: TransactionInstruction[]) => ixs.find((i) => i.data[0] === 77)!;

function deps(over: Partial<ExitRunDeps> & { sims?: SimResult[]; staleSets?: ReturnType<typeof stale>[]; sendErrors?: unknown[] }): { d: ExitRunDeps; log: string[] } {
  const log: string[] = [];
  const sims = [...(over.sims ?? [ok(1_000_000n)])];
  const staleSets = [...(over.staleSets ?? [[]])];
  const sendErrors = [...(over.sendErrors ?? [])];
  const d: ExitRunDeps = {
    readStale: async () => staleSets.length > 1 ? staleSets.shift()! : staleSets[0],
    readDestBalance: async () => 0n,
    simulate: vi.fn(async (ixs, units) => {
      log.push(`sim:${units}:${exec77(ixs)?.keys.length ?? 0}`);
      return sims.length > 1 ? sims.shift()! : sims[0];
    }),
    send: vi.fn(async (ixs, units) => {
      log.push(`send:${units}:${exec77(ixs)?.keys.length ?? 0}`);
      const e = sendErrors.shift();
      if (e) throw e;
      return "SIG";
    }),
    parse: parseFailure,
    sleep: async () => {},
    ...over,
  };
  return { d, log };
}
const err = (code: number) => new Error(`custom program error: 0x${code.toString(16)}`);

describe("v22 earn exit runner", () => {
  it("SIMULATES before anything is sent, and quote() sends nothing", async () => {
    const { d, log } = deps({ sims: [ok(1_000_000n)], staleSets: [stale(2)] });
    const r = await quoteExit(input(), d);
    expect(r.status).toBe("quoted");
    expect(d.send).not.toHaveBeenCalled();
    expect(log[0]).toMatch(/^sim:1300000:15$/); // 13 base + 2 refresh, explicit 1.3M
    if (r.status === "quoted") {
      expect(r.quote.quote).toBe(1_000_000n);
      expect(r.quote.minPayout).toBe(999_500n);
      expect(r.quote.staleCount).toBe(2);
    }
  });

  it("sends nothing when the simulation fails", async () => {
    const { d } = deps({ sims: [prog(1)] });
    const r = await quoteExit(input(), d);
    expect(r.status).toBe("failed");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a compute overrun is not shown as 118: units are raised, then it is a plain failure", async () => {
    const over: SimResult = { err: "ComputationalBudgetExceeded", logs: ["Program x failed: exceeded CUs meter at BPF instruction"], destAfter: null };
    const { d, log } = deps({ sims: [over], staleSets: [stale(1)] });
    const r = await quoteExit(input(), d);
    expect(r.status).toBe("failed"); // not wait-for-sweep
    expect(log).toEqual(["sim:1300000:14", "sim:1400000:14"]);
  });

  it("118 while quoting: re-reads the stale set, re-plans with more refresh accounts, then quotes (one action)", async () => {
    const onRefreshing = vi.fn();
    const { d, log } = deps({ sims: [prog(118), ok(2_000_000n)], staleSets: [stale(1), stale(3)], onRefreshing });
    const r = await quoteExit(input(), d);
    expect(r.status).toBe("quoted");
    expect(log).toEqual(["sim:1300000:14", "sim:1300000:16"]);
    expect(onRefreshing.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it("118 on every attempt ends in the calm wait-for-sweep outcome", async () => {
    const { d } = deps({ sims: [prog(118)], staleSets: [stale(9)] });
    const r = await quoteExit(input(), d);
    expect(r.status).toBe("wait-for-sweep");
  });

  it("118 at send time: refresh accounts are added on the retry and it lands, in one action, with the confirmed floor", async () => {
    const { d, log } = deps({ sims: [ok(1_000_000n)], staleSets: [stale(1), stale(1), stale(4)], sendErrors: [err(118)] });
    const q = await quoteExit(input(), d);
    if (q.status !== "quoted") throw new Error("quote");
    log.length = 0;
    const r = await sendExit(input(), q.quote, d);
    expect(r.status).toBe("sent");
    expect(log.filter((l) => l.startsWith("send"))).toEqual(["send:1300000:14", "send:1300000:17"]);
    const lastIxs = (d.send as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as TransactionInstruction[];
    expect(exec77(lastIxs).data.readBigUInt64LE(3)).toBe(999_500n);
  });

  it("117 at send time: re-quotes and returns the NEW minimum for one confirm (nothing more is sent)", async () => {
    const { d } = deps({ sims: [ok(1_000_000n), ok(900_000n)], sendErrors: [err(117)] });
    const q = await quoteExit(input(), d);
    if (q.status !== "quoted") throw new Error("quote");
    const r = await sendExit(input(), q.quote, d);
    expect(r.status).toBe("requoted");
    if (r.status === "requoted") expect(r.quote.minPayout).toBe(899_550n);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("the exit simulation / send carries the explicit compute budget and the 128 KiB heap when refreshing", () => {
    const ixs = withExitBudget([], 1_300_000);
    const kinds = ixs.map((i) => i.data[0]); // 1 = RequestHeapFrame, 2 = SetComputeUnitLimit
    expect(ixs.every((i) => i.programId.equals(ComputeBudgetProgram.programId))).toBe(true);
    expect(kinds).toContain(1);
    expect(kinds).toContain(2);
    const heap = ixs.find((i) => i.data[0] === 1)!;
    expect(heap.data.readUInt32LE(1)).toBe(131_072);
    expect(ixs.find((i) => i.data[0] === 2)!.data.readUInt32LE(1)).toBe(1_300_000);
  });

  it("pair mode simulates [76, 77]; request mode quotes from the estimate without simulating", async () => {
    const { d } = deps({ sims: [ok(1_000_000n)] });
    await quoteExit(input("pair"), d);
    const sent = (d.simulate as ReturnType<typeof vi.fn>).mock.calls[0][0] as TransactionInstruction[];
    expect(sent.map((i) => i.data[0])).toEqual([76, 77]);
    const { d: d2 } = deps({});
    const r = await quoteExit({ ...input("request"), estimateAtoms: 5_000_000n }, d2);
    expect(d2.simulate).not.toHaveBeenCalled();
    if (r.status === "quoted") {
      expect(r.quote.estimate).toBe(true);
      expect(r.quote.minPayout).toBe(4_997_500n);
    }
  });
});
