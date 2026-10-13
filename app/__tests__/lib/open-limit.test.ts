/**
 * #3459: the limit an open from the order ticket is sent with. v17/v18: the engine's effective
 * price, never the site feed; legacy: the feed, refused when it disagrees with the chain.
 */
import { describe, expect, it } from "vitest";
import { openLimitE6 } from "@/lib/open-limit";
import { computeLimitPriceE6, FeedDisagreementError, SlippageError } from "@/lib/slippage";
import { UserFacingError } from "@/lib/errorMessages";
import { CLOSE_PRICE_UNREADABLE } from "@/lib/close-limit";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { PRICES_OUT_OF_SYNC_COPY } from "@/lib/limits/copy";

const EFF = 1_000_000n; // the engine's effective price: what the matcher prices from
const LOW_FEED = 850_000n; // the site feed, 15% low

describe("openLimitE6 on a v17/v18 market", () => {
  const base = { isV17: true, engine: { effectivePriceE6: EFF }, feedE6: LOW_FEED, onChainRefE6: () => EFF };

  it("a long's limit comes from the effective price, whatever the feed says", () => {
    expect(openLimitE6({ ...base, size: 5n })).toBe(computeLimitPriceE6({ markE6: EFF, size: 5n }));
    // a feed-derived long limit would sit BELOW the effective price: certain Custom(9)
    expect(computeLimitPriceE6({ markE6: LOW_FEED, size: 5n })).toBeLessThan(EFF);
  });

  it("a short's too", () => {
    expect(openLimitE6({ ...base, size: -5n })).toBe(computeLimitPriceE6({ markE6: EFF, size: -5n }));
  });

  it("no readable effective price: refuses, never falls back to the feed", () => {
    expect(() => openLimitE6({ ...base, engine: null, size: 5n })).toThrow(UserFacingError);
    expect(() => openLimitE6({ ...base, engine: { effectivePriceE6: 0n }, size: 5n })).toThrow(CLOSE_PRICE_UNREADABLE);
  });

  it("never runs the feed guard (the feed is display only here)", () => {
    expect(() => openLimitE6({ ...base, onChainRefE6: () => 1n, size: 5n })).not.toThrow();
  });
});

describe("openLimitE6 on a legacy market", () => {
  const base = { isV17: false, engine: null, size: 5n };

  it("feed and chain agree: the feed-derived limit", () => {
    expect(openLimitE6({ ...base, feedE6: 1_010_000n, onChainRefE6: () => EFF })).toBe(computeLimitPriceE6({ markE6: 1_010_000n, size: 5n }));
  });

  it("they disagree by more than 200 bps: refused with FeedDisagreementError (a SlippageError)", () => {
    let err: unknown = null;
    try {
      openLimitE6({ ...base, feedE6: LOW_FEED, onChainRefE6: () => EFF });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FeedDisagreementError);
    expect(err).toBeInstanceOf(SlippageError);
  });

  it("an unreadable reference (throws, null or 0) keeps the guard's no-op", () => {
    const thrower = () => {
      throw new Error("config missing");
    };
    for (const onChainRefE6 of [thrower, () => null, () => 0n]) {
      expect(openLimitE6({ ...base, feedE6: LOW_FEED, onChainRefE6 })).toBe(computeLimitPriceE6({ markE6: LOW_FEED, size: 5n }));
    }
  });

  it("no feed price: refuses", () => {
    expect(() => openLimitE6({ ...base, feedE6: null, onChainRefE6: () => EFF })).toThrow(UserFacingError);
  });
});

describe("the user line for a feed/chain disagreement", () => {
  it("says the prices are out of sync — not 'price moved', and not 'Couldn't reach Solana' at 429 bps", () => {
    const err = new FeedDisagreementError(
      "Price feed disagrees with the on-chain oracle by 429 bps (limit is 200). Refusing to derive a slippage limit from it.",
    );
    const um = resolveUserMessage(err, { surface: "trade", side: "long" } as never);
    expect(um.kind).toBe("prices-out-of-sync");
    expect(um.title).toBe(PRICES_OUT_OF_SYNC_COPY.title);
    expect(um.body).toBe(PRICES_OUT_OF_SYNC_COPY.body);
  });

  it("CONTROL: a plain slippage message still reads 'price moved'", () => {
    const um = resolveUserMessage(new Error("price moved past your limit price"), { surface: "trade", side: "long" } as never);
    expect(um.kind).toBe("price-moved");
  });
});
