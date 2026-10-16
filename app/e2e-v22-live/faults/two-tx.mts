/**
 * E2E-3 fault: force the multi-asset order onto its two-transaction branch on the REAL chain.
 *  - the FIRST gate simulation of the order body alone (CU limit 1.4M, last ix = wrapper) answers Custom 121 on the trade
 *    (what a stale positioned peer causes; the keeper keeps 2xhs fresh, so it can't be produced on demand);
 *  - the [refresh cranks, body] simulation that follows answers OK at 1.3M CU (> the 1.2M one-tx ceiling).
 * Every other simulation and every send is real: the crank tx and the order tx land on devnet.
 */
import type { RpcCall, RpcFault } from "../harness.mts";
const WRAPPER = "6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM";
export default (note: (s: string) => void): RpcFault => {
  let body: string[] | null = null;
  let bigDone = false;
  return (c: RpcCall) => {
    if (c.method !== "simulateTransaction" || c.cuLimit !== 1_400_000) return undefined;
    if (!body && c.programs[c.programs.length - 1] === WRAPPER) {
      body = c.data.slice(2);
      note(`fault: body-alone sim #${c.n} (${body.length} ixs) -> Custom 121 at ix ${c.ixCount - 1}`);
      return { err: { InstructionError: [c.ixCount - 1, { Custom: 121 }] }, logs: [`Program ${WRAPPER} failed: custom program error: 0x79`], unitsConsumed: 90_000, accounts: null, returnData: null };
    }
    const tail = c.data.slice(-((body?.length) ?? 0));
    if (body && !bigDone && c.ixCount - 2 > body.length && tail.join() === body.join()) {
      bigDone = true;
      note(`fault: [${c.ixCount - 2 - body.length} crank(s), body] sim #${c.n} -> OK at 1,300,000 CU`);
      return { err: null, logs: [], unitsConsumed: 1_300_000, accounts: null, returnData: null };
    }
    return undefined;
  };
};
