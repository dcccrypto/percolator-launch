/** S-3 (v2.2 QA 2026-10-11): the Earn deposit's fresh-price wait is bounded (20 s) and ends in a clear line. */
import { describe, expect, it } from "vitest";
import { EARN_PRICE_WAIT_COPY, EarnPriceWaitTimeoutError, withEarnPriceWait } from "@/lib/limits/earn-price-wait";
import { earnErrorMessage } from "@/lib/earnErrors";

const W = "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM";
const refusal = (code: number, programId: string | null = W) => Object.assign(new Error(`Transaction simulation failed: {"InstructionError":[1,{"Custom":${code}}]}`), { name: "SimulationRefusal", code, programId });

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe("withEarnPriceWait", () => {
  it("a transient pre-sign 27 is re-checked and the deposit goes through", async () => {
    const c = clock();
    let n = 0;
    const waits: boolean[] = [];
    const sig = await withEarnPriceWait(async () => { if (n++ < 3) throw refusal(27); return "SIG"; }, { wrapperProgramId: W, ...c, onWaiting: (w) => waits.push(w) });
    expect(sig).toBe("SIG");
    expect(n).toBe(4);
    expect(waits).toEqual([true, false]);
  });
  it("still refused after 20 s => stops with the clear line (never an endless wait)", async () => {
    const c = clock();
    let n = 0;
    const p = withEarnPriceWait(async () => { n++; throw refusal(26); }, { wrapperProgramId: W, ...c });
    await expect(p).rejects.toBeInstanceOf(EarnPriceWaitTimeoutError);
    expect(c.now()).toBeGreaterThanOrEqual(20_000);
    expect(c.now()).toBeLessThan(25_000);
    expect(n).toBe(9); // 0, 2.5 … 20 s
    const e = await p.catch((x) => x);
    expect(earnErrorMessage(e, "deposit")).toBe(EARN_PRICE_WAIT_COPY);
    expect(EARN_PRICE_WAIT_COPY).not.toMatch(/usually takes a few seconds/);
  });
  it("NEGATIVE CONTROLS: other codes, another program, or a post-sign failure are not retried", async () => {
    for (const e of [refusal(21), refusal(27, "Other1111111111111111111111111111111111111"), new Error('custom program error: 0x1b')]) {
      const c = clock();
      let n = 0;
      await expect(withEarnPriceWait(async () => { n++; throw e; }, { wrapperProgramId: W, ...c })).rejects.toBe(e);
      expect(n).toBe(1);
      expect(c.now()).toBe(0);
    }
  });
});
