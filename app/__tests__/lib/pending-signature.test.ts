/**
 * GH#2804: the timed-out signature is recovered from the confirmation-timeout error, and
 * watchPendingSignature resolves it (landed / dropped / undetermined) instead of leaving it unwatched.
 */
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { timedOutSignature } from "@/lib/tx";
import { watchPendingSignature } from "@/lib/pending-signature";

const SIG = bs58.encode(new Uint8Array(64).fill(7));

describe("timedOutSignature", () => {
  it("reads the signature from sendTx's pollConfirmation timeout message", () => {
    const err = new Error(`Confirmation timeout (90s) — tx may still land. Check explorer: ${SIG}`);
    expect(timedOutSignature(err)).toBe(SIG);
  });

  it("prefers the signature broadcastSignedTx attaches", () => {
    const err = Object.assign(new Error("Confirmation timeout (90s) — tx may still land."), { signature: SIG });
    expect(timedOutSignature(err)).toBe(SIG);
  });

  it("is null for anything that is not a confirmation timeout (nothing to watch)", () => {
    expect(timedOutSignature(new Error(`Transaction failed: {"InstructionError":[0,{"Custom":21}]} ${SIG}`))).toBeNull();
    expect(timedOutSignature(new Error("Blockhash not found"))).toBeNull();
    expect(timedOutSignature(new Error("User rejected the request"))).toBeNull();
    expect(timedOutSignature(null)).toBeNull();
  });

  it("is null for a timeout without a usable signature", () => {
    expect(timedOutSignature(new Error("Confirmation timeout (90s) — tx may still land. Check explorer: abc"))).toBeNull();
    expect(timedOutSignature(new Error("Confirmation timeout"))).toBeNull();
  });
});

/** A fake clock: sleep advances it, so the loop runs instantly and deterministically. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe("watchPendingSignature", () => {
  it("resolves 'landed' as soon as a check says landed", async () => {
    const c = clock();
    const check = vi.fn()
      .mockResolvedValueOnce("unknown")
      .mockResolvedValueOnce("not-found")
      .mockResolvedValueOnce("landed");
    await expect(watchPendingSignature(check, { ...c, intervalMs: 1_000 })).resolves.toBe("landed");
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("calls 'dropped' only after every check for droppedAfterMs said not-found", async () => {
    const c = clock();
    const check = vi.fn().mockResolvedValue("not-found");
    await expect(
      watchPendingSignature(check, { ...c, intervalMs: 1_000, droppedAfterMs: 5_000, maxMs: 60_000 }),
    ).resolves.toBe("dropped");
    expect(c.now()).toBe(5_000);
    expect(check).toHaveBeenCalledTimes(6);
  });

  it("an indeterminate answer restarts the not-found run (a lagging node is not a drop)", async () => {
    const c = clock();
    const answers = ["not-found", "not-found", "unknown", "not-found", "not-found", "not-found", "not-found"];
    const check = vi.fn(async () => (answers.shift() ?? "not-found") as "not-found" | "unknown");
    await expect(
      watchPendingSignature(check, { ...c, intervalMs: 1_000, droppedAfterMs: 3_000, maxMs: 60_000 }),
    ).resolves.toBe("dropped");
    // run restarts at t=3000 (after the 'unknown' at t=2000) and needs 3s more.
    expect(c.now()).toBe(6_000);
  });

  it("gives up with 'undetermined' after maxMs of indeterminate answers (and a throwing check)", async () => {
    const c = clock();
    const check = vi.fn().mockResolvedValueOnce("unknown").mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue("unknown");
    await expect(watchPendingSignature(check, { ...c, intervalMs: 1_000, maxMs: 4_000 })).resolves.toBe("undetermined");
    expect(c.now()).toBe(4_000);
  });

  it("stops when aborted", async () => {
    const c = clock();
    const ctl = new AbortController();
    const check = vi.fn(async () => {
      ctl.abort();
      return "landed" as const;
    });
    await expect(watchPendingSignature(check, { ...c, signal: ctl.signal })).resolves.toBe("aborted");
  });
});
