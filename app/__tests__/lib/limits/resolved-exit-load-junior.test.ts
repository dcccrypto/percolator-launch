// @vitest-environment node
/**
 * The resolved-exit snapshot tells the planner when its fee payer is the vault's junior owner (the program admits the
 * junior owner's 101 inside the owner window), so "Finish now" and the creator-stake panel need not wait about 24 h.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, type PublicKey } from "@solana/web3.js";
import { MARKET_MODE_RESOLVED } from "@/lib/limits/constants";

const h = vi.hoisted(() => ({ planIn: null as null | { juniorOwnerPays?: boolean }, junior: "" }));
vi.mock("@/lib/limits/decode", async (orig) => ({
  ...(await orig<object>()),
  decodeResolvedMarket: () => ({ mode: MARKET_MODE_RESOLVED }),
  decodeMarketEngineView: () => null,
  decodeTerminalBacking: () => null,
  decodeLpVaultRegistryBound: () => true,
  decodeLpVaultRegistryDomain: () => 0,
  decodeVaultLpState: () => ({ juniorOwner: h.junior, lpPortfolio: Keypair.generate().publicKey.toBase58() }),
}));
vi.mock("@/lib/limits/resolved-exit", async (orig) => ({
  ...(await orig<object>()),
  planResolvedExit: (i: { juniorOwnerPays?: boolean }) => {
    h.planIn = i;
    return { phase: "owner-window", untilSlot: 1n, steps: [], blockers: [] };
  },
}));

import { loadResolvedExitSnapshot } from "@/lib/limits/resolved-exit-load";

const k = () => Keypair.generate().publicKey;
const programId = k();
const connection = {
  getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(64), owner: programId, lamports: 1, executable: false })),
  getSlot: vi.fn(async () => 100),
  getProgramAccounts: vi.fn(async () => []),
} as unknown as import("@solana/web3.js").Connection;
const load = (payer: PublicKey | null) => loadResolvedExitSnapshot({ connection, programId, market: k(), collateralMint: k(), payer });

beforeEach(() => {
  h.planIn = null;
});

describe("juniorOwnerPays", () => {
  it("the payer is the junior owner: true", async () => {
    const junior = k();
    h.junior = junior.toBase58();
    await load(junior);
    expect(h.planIn?.juniorOwnerPays).toBe(true);
  });
  it("CONTROL any other payer, or none (read-only): false", async () => {
    h.junior = k().toBase58();
    await load(k());
    expect(h.planIn?.juniorOwnerPays).toBe(false);
    await load(null);
    expect(h.planIn?.juniorOwnerPays).toBe(false);
  });
});
