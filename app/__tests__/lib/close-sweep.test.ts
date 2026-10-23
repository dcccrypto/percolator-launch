import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const parse = vi.hoisted(() => vi.fn());
// close-sweep decodes through lib/v22/layout (flag off it delegates to the SDK parsePortfolioV17, flag on it is VERSION-keyed): stub that seam.
vi.mock("@/lib/v22/layout", () => ({ parsePortfolio: parse }));
vi.mock("@percolatorct/sdk", () => ({ parsePortfolioV17: parse }));
import { readSweepableCapital } from "@/lib/close-sweep";

const OWNER = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const OTHER = new PublicKey("11111111111111111111111111111111");
const pf = (active: boolean, capital: bigint, owner = OWNER) => ({ owner, capital, legs: [{ active }, { active: false }] });
const fast = { sleep: async () => {}, attempts: 4 };

describe("readSweepableCapital (close -> wallet)", () => {
  it("waits out a stale pre-close read, then returns the post-close capital", async () => {
    parse.mockReset().mockReturnValueOnce(pf(true, 700n)).mockReturnValueOnce(pf(false, 512_345_678n));
    const read = vi.fn().mockResolvedValue(new Uint8Array(1));
    expect(await readSweepableCapital({ owner: OWNER, read, ...fast })).toBe(512_345_678n);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("a leg still open after every retry: nothing is swept", async () => {
    parse.mockReset().mockReturnValue(pf(true, 9n));
    expect(await readSweepableCapital({ owner: OWNER, read: async () => new Uint8Array(1), ...fast })).toBeNull();
  });
  it("not the wallet's portfolio / zero capital / no portfolio: nothing is swept", async () => {
    parse.mockReset().mockReturnValue(pf(false, 5n, OTHER));
    expect(await readSweepableCapital({ owner: OWNER, read: async () => new Uint8Array(1), ...fast })).toBeNull();
    parse.mockReset().mockReturnValue(pf(false, 0n));
    expect(await readSweepableCapital({ owner: OWNER, read: async () => new Uint8Array(1), ...fast })).toBeNull();
    expect(await readSweepableCapital({ owner: OWNER, read: async () => null, ...fast })).toBeNull();
  });
  it("an RPC error is retried, never read as zero", async () => {
    parse.mockReset().mockReturnValue(pf(false, 42n));
    const read = vi.fn().mockRejectedValueOnce(new Error("429")).mockResolvedValue(new Uint8Array(1));
    expect(await readSweepableCapital({ owner: OWNER, read, ...fast })).toBe(42n);
  });
});
