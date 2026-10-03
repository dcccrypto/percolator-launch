// @vitest-environment node
/**
 * GH#2751 — POST /api/devnet-mint-token must never write to the `markets` table.
 *
 * The route is unauthenticated (any caller supplies `creatorWallet` and
 * `marketAddress`). It used to finish a new-mint request with
 *   supabase.from("markets").update({ mint_address, symbol }).eq("slab_address", marketAddress)
 * so anyone could repoint a live market's mint_address and rename its symbol.
 * `markets` rows belong to signed registration (lib/market-registration.ts).
 *
 * These tests drive the REAL route handler through its new-mint path (the only
 * path that reached the write) with Supabase, RPC and the mint signer mocked,
 * and record every table the route touches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, Transaction } from "@solana/web3.js";

const mintAuthority = Keypair.generate();

const mocks = vi.hoisted(() => ({
  tables: [] as Array<{ table: string; op: string; args: unknown[] }>,
  insertResult: { error: null as null | { code?: string; message: string } },
  existing: null as null | { devnet_mint: string },
}));

function tableClient(table: string) {
  const record = (op: string) => (...args: unknown[]) => {
    mocks.tables.push({ table, op, args });
    return chain;
  };
  const chain: Record<string, unknown> = {
    select: record("select"),
    eq: record("eq"),
    update: record("update"),
    upsert: record("upsert"),
    maybeSingle: async () => ({ data: table === "devnet_mints" ? mocks.existing : null, error: null }),
    insert: async (...args: unknown[]) => {
      mocks.tables.push({ table, op: "insert", args });
      return mocks.insertResult;
    },
    then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
  };
  return chain;
}

vi.mock("@/lib/supabase", () => ({
  getServiceClient: () => ({ from: (t: string) => tableClient(t) }),
}));

vi.mock("@/lib/faucet-rate-gate", () => ({
  tryFaucetGate: vi.fn(async () => ({ allowed: true, nextClaimAt: null, claimId: 1 })),
  releaseFaucetClaim: vi.fn(async () => undefined),
}));

vi.mock("@/lib/devnet-mirror-mint-rate-limit", () => ({
  checkMintRateLimit: vi.fn(async () => ({ allowed: true, retryAfter: 0 })),
}));

vi.mock("@/lib/devnet-signer", () => ({
  getDevnetMintSigner: () => ({
    publicKey: () => mintAuthority.publicKey.toBase58(),
    signTransaction: (tx: Transaction) => {
      tx.partialSign(mintAuthority);
      return tx;
    },
  }),
}));

vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getMinimumBalanceForRentExemption: async () => 1_461_600,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    }),
    getAccountInfo: async () => null,
    sendRawTransaction: async () => "sig-2751",
    confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
  }),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const MAINNET_CA = Keypair.generate().publicKey.toBase58();
const VICTIM_SLAB = Keypair.generate().publicKey.toBase58();
const ATTACKER = Keypair.generate().publicKey.toBase58();

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/devnet-mint-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetModules();
  mocks.tables.length = 0;
  mocks.insertResult = { error: null };
  mocks.existing = null;
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          pairs: [
            {
              priceUsd: "2.5",
              baseToken: { name: "Spoof Token", symbol: "SOL" },
              liquidity: { usd: 100000 },
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  );
});

describe("GH#2751: /api/devnet-mint-token does not write markets", () => {
  it("creates the mirror mint and records it in devnet_mints, but never touches markets", async () => {
    const { POST } = await import("@/app/api/devnet-mint-token/route");
    const res = await POST(
      req({ mainnetCA: MAINNET_CA, marketAddress: VICTIM_SLAB, creatorWallet: ATTACKER }),
    );
    const json = await res.json();

    // The path that used to issue the markets.update really ran to completion.
    expect(res.status).toBe(200);
    expect(json.status).toBe("created");
    const inserts = mocks.tables.filter((c) => c.table === "devnet_mints" && c.op === "insert");
    expect(inserts).toHaveLength(1);
    expect((inserts[0].args[0] as { devnet_mint: string }).devnet_mint).toBe(json.devnetMint);

    // ...and no call of any kind reached the markets table.
    expect(mocks.tables.filter((c) => c.table === "markets")).toEqual([]);
  });

  it("also leaves markets alone when the devnet_mints insert loses the race (23505)", async () => {
    mocks.insertResult = { error: { code: "23505", message: "duplicate" } };
    const { POST } = await import("@/app/api/devnet-mint-token/route");
    const res = await POST(
      req({ mainnetCA: MAINNET_CA, marketAddress: VICTIM_SLAB, creatorWallet: ATTACKER }),
    );
    expect(res.status).toBe(200);
    expect(mocks.tables.filter((c) => c.table === "markets")).toEqual([]);
  });

  it("also leaves markets alone when a non-race insert error occurs", async () => {
    mocks.insertResult = { error: { code: "XX000", message: "boom" } };
    const { POST } = await import("@/app/api/devnet-mint-token/route");
    const res = await POST(
      req({ mainnetCA: MAINNET_CA, marketAddress: VICTIM_SLAB, creatorWallet: ATTACKER }),
    );
    expect(res.status).toBe(200);
    expect(mocks.tables.filter((c) => c.table === "markets")).toEqual([]);
  });

  it("never reads or writes markets anywhere in the route source", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../app/api/devnet-mint-token/route.ts"),
      "utf8",
    );
    const code = src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    expect(code).not.toMatch(/from\(\s*["'`]markets["'`]\s*\)/);
  });
});
