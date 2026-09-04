import { describe, it, expect } from "vitest";
import {
  assertFeedAgreesWithChain,
  MAX_FEED_DEVIATION_BPS,
  computeLimitPriceE6,
} from "@/lib/slippage";

/**
 * GH#2525 item 1 — `limit_price_e6` is the BINDING on-chain slippage constraint,
 * and it was derived from the off-chain feed with only an ABSOLUTE sanity band
 * (reject <= 0, reject > $1,000,000). Nothing tied it to the oracle the trade
 * actually settles against.
 *
 * The consequence is subtle and worth stating plainly: the user sets "0.5%
 * slippage" and gets 0.5% around a number someone else may have chosen. The
 * protection still appears on screen; it just stops meaning anything.
 */

const USD = (n: number) => BigInt(Math.round(n * 1_000_000)); // -> E6

describe("the feed must agree with the on-chain oracle before it can set a limit", () => {
  it("accepts the documented Pyth-vs-AuthMark gap", () => {
    // PLAYGROUND.md: the UI ticks Pyth, trades settle at the AuthMark, ~0.1%
    // apart, and that is intentional. It must not trip this guard.
    expect(() =>
      assertFeedAgreesWithChain({ feedE6: USD(100.1), onChainE6: USD(100) }),
    ).not.toThrow();
  });

  it("accepts an exactly-at-the-bound deviation", () => {
    // 200 bps on 100 -> 102. Inclusive, so this is the last accepted value.
    expect(() =>
      assertFeedAgreesWithChain({ feedE6: USD(102), onChainE6: USD(100) }),
    ).not.toThrow();
  });

  it("REFUSES a feed biased high beyond the bound — the actual attack shape", () => {
    // A high feed widens the band an adversarial matcher or LP can fill inside.
    expect(() =>
      assertFeedAgreesWithChain({ feedE6: USD(110), onChainE6: USD(100) }),
    ).toThrow(/disagrees with the on-chain oracle/);
  });

  it("REFUSES a feed biased low too — the guard is symmetric", () => {
    // A low feed hurts the other side of the book. Only checking one direction
    // would leave shorts exposed.
    expect(() =>
      assertFeedAgreesWithChain({ feedE6: USD(90), onChainE6: USD(100) }),
    ).toThrow(/disagrees with the on-chain oracle/);
  });

  it("reports the actual deviation, so the message is diagnosable", () => {
    expect(() =>
      assertFeedAgreesWithChain({ feedE6: USD(110), onChainE6: USD(100) }),
    ).toThrow(/1000 bps/);
  });

  it("no-ops when the on-chain price could not be read", () => {
    // Failing closed here would take the whole app down on an RPC hiccup, for a
    // defence-in-depth guard. That trade is deliberate and is stated in the
    // helper's doc comment.
    expect(() =>
      assertFeedAgreesWithChain({ feedE6: USD(500), onChainE6: null }),
    ).not.toThrow();
  });

  it("no-ops on a zero or negative on-chain price rather than dividing by it", () => {
    expect(() => assertFeedAgreesWithChain({ feedE6: USD(100), onChainE6: 0n })).not.toThrow();
    expect(() => assertFeedAgreesWithChain({ feedE6: USD(100), onChainE6: -5n })).not.toThrow();
  });

  it("no-ops on a zero feed — computeLimitPriceE6 already rejects that", () => {
    // Two guards for one condition would produce two different error messages
    // for the same cause. The slippage helper owns this one.
    expect(() => assertFeedAgreesWithChain({ feedE6: 0n, onChainE6: USD(100) })).not.toThrow();
    expect(() => computeLimitPriceE6({ markE6: 0n, size: 1n })).toThrow(
      /live mark price unavailable/,
    );
  });

  it("the bound is 20x the documented feed gap, so honest feeds never see it", () => {
    // Pins the number itself. Loosening it should be a deliberate edit with this
    // reasoning in front of whoever does it.
    expect(MAX_FEED_DEVIATION_BPS).toBe(200n);
  });
});

describe("an explicit user limit is never second-guessed", () => {
  it("computeLimitPriceE6 still derives from the mark it is handed", () => {
    // The guard is applied by the CALLER only when the limit is derived. A user
    // who typed their own limit price gets exactly that number — this test pins
    // that the helper itself stays a pure function of its input.
    const limit = computeLimitPriceE6({ markE6: USD(100), size: 1n, slippageBps: 50n });
    expect(limit).toBe(USD(100.5));
  });
});
