/**
 * #2560 C7: a 100% close of an ISOLATED position reclaims its portfolio's rent
 * (tag 8 ClosePortfolio). Source-binding (useClosePosition needs its whole hook
 * stack to run): bind the safety properties —
 *  - the reclaim runs ONLY when the caller asks (reclaimOnClose) and a specific
 *    portfolio was closed, and only once that portfolio is actually EMPTY;
 *  - it is sim-gated (simulateBeforeSign) and best-effort (never throws into the
 *    completed close);
 *  - the ClosePortfolio ix reuses the proven encodeClosePortfolio wire.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../../hooks/useClosePosition.ts"),
  "utf8",
);

describe("useClosePosition isolated rent reclaim (C7)", () => {
  it("closePosition takes an explicit reclaimOnClose flag", () => {
    expect(SRC).toMatch(/closePercent: number, targetPortfolioPk\?: PublicKey, reclaimOnClose\?: boolean/);
  });

  it("reclaims only when asked, for a named portfolio, and only when THIS wallet owns an empty account", () => {
    expect(SRC).toMatch(/if \(reclaimOnClose && targetPortfolioPk\)/);
    // defense-in-depth: owner re-verify AND empty (capital 0, no active leg)
    expect(SRC).toMatch(/parsed\.owner\.equals\(owner\) && parsed\.capital === 0n && !parsed\.legs\.some\(\(l\) => l\.active\)/);
  });

  it("builds the tag-8 ClosePortfolio ix via the shared encoder and sim-gates the send", () => {
    expect(SRC).toContain("encodeClosePortfolio(id.portfolioId, id.matcherSequence, id.positionEpoch)");
    expect(SRC).toMatch(/sendTx\(\{ connection, wallet, instructions: \[closeIx\], simulateBeforeSign: true \}\)/);
  });

  it("is best-effort — the reclaim is wrapped so it can't fail the completed close", () => {
    // the reclaim block sits inside a try/catch that swallows errors
    const idx = SRC.indexOf("reclaimOnClose && targetPortfolioPk");
    expect(idx).toBeGreaterThan(-1);
    expect(SRC.slice(idx, idx + 1400)).toMatch(/catch \{\s*\/\* best-effort/);
  });
});
