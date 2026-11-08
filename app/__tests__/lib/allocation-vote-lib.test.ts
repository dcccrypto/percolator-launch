/**
 * Pure helpers behind /allocation and /vote: exact-host match, surface path
 * match, owner-address validation (ported from the local checker), and the
 * exact BigInt allocation math (ported, parameterized: no figures baked in).
 */
import { describe, it, expect } from "vitest";
import { allocationVotePreviewHost, isAllocationVoteHost, isAllocationVoteSurface } from "@/lib/allocation-vote/host";
import { validateOwner } from "@/lib/allocation-vote/owner";
import { roundRational, allocateAll } from "@/lib/allocation-vote/math";

describe("isAllocationVoteHost: exact percolator.trade only", () => {
  it.each(["percolator.trade", "PERCOLATOR.TRADE", "percolator.trade:443", "percolator.trade:3000"])("accepts %s", (h) => {
    expect(isAllocationVoteHost(h)).toBe(true);
  });
  it.each([
    "", null, undefined, "www.percolator.trade", "play.percolator.trade", "mainnet.percolatorlaunch.com",
    "percolatorlaunch.com", "percolator-launch.vercel.app", "localhost", "127.0.0.1",
    "evilpercolator.trade", "percolator.trade.evil.com", "percolator.trade.", "percolator.trade:", "percolator.trade:evil",
    "percolator.trade:443:1", " percolator.trade", "percolator.trade ", "percolator.trade,evil.com", "user@percolator.trade",
  ])("rejects %j", (h) => {
    expect(isAllocationVoteHost(h as string)).toBe(false);
  });
});

describe("preview-only exact host allowance (deployed-preview E2E)", () => {
  const P = "perc-vote-e2e-1108.vercel.app";
  const on = { VERCEL_ENV: "preview", ALLOCATION_VOTE_PREVIEW_HOST: P };

  it("accepts exactly the configured host on a Vercel preview", () => {
    expect(allocationVotePreviewHost(on)).toBe(P);
    expect(isAllocationVoteHost(P, on)).toBe(true);
    expect(isAllocationVoteHost("percolator.trade", on)).toBe(true);
  });

  it.each([
    { VERCEL_ENV: "production", ALLOCATION_VOTE_PREVIEW_HOST: P },
    { VERCEL_ENV: "development", ALLOCATION_VOTE_PREVIEW_HOST: P },
    { VERCEL_ENV: "Preview", ALLOCATION_VOTE_PREVIEW_HOST: P },
    { VERCEL_ENV: " preview", ALLOCATION_VOTE_PREVIEW_HOST: P },
    { ALLOCATION_VOTE_PREVIEW_HOST: P },
    { VERCEL_ENV: "preview" },
    {},
  ])("never honoured outside VERCEL_ENV=preview with an explicit host: %j", (env) => {
    expect(allocationVotePreviewHost(env)).toBeNull();
    expect(isAllocationVoteHost(P, env)).toBe(false);
  });

  it.each([
    "", "*.vercel.app", ".vercel.app", "vercel.app", "a.b.vercel.app", "x.vercel.app.evil.com", "x.vercel.app.",
    "x.vercel.app:443", "X.vercel.app", "-x.vercel.app", "x-.vercel.app", " x.vercel.app", "x.vercel.app ",
    "percolator.trade", "mainnet.percolatorlaunch.com", "localhost", "127.0.0.1", "x.vercel.app,y.vercel.app",
    "x.vercel.app/evil", "user@x.vercel.app", `${"a".repeat(64)}.vercel.app`,
  ])("rejects malformed or non-preview configured value %j", (v) => {
    expect(allocationVotePreviewHost({ VERCEL_ENV: "preview", ALLOCATION_VOTE_PREVIEW_HOST: v })).toBeNull();
  });

  it.each([
    "other.vercel.app", "PERC-VOTE-E2E-1108.vercel.app", `${P}:443`, `${P}.`, ` ${P}`, `${P} `, `x${P}`, `${P}.evil.com`,
    `evil.${P}`, "percolator-launch.vercel.app", "mainnet.percolatorlaunch.com", "localhost", "", null, undefined,
  ])("only the exact configured host matches, not %j", (h) => {
    expect(isAllocationVoteHost(h as string, on)).toBe(false);
  });

  it("an unset or malformed value leaves the production-only lock exactly as before", () => {
    for (const env of [{}, { VERCEL_ENV: "preview", ALLOCATION_VOTE_PREVIEW_HOST: "*.vercel.app" }]) {
      expect(isAllocationVoteHost("percolator.trade", env)).toBe(true);
      expect(isAllocationVoteHost("percolator-launch-git-x-team.vercel.app", env)).toBe(false);
      expect(isAllocationVoteHost("mainnet.percolatorlaunch.com", env)).toBe(false);
    }
  });
});

describe("isAllocationVoteSurface", () => {
  it.each([
    "/allocation", "/allocation/", "/allocation/x", "/vote", "/vote/", "/vote/x/y",
    "/api/allocation", "/api/allocation/check", "/api/vote", "/api/vote/submit",
    "/VOTE", "/Allocation", "/%61llocation", "/%76ote", "//vote", "/api//vote/status", "/vote.rsc", "/allocation.txt",
  ])("%s is a surface", (p) => {
    expect(isAllocationVoteSurface(p)).toBe(true);
  });
  it.each(["/", "/waitlist", "/allocations", "/allocationx", "/voter", "/votes", "/vote-now", "/api/votes", "/api/markets", "/x/vote", "/%zz"])(
    "%s is not",
    (p) => {
      expect(isAllocationVoteSurface(p)).toBe(false);
    },
  );
});

describe("validateOwner (ported strict base58, 32-byte, canonical)", () => {
  it("accepts a canonical 32-byte key and trims", () => {
    expect(validateOwner("  11111111111111111111111111111111 ")).toEqual({ ok: true, owner: "11111111111111111111111111111111" });
  });
  it.each([
    [123, "type"], ["", "empty"], ["   ", "empty"], ["0".repeat(32), "charset"], ["1".repeat(31), "length"],
    ["1".repeat(45), "length"], ["x".repeat(300), "length"], ["z".repeat(44), "decoded_length"],
    ["1".repeat(33), "decoded_length"],
  ])("%j → %s", (input, reason) => {
    const r = validateOwner(input);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe(reason);
  });
});

describe("roundRational (exact)", () => {
  it.each([
    [1n, 3n, 2, "floor", "0.33"], [2n, 3n, 2, "floor", "0.66"], [2n, 3n, 2, "half_up", "0.67"],
    [1n, 8n, 2, "half_up", "0.13"], [1n, 8n, 2, "half_even", "0.12"], [3n, 8n, 2, "half_even", "0.38"],
    [5n, 1n, 0, "floor", "5"], [0n, 7n, 3, "half_up", "0.000"],
  ] as const)("%s/%s @%sdp %s = %s", (n, d, dec, mode, out) => {
    expect(roundRational(n, d, dec, mode)).toBe(out);
  });
  it("rejects bad inputs", () => {
    expect(() => roundRational(1n, 0n, 2, "floor")).toThrow(RangeError);
    expect(() => roundRational(-1n, 1n, 2, "floor")).toThrow(RangeError);
    expect(() => roundRational(1n, 1n, 2, "nope" as never)).toThrow(RangeError);
  });
});

describe("allocateAll: largest remainder reconciles rounded totals exactly", () => {
  const Q = [{ key: "share", decimals: 2, total: 1n }, { key: "pct", decimals: 4, total: 15n }];
  const sum = (xs: string[]) => xs.reduce((a, s) => a + BigInt(s.replace(".", "")), 0n);

  it("three equal weights sum exactly (independent rounding would not)", () => {
    const raws = [1n, 1n, 1n];
    const out = allocateAll(raws, 3n, { mode: "largest_remainder" }, Q);
    expect(sum(out.map((r) => r.share))).toBe(100n);
    expect(sum(out.map((r) => r.pct))).toBe(150000n);
    expect(out.map((r) => r.share)).toEqual(["0.34", "0.33", "0.33"]); // row-order tie-break
    const floored = allocateAll(raws, 3n, { mode: "floor" }, Q);
    expect(sum(floored.map((r) => r.share))).toBe(99n);
  });

  it("owner_address_asc tie-break is code-point order (case-sensitive)", () => {
    const out = allocateAll([1n, 1n, 1n], 3n, { mode: "largest_remainder", tie_break: "owner_address_asc" }, Q, ["b", "B", "a"]);
    expect(out.map((r) => r.share)).toEqual(["0.33", "0.34", "0.33"]);
  });

  it("fails closed when raws do not sum to total", () => {
    expect(() => allocateAll([1n, 1n], 3n, { mode: "largest_remainder" }, Q)).toThrow(RangeError);
    expect(() => allocateAll([1n], 0n, { mode: "floor" }, Q)).toThrow(RangeError);
    expect(() => allocateAll([1n], 1n, { mode: "largest_remainder", tie_break: "owner_address_asc" }, Q)).toThrow(RangeError);
    expect(allocateAll([], 1n, { mode: "floor" }, Q)).toEqual([]);
  });
});
