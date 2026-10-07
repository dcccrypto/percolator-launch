/**
 * #3266: an unfinished launch presents as what it is, not as a market called "UNKNOWN", and the
 * removable / committed decision comes from the chain facts the close actually depends on.
 */
import { describe, expect, it } from "vitest";
import { resolveIdentity, sawPlaceholderTicker } from "@/lib/bulk-identity";
import { closeMarketChecklist, firstUnmet } from "@/lib/close-market-checklist";
import {
  classifyLaunchStage,
  isPlaceholderTicker,
  LAUNCH_UNFINISHED_TITLE,
  launchRowTitle,
  readLaunchFootprint,
  savedLaunchIdentity,
  UNFINISHED_COPY,
  unfinishedStageCopy,
  UNNAMED_MARKET_TITLE,
} from "@/lib/unfinished-launch";

describe("the indexer placeholder is no ticker", () => {
  it("resolveIdentity drops UNKNOWN even when it is first in precedence (detail beats cache)", () => {
    const detail = { symbol: "UNKNOWN", name: "Market AbCdEfGh" };
    const cache = { symbol: "AUTON", name: "auton" };
    expect(resolveIdentity(detail, cache).symbol).toBe("AUTON");
    // with nothing better, the ticker is absent rather than "UNKNOWN"
    expect(resolveIdentity(detail).symbol).toBeNull();
  });
  it("recognises it case- and padding-insensitively, and nothing else", () => {
    expect(isPlaceholderTicker("UNKNOWN")).toBe(true);
    expect(isPlaceholderTicker(" unknown ")).toBe(true);
    expect(isPlaceholderTicker("UNKNOWNCOIN")).toBe(false);
    expect(isPlaceholderTicker("SOL")).toBe(false);
    expect(isPlaceholderTicker(null)).toBe(false);
  });
  it("sawPlaceholderTicker says identity loaded and knows nothing", () => {
    expect(sawPlaceholderTicker({ symbol: "UNKNOWN" }, null)).toBe(true);
    expect(sawPlaceholderTicker(null, undefined, { symbol: "SOL" })).toBe(false);
  });
});

describe("the row's name", () => {
  const base = { symbol: null, unfinished: false, sawPlaceholder: false, fallbackLabel: "USDC" };
  it("a real ticker is always the name", () => {
    expect(launchRowTitle({ ...base, symbol: "AUTON", unfinished: true })).toBe("AUTON");
  });
  it("an unfinished launch with no known ticker says so, never the collateral symbol or UNKNOWN", () => {
    expect(launchRowTitle({ ...base, unfinished: true, sawPlaceholder: true })).toBe(LAUNCH_UNFINISHED_TITLE);
    expect(launchRowTitle({ ...base, unfinished: true })).toBe(LAUNCH_UNFINISHED_TITLE);
  });
  it("a finished market still on the placeholder never registered: Unnamed market", () => {
    expect(launchRowTitle({ ...base, sawPlaceholder: true })).toBe(UNNAMED_MARKET_TITLE);
  });
  it("while identity is still loading, the fallback label", () => {
    expect(launchRowTitle(base)).toBe("USDC");
  });
});

describe("what the launch stopped at (chain facts the close depends on)", () => {
  const fp = (o: Partial<{ mode: number; cTot: bigint; portfolios: bigint }> = {}) => ({ mode: 0, cTot: 0n, portfolios: 0n, ...o });
  it("created only / oracle handed off (no portfolio, no funds): removable", () => {
    expect(classifyLaunchStage(fp(), 0n)).toEqual({ kind: "removable" });
  });
  it("LP initialised (portfolio, nothing deposited): committed, not funded", () => {
    expect(classifyLaunchStage(fp({ portfolios: 1n }), 0n)).toEqual({ kind: "committed", funded: false });
  });
  it("funded (LP deposit and/or insurance): committed, funded", () => {
    expect(classifyLaunchStage(fp({ portfolios: 1n, cTot: 5n }), 0n)).toEqual({ kind: "committed", funded: true });
    expect(classifyLaunchStage(fp({ portfolios: 1n }), 7n)).toEqual({ kind: "committed", funded: true });
  });
  it("vault created is funded by construction (step 4 follows the step-3 deposit)", () => {
    expect(classifyLaunchStage(fp({ portfolios: 2n, cTot: 1_000_000_000n }), 100n)).toEqual({ kind: "committed", funded: true });
  });
  it("nothing read yet: unknown, and no claim either way", () => {
    expect(classifyLaunchStage(null, 0n)).toEqual({ kind: "unknown" });
    expect(classifyLaunchStage(fp(), null)).toEqual({ kind: "unknown" });
  });
  it("copy: the funded case says it can't be removed and that funds are not lost; the removable case offers the rent", () => {
    expect(unfinishedStageCopy({ kind: "committed", funded: true })).toBe(UNFINISHED_COPY.committedFunded);
    expect(UNFINISHED_COPY.committedFunded).toMatch(/can't be removed/);
    expect(UNFINISHED_COPY.committedFunded).toMatch(/finish it from Create Market/);
    expect(unfinishedStageCopy({ kind: "removable" })).toMatch(/reclaim its rent/);
    // the unfunded-portfolio case must not claim funds went in
    expect(unfinishedStageCopy({ kind: "committed", funded: false })).not.toMatch(/funds went in/);
    // the unread case must not promise a removal
    expect(unfinishedStageCopy({ kind: "unknown" })).not.toMatch(/reclaim|removed/i);
  });
  it("readLaunchFootprint is null for bytes too short to be a market (never a guess)", () => {
    expect(readLaunchFootprint(new Uint8Array(10))).toBeNull();
  });
});

describe("the close checklist's insurance line", () => {
  const unmet = (unfinished?: boolean) =>
    firstUnmet(closeMarketChecklist({ claimableFeeAtoms: 0n, otherOpenAccounts: 0, insuranceAtoms: 9n, unfinished }))?.unmetLine;
  it("a finished market keeps the drain-it line", () => {
    expect(unmet(false)).toBe("The market's insurance fund still holds funds.");
    expect(unmet(undefined)).toBe("The market's insurance fund still holds funds.");
  });
  it("an unfinished launch is told to finish it, not left at a dead end", () => {
    expect(unmet(true)).toBe(UNFINISHED_COPY.insuranceBlocked);
  });
});

describe("what the launching browser knows about the token", () => {
  const SLAB = "SlabAddr1";
  const store = (o: Record<string, string>) => ({ getItem: (k: string) => o[k] ?? null });
  it("reads symbol + name from the saved registration payload", () => {
    const s = store({ [`perc.keeperPayload.${SLAB}`]: JSON.stringify({ symbol: "AUTON", name: "auton" }) });
    expect(savedLaunchIdentity(SLAB, s)).toEqual({ symbol: "AUTON", name: "auton" });
  });
  it("falls back to the saved request's symbol", () => {
    const s = store({ [`perc.keeperRequest.${SLAB}`]: JSON.stringify({ slabAddress: SLAB, symbol: "BP" }) });
    expect(savedLaunchIdentity(SLAB, s)).toEqual({ symbol: "BP", name: null });
  });
  it("another slab's record, the placeholder, junk JSON and a missing store all read as nothing", () => {
    expect(savedLaunchIdentity(SLAB, store({ "perc.keeperPayload.Other": JSON.stringify({ symbol: "X" }) }))).toBeNull();
    expect(savedLaunchIdentity(SLAB, store({ [`perc.keeperPayload.${SLAB}`]: JSON.stringify({ symbol: "UNKNOWN" }) }))).toBeNull();
    expect(savedLaunchIdentity(SLAB, store({ [`perc.keeperPayload.${SLAB}`]: "{not json" }))).toBeNull();
    expect(savedLaunchIdentity(SLAB, null)).toBeNull();
  });
});
