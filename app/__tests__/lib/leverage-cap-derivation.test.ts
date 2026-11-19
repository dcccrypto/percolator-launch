/**
 * GH#2621 — the dial's bounds must TRACK @/lib/market-params, not merely equal
 * it today.
 *
 * That distinction is the whole defect: 6.5 was a private copy that stayed
 * behind when the thing it came from changed. `expect(MAX_LEVERAGE).toBe(
 * MAX_LEVERAGE_X)` cannot see it — both are 10 at runtime.
 *
 * My first attempt at closing this asserted on source text, matching
 * `export const MAX_LEVERAGE = MAX_LEVERAGE_X;` after stripping comments. It was
 * defeated in one line — delete the name from the import and add a local
 * `const MAX_LEVERAGE_X = 10;`, and the regex still matches while the binding is
 * now a private copy. It also produced FALSE FAILURES: the stripper cut lines at
 * the first `//`, so an ordinary `https://` URL anywhere in the file deleted the
 * export from the text being searched, and the trailing `\s*;` could not span an
 * `as const`.
 *
 * Mocking the module is the real check. If the dial imports the constant, its
 * exports move when the mock moves. If it has its own copy, they do not. No
 * source scraping, no stripper, no false failures.
 */

import { describe, expect, it, vi } from "vitest";
import { MAX_LEVERAGE, MIN_LEVERAGE } from "@/components/create/StepControlRoom";
import * as params from "@/lib/market-params";

// Sentinels chosen so a hard-coded 2/10 cannot coincide with them.
vi.mock("@/lib/market-params", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/market-params")>();
  return { ...actual, MAX_LEVERAGE_X: 7, MIN_LEVERAGE_X: 3 };
});

describe("the dial's bounds are derived, not copied", () => {
  it("follows market-params when it moves", async () => {
    expect(MAX_LEVERAGE).toBe(7);
    expect(MIN_LEVERAGE).toBe(3);
  });

  it("CONTROL: the mock is actually in effect", async () => {
    // Without this, a failure to apply the mock would make the test above fail
    // for the wrong reason — or, if the sentinels ever matched the real values,
    // pass for the wrong reason.
    expect(params.MAX_LEVERAGE_X).toBe(7);
    expect(params.MIN_LEVERAGE_X).toBe(3);
    // And the rest of the module is the real one, so this is a narrow override.
    expect(typeof params.deriveMarketParams).toBe("function");
  });
});
