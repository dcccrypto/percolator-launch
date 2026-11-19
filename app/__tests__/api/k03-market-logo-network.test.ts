// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => ({
    from: () => ({
      select: () => {
        const filters: Array<[string, string]> = [];

        return {
          eq(column: string, value: string) {
            filters.push([column, value]);
            return this;
          },
          async single() {
            const matches = mock.rows.filter(row =>
              filters.every(([column, value]) =>
                row[column] === value
              )
            );
            return matches.length === 1
              ? { data: matches[0], error: null }
              : { data: null, error: { code: "PGRST116" } };
          },
        };
      },
    }),
  }),
}));

import { GET, POST } from "@/app/api/markets/[slab]/logo/route";

const SLAB =
  "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV";

const dev = {
  slab_address: SLAB,
  network: "devnet",
  deployer: "alice",
  logo_url: "https://example.com/dev.png",
};

const main = {
  slab_address: SLAB,
  network: "mainnet",
  deployer: "bob",
  logo_url: "https://example.com/main.png",
};

function params() {
  return { params: Promise.resolve({ slab: SLAB }) };
}

async function getLogo() {
  return GET(
    new Request(`http://localhost/api/markets/${SLAB}/logo`) as never,
    params()
  );
}

async function postLogo() {
  return POST(
    new Request(`http://localhost/api/markets/${SLAB}/logo`, {
      method: "POST",
      body: new FormData(),
    }) as never,
    params()
  );
}

describe("K-03: market logo network isolation", () => {
  beforeEach(() => {
    mock.rows = [];
    delete process.env.ADMIN_API_SECRET;
  });

  it("CONTROL: GET devnet market succeeds", async () => {
    mock.rows = [dev];
    const res = await getLogo();
    expect(res.status).toBe(200);
    expect((await res.json()).logo_url).toBe(dev.logo_url);
  });

  it("RED: GET must not expose mainnet-only logo", async () => {
    mock.rows = [main];
    const res = await getLogo();
    expect(res.status).toBe(404);
  });

  it("RED: GET resolves devnet despite duplicate slab", async () => {
    mock.rows = [dev, main];
    const res = await getLogo();
    expect(res.status).toBe(200);
    expect((await res.json()).logo_url).toBe(dev.logo_url);
  });

  it("CONTROL: POST devnet reaches proof validation", async () => {
    mock.rows = [dev];
    const res = await postLogo();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Missing required fields/);
  });

  it("RED: POST must not resolve mainnet-only market", async () => {
    mock.rows = [main];
    const res = await postLogo();
    expect(res.status).toBe(404);
  });

  it("RED: POST resolves devnet despite duplicate slab", async () => {
    mock.rows = [dev, main];
    const res = await postLogo();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Missing required fields/);
  });
});

// K03_AUTHENTICATED_POST_NETWORK
// Valid signed requests; no storage upload or real network calls.
describe("K-03 authenticated POST network isolation", () => {
  beforeEach(() => {
    mock.rows = [];
    delete process.env.ADMIN_API_SECRET;
  });

  async function signedPost(
    rows: Array<Record<string, unknown>>,
  ) {
    const nacl = (await import("tweetnacl")).default;
    const { PublicKey } = await import("@solana/web3.js");

    // Deterministic test-only wallet. Never use in production.
    const seed = new Uint8Array(32).fill(17);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const deployer = new PublicKey(kp.publicKey).toBase58();

    mock.rows = rows.map(row => ({
      ...row,
      slab_address: SLAB,
      deployer,
    }));

    const minute = Math.floor(Date.now() / 60000);
    const message = Buffer.from(
      `market-logo:${SLAB}:${minute}`,
      "utf8",
    );

    const signature = Buffer.from(
      nacl.sign.detached(message, kp.secretKey),
    ).toString("base64");

    const form = new FormData();
    form.set("deployer", deployer);
    form.set("signature", signature);

    const request = new Request(
      `http://localhost/api/markets/${SLAB}/logo`,
      {
        method: "POST",
        body: form,
      },
    );

    return POST(request as never, params());
  }

  it("CONTROL: valid devnet owner reaches file validation", async () => {
    const res = await signedPost([dev]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No file provided/i);
  });

  it("RED: devnet request rejects a mainnet-only market", async () => {
    const res = await signedPost([main]);
    expect(res.status).toBe(404);
  });

  it("RED: duplicate slab selects the devnet market", async () => {
    const res = await signedPost([dev, main]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No file provided/i);
  });
});
