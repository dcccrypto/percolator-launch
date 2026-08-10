/**
 * PoC + regression — /api/open-interest/[slab] must signal a degraded state on an
 * all-paths-failure, not return HTTP 200 with fabricated zeros.
 *
 * The route's fallback returned { totalOi:"0", ... } with status 200 when every
 * data path failed, so a transient RPC failure rendered as a real "$0 OI /
 * Balanced" market. The consumer (OpenInterestCard) is already built correctly:
 *   if (!res.ok) throw  →  catch → fall back to on-chain engine OI
 * so a 5xx makes it show the REAL on-chain OI instead of trusting the zeros.
 *
 * This models the consumer's exact handling and shows a 200-with-zeros yields a
 * false $0, while a 503 yields the real on-chain value.
 */
import { describe, it, expect } from "vitest";

// Faithful model of OpenInterestCard's fetch handling (route.tsx:110-142).
function consumerTotalOi(
  res: { ok: boolean; body: { totalOi?: string } },
  engineOi: { long: bigint; short: bigint } | null,
): string | null {
  if (!res.ok) {
    // catch → on-chain fallback
    if (engineOi) return (engineOi.long + engineOi.short).toString();
    return null; // neutral/error state (no fabricated number)
  }
  return res.body.totalOi ?? null; // trusts the API body
}

const engine = { long: 100n, short: 50n }; // real on-chain OI = 150

describe("open-interest degraded response", () => {
  it("200 + zeros makes the consumer show a false $0 (the bug)", () => {
    const res = { ok: true, body: { totalOi: "0" } };
    expect(consumerTotalOi(res, engine)).toBe("0"); // wrong — market actually has OI
  });

  it("503 makes the consumer fall back to real on-chain OI (the fix)", () => {
    const res = { ok: false, body: {} };
    expect(consumerTotalOi(res, engine)).toBe("150"); // real OI shown instead
  });

  it("503 with no engine yields a neutral/error state, not a fabricated $0", () => {
    const res = { ok: false, body: {} };
    expect(consumerTotalOi(res, null)).toBeNull();
  });
});
