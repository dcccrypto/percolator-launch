// @vitest-environment node
/**
 * The Earn exit harvest (tag 78) must not fail open: a failed market-tails read (429, timeout) used to fall back to the
 * PLAIN harvest, which a market with a vault-LP ext / bond tranche refuses. A failed read now throws a calm
 * UserFacingError; a genuine "no tails" answer still builds the plain ix.
 */
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildHarvestIx } from "@/hooks/useEarnExitV22";
import { UserFacingError } from "@/lib/errorMessages";
import { __setTailsClockForTest } from "@/lib/v22/market-tails";

const pk = () => PublicKey.unique();
const [programId, cranker, market, lpPortfolio] = [pk(), pk(), pk(), pk()];

beforeEach(() => __setTailsClockForTest(null));

describe("buildHarvestIx tails read", () => {
  it("throws a UserFacingError (no short-keyed ix) when the tails read fails", async () => {
    const conn = { getMultipleAccountsInfo: vi.fn().mockRejectedValue(new Error("429 Too Many Requests")) };
    const p = buildHarvestIx(conn, programId, cranker, market, 0, lpPortfolio);
    await expect(p).rejects.toBeInstanceOf(UserFacingError);
    await expect(p).rejects.not.toThrow(/429/);
  });

  it("control: tails genuinely absent still returns the plain harvest ix", async () => {
    const conn = { getMultipleAccountsInfo: vi.fn().mockResolvedValue([null, null, null]) };
    const ix = await buildHarvestIx(conn, programId, cranker, market, 0, lpPortfolio);
    expect(ix).not.toBeNull();
    expect(ix!.data[0]).toBe(78);
  });
});
