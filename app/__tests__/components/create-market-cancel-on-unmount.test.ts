/**
 * GH#2623 — binds the "leaving /create stops the wallet-popup retry loop" fix
 * to the source.
 *
 * `__tests__/lib/tx.test.ts` covers the pure primitives (`sendTx`'s abort
 * check, `checkSignatureLanded`'s retry-before-not-found). What that suite
 * cannot see is the WIRING: whether `create()` actually threads an
 * AbortSignal into every step that can prompt a wallet popup, and whether
 * CreateMarketWizard actually cancels it on unmount. Reverting the wiring
 * while leaving the primitives alone would pass every pure-helper test and
 * still leave the popups running after navigation — same technique, and the
 * same reason, as create-market-price-gate.test.ts.
 */

import { describe, expect, it } from "vitest";
import path from "path";
import { readSource } from "../helpers/source-scan";

const WIZARD = readSource(
  path.resolve(__dirname, "../../components/create/CreateMarketWizard.tsx"),
);
const HOOK = readSource(path.resolve(__dirname, "../../hooks/useCreateMarket.ts"));

/** Drop comments, so an assertion about CODE is not satisfied by prose. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("CreateMarketWizard cancels the in-flight launch on unmount", () => {
  it("destructures cancelInFlightLaunch from useCreateMarket()", () => {
    expect(code(WIZARD)).toMatch(/cancelInFlightLaunch\s*\}\s*=\s*useCreateMarket\(\)/);
  });

  it("calls it from an unmount-ONLY effect cleanup, not inline in the render body", () => {
    // Must be inside a useEffect's returned cleanup function, so it fires on
    // unmount (React calls the cleanup before the next effect run AND on
    // unmount) — not called directly during render, which would abort every
    // launch immediately.
    const c = code(WIZARD);
    const effectIdx = c.indexOf("useEffect(() => {\n    return () => cancelInFlightLaunch");
    expect(effectIdx).toBeGreaterThan(-1);
  });

  it("optional-chains the call — several tests mock useCreateMarket() without this field", () => {
    expect(code(WIZARD)).toMatch(/cancelInFlightLaunch\?\.\(\)/);
  });
});

describe("useCreateMarket exposes cancelInFlightLaunch and wires it to a real AbortController", () => {
  it("the hook's return value includes cancelInFlightLaunch", () => {
    const c = code(HOOK);
    const returnIdx = c.lastIndexOf("return {");
    const returnStmt = c.slice(returnIdx, c.indexOf("}", returnIdx) + 1);
    expect(returnStmt).toContain("cancelInFlightLaunch");
  });

  it("cancelInFlightLaunch aborts a ref-held AbortController, not a no-op", () => {
    const c = code(HOOK);
    const fnIdx = c.indexOf("const cancelInFlightLaunch");
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBody = c.slice(fnIdx, c.indexOf("}, []);", fnIdx) + 7);
    expect(fnBody).toMatch(/abortControllerRef\.current\?\.abort\(\)/);
  });

  it("create() builds a FRESH AbortController per call (never reuses a finished one)", () => {
    const c = code(HOOK);
    const createIdx = c.indexOf("const create = useCallback(");
    expect(createIdx).toBeGreaterThan(-1);
    const createHead = c.slice(createIdx, createIdx + 800);
    expect(createHead).toMatch(/new AbortController\(\)/);
    expect(createHead).toMatch(/abortControllerRef\.current\s*=\s*abortController/);
  });
});

describe("the abortSignal reaches every place that can prompt a wallet popup", () => {
  it("attemptFreshBatchedLaunch's ctx carries it, and broadcastTailTx's recoverTailFrom checks it FIRST", () => {
    const c = code(HOOK);
    // Passed into the batch call.
    const batchCallIdx = c.indexOf("await attemptFreshBatchedLaunch({");
    const batchCall = c.slice(batchCallIdx, c.indexOf("});", batchCallIdx));
    expect(batchCall).toMatch(/abortSignal,?/);

    // recoverTailFrom is the ONLY place in the batch path that prompts a
    // FRESH signature outside the user's own click — the check must be the
    // first thing it does, before blockhashRecoveries is incremented or a
    // blockhash is fetched.
    const recoverIdx = c.indexOf("const recoverTailFrom = async");
    expect(recoverIdx).toBeGreaterThan(-1);
    const recoverHead = c.slice(recoverIdx, recoverIdx + 400);
    const abortCheckIdx = recoverHead.indexOf("abortSignal?.aborted");
    const incrementIdx = recoverHead.indexOf("blockhashRecoveries += 1");
    expect(abortCheckIdx).toBeGreaterThan(-1);
    expect(incrementIdx).toBeGreaterThan(-1);
    expect(abortCheckIdx).toBeLessThan(incrementIdx);
  });

  it("every sequential sendTx call in create() passes abortSignal — none silently omitted", () => {
    // The regression this guards against: a NEW step added to the sequential
    // (resume/retry) path without threading the signal through would keep
    // prompting popups after unmount even though the primitive (sendTx's
    // abort check) and every OTHER call site were fixed.
    const c = code(HOOK);
    const createIdx = c.indexOf("const create = useCallback(");
    const createBody = c.slice(createIdx);
    const callSites = createBody.split("await sendTx({").slice(1); // drop the text before the first call
    expect(callSites.length).toBeGreaterThanOrEqual(11); // GH#2623: was 12; C-1 removed the separate backing-seed sendTx (folded into the Earn-vault tx)
    for (const site of callSites) {
      // abortSignal must appear within this call's own options object, close
      // to the top — a generous window that still can't reach into the NEXT
      // call site (the closest options objects here run well under 250 chars).
      expect(site.slice(0, 250)).toContain("abortSignal");
    }
  });
});
