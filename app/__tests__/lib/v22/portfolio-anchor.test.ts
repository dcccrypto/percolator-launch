/** M7 (N-4/L-1): the trade book's anchor is read at the fill's slot and owner-checked; unknown stays unknown. */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ parsePortfolio: vi.fn() }));
vi.mock("@/lib/v22/layout", async (orig) => ({ ...(await orig<object>()), parsePortfolio: mocks.parsePortfolio }));

import { readMatcherSequence } from "@/lib/v22/portfolio-anchor";

const PROG = new PublicKey("5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe");
const PF = new PublicKey("5dsrhZiXunvXcFbCzdJ9Qg5Lv3eX4SGyaBA6NZ3SaoKh");

describe("readMatcherSequence", () => {
  it("reads with minContextSlot = the fill's slot and returns the sequence", async () => {
    mocks.parsePortfolio.mockReturnValue({ matcherSequence: 7n });
    const getAccountInfo = vi.fn().mockResolvedValue({ owner: PROG, data: new Uint8Array(4) });
    expect(await readMatcherSequence({ getAccountInfo } as never, PF, PROG, 123)).toBe(7n);
    expect(getAccountInfo).toHaveBeenCalledWith(PF, { commitment: "confirmed", minContextSlot: 123 });
  });
  it("NEGATIVE: no slot, a foreign owner, a node behind the slot (throws) or an undecodable sequence: unknown (null)", async () => {
    mocks.parsePortfolio.mockReturnValue({ matcherSequence: 7n });
    expect(await readMatcherSequence({ getAccountInfo: vi.fn() } as never, PF, PROG, undefined)).toBeNull();
    expect(await readMatcherSequence({ getAccountInfo: vi.fn().mockResolvedValue({ owner: PF, data: new Uint8Array(4) }) } as never, PF, PROG, 1)).toBeNull();
    expect(await readMatcherSequence({ getAccountInfo: vi.fn().mockRejectedValue(new Error("min context slot not reached")) } as never, PF, PROG, 1)).toBeNull();
    mocks.parsePortfolio.mockReturnValue({});
    expect(await readMatcherSequence({ getAccountInfo: vi.fn().mockResolvedValue({ owner: PROG, data: new Uint8Array(4) }) } as never, PF, PROG, 1)).toBeNull();
  });
});
