/**
 * One landed order is read by readExecFill and readClippedFill. Before the shared reader, a node that answers null twice
 * cost 3 + 3 = 6 getTransaction calls (up to 8 at the retry cap); now both ride one retry loop (3).
 */
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fx from "../../fixtures/v22-clipped-fill-tx.json";
import { readClippedFill } from "@/lib/v22/clipped-fill";
import { readExecFill } from "@/lib/v22/exec-fill";
import { readLandedTx } from "@/lib/v22/landed-tx";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const SWORDCAT = new PublicKey("6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF");

const mk = () =>
  vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue({ slot: 7, meta: { err: null, logMessages: fx.logMessages } });

describe("shared landed-tx read", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("one landed order costs 3 getTransaction calls, not 6, and both outputs are unchanged", async () => {
    const getTransaction = mk();
    const conn = { getTransaction } as never;
    const both = Promise.all([
      readExecFill(conn, fx.sig, WRAPPER, { market: SWORDCAT }),
      readClippedFill(conn, fx.sig, WRAPPER, { market: SWORDCAT }),
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    const [exec, clipped] = await both;
    expect(getTransaction).toHaveBeenCalledTimes(3);

    // differential: each reader alone (its own fetch loop, the pre-change cost) yields deep-equal results
    const soloG = mk();
    const soloExecP = readExecFill({ getTransaction: soloG } as never, fx.sig, WRAPPER, { market: SWORDCAT });
    await vi.advanceTimersByTimeAsync(2000);
    const soloClipP = readClippedFill({ getTransaction: soloG } as never, fx.sig, WRAPPER, { market: SWORDCAT });
    await vi.advanceTimersByTimeAsync(2000);
    expect(exec).toEqual(await soloExecP);
    expect(clipped).toEqual(await soloClipP);
    expect(clipped?.executedQ).toBe(9_525_082n);
  });

  it("a single reader keeps 4 tries and 700 ms sleeps; nothing is cached after it settles", async () => {
    const getTransaction = vi.fn().mockResolvedValue(null);
    const sleep = vi.fn(async () => {});
    expect(await readLandedTx({ getTransaction }, "s", sleep)).toBeNull();
    expect(getTransaction).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[700], [700], [700]]);
    await readLandedTx({ getTransaction }, "s", sleep);
    expect(getTransaction).toHaveBeenCalledTimes(8);
  });
});
