// @vitest-environment node
/**
 * S3-C7 (fix-all 2026-10-18): the LEGACY (partial-tx) branch of /api/playground/keeper-cosign
 * had no per-route limit (only the v1 branch was bounded). Harness copied from
 * keeper-cosign-fresh-market.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { encodeConfigureAuthMark, encodeUpdateAssetAuthority, ASSET_AUTH_KIND } from "@percolatorct/sdk";

const state = vi.hoisted(() => ({
  keeper: null as import("@solana/web3.js").Keypair | null,
  partialSign: vi.fn(),
  liveMarketId: 7n,
  liveSeqs: { oracleObservation: 4n, authorityEpoch: 3n },
}));

vi.mock("@/lib/config", () => ({
  getRpcEndpoint: vi.fn(() => "http://127.0.0.1:8899"),
  getNetwork: vi.fn(() => "devnet"), // getServerConnection() picks the cluster with it
  getConfig: vi.fn(() => ({ programId: "11111111111111111111111111111111" })),
}));

vi.mock("@/lib/playground-keeper-signer", () => ({
  requirePlaygroundKeeperSigner: () => {
    if (!state.keeper) throw new Error("Test keeper was not initialized");
    return { publicKey: () => state.keeper!.publicKey.toBase58(), partialSign: state.partialSign };
  },
}));

// Controlled "live state" for the existing-slab case.
vi.mock("@/lib/v18-wire", () => ({
  readAssetMarketId: vi.fn(() => state.liveMarketId),
  readAssetControlSeqs: vi.fn(() => state.liveSeqs),
}));

const NOW_SLOT = 123456;
const PRICE_E6 = 1_000_000n;
const originalDefaultNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;

let POST: (request: NextRequest) => Promise<Response>;
let readers: typeof import("@/lib/v18-wire");

function cosignRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/playground/keeper-cosign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deployer: Keypair.generate().publicKey.toBase58(),
      slabAddress: Keypair.generate().publicKey.toBase58(),
      initialPriceE6: PRICE_E6.toString(),
      assetIndex: 0,
      ...body,
    }),
  });
}


describe("S3-C7 keeper-cosign legacy branch is rate limited", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    vi.spyOn(Connection.prototype, "getSlot");
    vi.spyOn(Connection.prototype, "getLatestBlockhash");
    vi.spyOn(Connection.prototype, "getAccountInfo");
    ({ POST } = await import("@/app/api/playground/keeper-cosign/route"));
    readers = await import("@/lib/v18-wire");
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const rl = await import("@/lib/launch-single-tx/cosign-rate-limit");
    rl.resetCosignV1RateLimits();
    state.keeper = Keypair.generate();
    state.partialSign.mockImplementation((tx: Transaction) => tx.partialSign(state.keeper!));
    vi.mocked(Connection.prototype.getSlot).mockResolvedValue(NOW_SLOT);
    vi.mocked(Connection.prototype.getLatestBlockhash).mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999_999,
    });
    vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValue(null);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    if (originalDefaultNetwork === undefined) delete process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
    else process.env.NEXT_PUBLIC_DEFAULT_NETWORK = originalDefaultNetwork;
  });

  it("one deployer: the 13th legacy request in a minute is 429 and costs no RPC read or signature", async () => {
    const deployer = Keypair.generate().publicKey.toBase58();
    const statuses: number[] = [];
    for (let i = 0; i < 13; i++) statuses.push((await POST(cosignRequest({ fresh: true, deployer }))).status);
    expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(statuses[12]).toBe(429);
    expect(Connection.prototype.getSlot).toHaveBeenCalledTimes(12);
    expect(state.partialSign).toHaveBeenCalledTimes(12);
  });

  it("one IP rotating deployers: the 31st legacy request in a minute is 429", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await POST(cosignRequest({ fresh: true }))).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
