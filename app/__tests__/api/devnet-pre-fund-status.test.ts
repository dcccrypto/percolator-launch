/**
 * GET /api/devnet-pre-fund: read-only status for the create wizard (would the launch's top-up run for this wallet now,
 * would /faucet allow a claim). It must never reserve or spend a claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { PREFUND_WINDOW_MS } from "@/lib/prefund-requirement";

const gate = vi.hoisted(() => ({
  peekFaucetGate: vi.fn(),
  tryFaucetGate: vi.fn(),
  peekClaim: vi.fn(),
  reserveClaim: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ getServiceClient: () => ({}) }));
vi.mock("@/lib/faucet-rate-gate", () => ({
  peekFaucetGate: gate.peekFaucetGate,
  tryFaucetGate: gate.tryFaucetGate,
  releaseFaucetClaim: vi.fn(),
  FaucetGateUnavailableError: class extends Error {},
  FaucetGateReadError: class extends Error { constructor(m: string) { super(m); this.name = "FaucetGateReadError"; } },
}));
vi.mock("@/lib/prefund-claim-store", () => ({
  peekClaim: gate.peekClaim,
  reserveClaim: gate.reserveClaim,
  releaseClaim: vi.fn(),
  PREFUND_CLAIM_TTL_MS: 1,
}));

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const MINT = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";
const env = { ...process.env };

async function get(qs: string) {
  vi.resetModules();
  const { GET } = await import("@/app/api/devnet-pre-fund/route");
  return GET(new NextRequest(`http://localhost/api/devnet-pre-fund?${qs}`));
}

describe("GET /api/devnet-pre-fund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    process.env.DEVNET_MINT_AUTHORITY_KEYPAIR = "[1]";
  });
  afterEach(() => { process.env = { ...env }; });

  it("available when neither gate holds a claim", async () => {
    gate.peekFaucetGate.mockResolvedValue({ limited: false, nextClaimAt: null });
    const body = await (await get(`walletAddress=${WALLET}&mintAddress=${MINT}`)).json();
    expect(body).toEqual({ known: true, preFund: { available: true, nextClaimAt: null }, faucet: { available: true, nextClaimAt: null } });
  });

  it("inside the 1 h window: unavailable with the next time; the faucet answer is separate", async () => {
    gate.peekFaucetGate
      .mockResolvedValueOnce({ limited: true, nextClaimAt: "2099-01-01T00:00:00.000Z" })
      .mockResolvedValueOnce({ limited: true, nextClaimAt: "2099-01-02T00:00:00.000Z" });
    const body = await (await get(`walletAddress=${WALLET}&mintAddress=${MINT}`)).json();
    expect(body.preFund).toEqual({ available: false, nextClaimAt: "2099-01-01T00:00:00.000Z" });
    expect(body.faucet.available).toBe(false);
  });

  it("never reserves or spends a claim", async () => {
    gate.peekFaucetGate.mockResolvedValue({ limited: false, nextClaimAt: null });
    await get(`walletAddress=${WALLET}&mintAddress=${MINT}`);
    expect(gate.tryFaucetGate).not.toHaveBeenCalled();
    expect(gate.reserveClaim).not.toHaveBeenCalled();
  });

  it("falls back to the durable claim store when the table can't be read", async () => {
    gate.peekFaucetGate.mockRejectedValue(new Error("no table"));
    gate.peekClaim.mockResolvedValue({ limited: true, nextClaimAt: "2099-01-01T00:00:00.000Z" });
    const body = await (await get(`walletAddress=${WALLET}&mintAddress=${MINT}`)).json();
    expect(body.preFund.available).toBe(false);
    expect(body.faucet).toBeNull();
  });

  it("no mint key configured: the top-up is unavailable (disabled)", async () => {
    delete process.env.DEVNET_MINT_AUTHORITY_KEYPAIR;
    const body = await (await get(`walletAddress=${WALLET}&mintAddress=${MINT}`)).json();
    expect(body.preFund.available).toBe(false);
    expect(body.preFund.reason).toBe("disabled");
  });

  it("not devnet: 403; bad addresses: 400", async () => {
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "mainnet-beta";
    expect((await get(`walletAddress=${WALLET}&mintAddress=${MINT}`)).status).toBe(403);
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
    expect((await get(`walletAddress=nope&mintAddress=${MINT}`)).status).toBe(400);
  });

  it("asks the gates with the POST's own arguments: the pre-fund key, the 1 h window, and the Blob fallback key (review of #3818: m11, m15)", async () => {
    gate.peekFaucetGate.mockResolvedValue({ limited: false, nextClaimAt: null });
    await get(`walletAddress=${WALLET}&mintAddress=${MINT}`);
    expect(PREFUND_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(gate.peekFaucetGate).toHaveBeenNthCalledWith(1, expect.anything(), WALLET, `devnet-pre-fund:${MINT}`, PREFUND_WINDOW_MS);
    expect(gate.peekFaucetGate).toHaveBeenNthCalledWith(2, expect.anything(), WALLET, "usdc");
    gate.peekFaucetGate.mockRejectedValue(new Error("no table"));
    gate.peekClaim.mockResolvedValue({ limited: false, nextClaimAt: null });
    await get(`walletAddress=${WALLET}&mintAddress=${MINT}`);
    expect(gate.peekClaim).toHaveBeenCalledWith(`${WALLET}:devnet-pre-fund:${MINT}`);
  });

  it("a read error that is not a schema error is 'unknown' ({known:false}), never 'available' from the Blob store (the POST refuses on it)", async () => {
    gate.peekFaucetGate.mockRejectedValue(Object.assign(new Error("faucet_claims could not be read (57014)"), { name: "FaucetGateReadError" }));
    gate.peekClaim.mockResolvedValue({ limited: false, nextClaimAt: null }); // an empty Blob store would say "available"
    const res = await get(`walletAddress=${WALLET}&mintAddress=${MINT}`);
    expect(await res.json()).toEqual({ known: false });
    expect(gate.peekClaim).not.toHaveBeenCalled();
  });

  it("the 400 for a bad address is not cacheable", async () => {
    const res = await get(`walletAddress=nope&mintAddress=${MINT}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
