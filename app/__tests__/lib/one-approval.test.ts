// @vitest-environment node
/** UX WP-9 (audit §3.11): N independent txs under ONE approval (lib/one-approval.ts). */
import { describe, expect, it, vi } from "vitest";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { runOneApproval } from "@/lib/one-approval";

const ix = (n: number) => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([n]) });
const units = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `m${i}`, instructions: [ix(i)] }));

describe("runOneApproval", () => {
  it("3 units -> ONE signAll, 3 broadcasts, all ok", async () => {
    const signAll = vi.fn(async (t: string[]) => t.map((x) => `signed:${x}`));
    const out = await runOneApproval(units(3), {
      simulate: async () => ({ err: null, consumed: 1000 }),
      build: (_ixs, _c, i) => `tx${i}`,
      signAll,
      broadcast: async (t) => `sig-${t}`,
    });
    expect(signAll).toHaveBeenCalledTimes(1);
    expect(signAll.mock.calls[0]![0]).toEqual(["tx0", "tx1", "tx2"]);
    expect(out.map((o) => o.ok)).toEqual([true, true, true]);
  });
  it("a unit refused in simulation is never signed; the others still go in the one approval", async () => {
    const signAll = vi.fn(async (t: string[]) => t);
    const out = await runOneApproval(units(3), {
      simulate: async (ixs) => ({ err: ixs[0]!.data[0] === 1 ? { Custom: 86 } : null, consumed: null }),
      build: (ixs) => `tx-for-${ixs[0]!.data[0]}`,
      signAll,
      broadcast: async (t) => t,
    });
    expect(signAll.mock.calls[0]![0]).toEqual(["tx-for-0", "tx-for-2"]);
    expect(out[1]).toMatchObject({ key: "m1", ok: false, stage: "refused" });
    expect(out[0]!.ok && out[2]!.ok).toBe(true);
  });
  it("a failed broadcast does not undo the others (independent units)", async () => {
    const out = await runOneApproval(units(3), {
      simulate: async () => ({ err: null, consumed: null }),
      build: (_i, _c, n) => n,
      signAll: async (t) => t,
      broadcast: async (t) => {
        if (t === 1) throw new Error("blockhash not found");
        return `s${t}`;
      },
    });
    expect(out.map((o) => (o.ok ? "ok" : o.stage))).toEqual(["ok", "failed", "ok"]);
  });
  it("everything refused: the wallet is never opened", async () => {
    const signAll = vi.fn(async (t: unknown[]) => t);
    await runOneApproval(units(2), { simulate: async () => ({ err: "x", consumed: null }), build: () => 0, signAll, broadcast: async () => "" });
    expect(signAll).not.toHaveBeenCalled();
  });
  it("#2743: a unit whose simulation could not RUN is never signed (no verdict is not a pass)", async () => {
    const signAll = vi.fn(async (t: string[]) => t);
    const broadcast = vi.fn(async (t: string) => `sig-${t}`);
    const out = await runOneApproval(units(3), {
      simulate: async (ixs) => (ixs[0]!.data[0] === 1 ? { err: null, consumed: null, unchecked: true } : { err: null, consumed: 1000 }),
      build: (ixs) => `tx-for-${ixs[0]!.data[0]}`,
      signAll,
      broadcast,
    });
    expect(signAll.mock.calls[0]![0]).toEqual(["tx-for-0", "tx-for-2"]);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(out[1]).toMatchObject({ key: "m1", ok: false, stage: "unchecked" });
    expect(out[0]!.ok && out[2]!.ok).toBe(true);
  });
  it("#2743: every simulation unreachable: the wallet is never opened", async () => {
    const signAll = vi.fn(async (t: unknown[]) => t);
    const out = await runOneApproval(units(2), { simulate: async () => ({ err: null, consumed: null, unchecked: true }), build: () => 0, signAll, broadcast: async () => "" });
    expect(signAll).not.toHaveBeenCalled();
    expect(out.map((o) => (o.ok ? "ok" : o.stage))).toEqual(["unchecked", "unchecked"]);
  });
});
