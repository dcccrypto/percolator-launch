// @vitest-environment node
/**
 * #3602: the resolved-exit snapshot carries the v2.2 market tails on its instruction context, read once per snapshot.
 * Flag off it makes no extra read and the context has no `tails` (the instruction lists stay byte-identical); a failed
 * read leaves no tails (the step is refused as before, never sent with a guess).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { MARKET_MODE_RESOLVED } from "@/lib/limits/constants";

const h = vi.hoisted(() => ({ fetchTails: vi.fn() }));
vi.mock("@/lib/limits/decode", async (orig) => ({
  ...(await orig<object>()),
  decodeResolvedMarket: () => ({ mode: MARKET_MODE_RESOLVED }),
  decodeMarketEngineView: () => null,
  decodeTerminalBacking: () => null,
}));
vi.mock("@/lib/limits/resolved-exit", async (orig) => ({
  ...(await orig<object>()),
  planResolvedExit: () => ({ phase: "sweep", steps: [], blockers: [] }),
}));
vi.mock("@/lib/v22/market-tails", async (orig) => ({ ...(await orig<object>()), fetchMarketTailsV22: (...a: unknown[]) => h.fetchTails(...a) }));

import { loadResolvedExitSnapshot } from "@/lib/limits/resolved-exit-load";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const k = () => Keypair.generate().publicKey;
const TAILS = { bondTranche: k(), insuranceUnits: k(), vaultLpExt: null };
const connection = {
  getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(64), owner: k(), lamports: 1, executable: false })),
  getSlot: vi.fn(async () => 100),
  getProgramAccounts: vi.fn(async () => []),
} as unknown as import("@solana/web3.js").Connection;
const load = () => loadResolvedExitSnapshot({ connection, programId: k(), market: k(), collateralMint: k(), payer: k() });

beforeEach(() => {
  h.fetchTails.mockReset();
  h.fetchTails.mockResolvedValue(TAILS);
});
afterEach(() => __setDevnetV22ForTest(null));

describe("#3602: the resolved-exit snapshot and the v2.2 market tails", () => {
  it("flag on: one tails read, and the context carries them", async () => {
    __setDevnetV22ForTest(true);
    const s = await load();
    expect(h.fetchTails).toHaveBeenCalledTimes(1);
    expect(s?.ctx?.tails).toBe(TAILS);
  });
  it("flag on, the read fails: no tails, the snapshot still loads", async () => {
    __setDevnetV22ForTest(true);
    h.fetchTails.mockRejectedValue(new Error("429"));
    const s = await load();
    expect(s?.ctx).toBeTruthy();
    expect(s?.ctx && "tails" in s.ctx).toBe(false);
  });
  it("CONTROL flag off: no tails read, no tails key", async () => {
    __setDevnetV22ForTest(false);
    const s = await load();
    expect(h.fetchTails).not.toHaveBeenCalled();
    expect(s?.ctx && "tails" in s.ctx).toBe(false);
  });
});
