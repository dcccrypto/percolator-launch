// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { portfolioAccountLen, portfolioScanFilters } from "@/lib/v22/layout";
import { blankPortfolio } from "../helpers/v22-fixtures";

const { GOOD_SLAB, BAD_SLAB, GOOD_LP } = vi.hoisted(() => ({
  GOOD_SLAB: "11111111111111111111111111111112",
  BAD_SLAB: "11111111111111111111111111111113",
  GOOD_LP: "11111111111111111111111111111114",
}));

vi.mock("@/lib/playground-slab-meta", () => ({
  PLAYGROUND_SLAB_META: {
    [GOOD_SLAB]: { lp_portfolio_address: GOOD_LP },
    [BAD_SLAB]: { lp_portfolio_address: "not-a-base58-pubkey!!" },
  },
}));

import { getKnownMarketLpCapitals, scanEnabledMarketLpCapitals, discoverMarketLpCapital } from "@/lib/lp-portfolio";

const PROGRAM = new PublicKey("ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB");
const CAPITAL_OFF = 148; // PF_BODY_OFF(116) + 32 in the SDK portfolio layout

function pf(capital: bigint): Buffer {
  const d = Buffer.from(blankPortfolio());
  d.writeBigUInt64LE(capital & 0xffffffffffffffffn, CAPITAL_OFF);
  d.writeBigUInt64LE(capital >> 64n, CAPITAL_OFF + 8);
  return d;
}

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

describe("lead 1: scan filter is layout-aware (v2.2 sizes)", () => {
  it("sends the v2.2 length (10,607) and VERSION 19 memcmp, not 9,563", async () => {
    const gpa = vi.fn().mockResolvedValue([]);
    await scanEnabledMarketLpCapitals({ getProgramAccounts: gpa } as never, PROGRAM);
    const filters = gpa.mock.calls[0][1].filters as Array<Record<string, any>>;
    const size = filters.find((f) => "dataSize" in f)!.dataSize;
    expect(size).toBe(portfolioAccountLen());
    expect(size).toBe(10_607);
    expect(size).not.toBe(9_563);
    expect(filters.some((f) => f.memcmp?.offset === 8)).toBe(true);
    expect(portfolioScanFilters().dataSize).toBe(size);
  });
});

describe("lead 3: readCapitalSafe is VERSION-aware", () => {
  it("returns the capital of a v2.2 portfolio", async () => {
    const infos = [{ data: pf(123_456_789n), owner: PROGRAM }];
    const conn = { getMultipleAccountsInfo: vi.fn().mockResolvedValue(infos) };
    const out = await getKnownMarketLpCapitals(conn as never, [GOOD_SLAB]);
    expect(out.get(GOOD_SLAB)).toBe(123_456_789n);
  });
  it("a wrong-length / garbage account yields no capital, not a wrong one", async () => {
    const conn = { getMultipleAccountsInfo: vi.fn().mockResolvedValue([{ data: Buffer.alloc(9_563), owner: PROGRAM }]) };
    const out = await getKnownMarketLpCapitals(conn as never, [GOOD_SLAB]);
    expect(out.has(GOOD_SLAB)).toBe(false);
  });
});

describe("lead 2: one bad curated address must not drop every market", () => {
  it("still returns the good market's capital", async () => {
    const conn = { getMultipleAccountsInfo: vi.fn().mockResolvedValue([{ data: pf(42n), owner: PROGRAM }]) };
    const out = await getKnownMarketLpCapitals(conn as never, [BAD_SLAB, GOOD_SLAB]);
    expect(out.get(GOOD_SLAB)).toBe(42n);
    expect(out.has(BAD_SLAB)).toBe(false);
  });
});

describe("lead 4: RPC failure vs no LP", () => {
  it("documents current behaviour: both yield empty/null (indistinguishable)", async () => {
    const failing = { getProgramAccounts: vi.fn().mockRejectedValue(new Error("429")) };
    const empty = { getProgramAccounts: vi.fn().mockResolvedValue([]) };
    expect((await scanEnabledMarketLpCapitals(failing as never, PROGRAM)).size).toBe(0);
    expect((await scanEnabledMarketLpCapitals(empty as never, PROGRAM)).size).toBe(0);
    expect(await discoverMarketLpCapital(failing as never, PROGRAM, Keypair.generate().publicKey)).toBeNull();
  });
});
