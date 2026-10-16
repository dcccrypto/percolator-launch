/**
 * orderHeading: the confirm-modal heading for an Open-tab order, classified against the
 * account's open position (reduce / exact close / close and open the rest / open).
 */
import { describe, expect, it } from "vitest";
import { orderEffect, orderHeading } from "@/lib/trading";

describe("orderHeading", () => {
  it.each([
    ["short", 5n, 0n, "Opening Short Position"],
    ["long", 5n, 0n, "Opening Long Position"],
    ["long", 5n, 10n, "Opening Long Position"],   // same side: an add still opens
    ["short", 5n, 10n, "Reducing Long Position"],
    ["short", 10n, 10n, "Closing Long Position"],
    ["short", 15n, 10n, "Closing Long, Opening Short"],
    ["long", 5n, -10n, "Reducing Short Position"],
    ["long", 10n, -10n, "Closing Short Position"],
    ["long", 15n, -10n, "Closing Short, Opening Long"],
  ] as const)("%s %s against %s", (dir, size, existing, want) => {
    expect(orderHeading(dir, size, existing)).toBe(want);
  });
});

describe("orderEffect (the ticket's result line uses the same rule as the heading)", () => {
  it.each([
    ["short", 5n, 0n, "open"],
    ["long", 5n, 10n, "open"],
    ["short", 5n, 10n, "reduce"],
    ["short", 10n, 10n, "close"],
    ["short", 15n, 10n, "flip"],
    ["long", 5n, -10n, "reduce"],
    ["long", 10n, -10n, "close"],
    ["long", 15n, -10n, "flip"],
  ] as const)("%s %s against %s", (dir, size, existing, want) => {
    expect(orderEffect(dir, size, existing)).toBe(want);
  });
});
