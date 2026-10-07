// @vitest-environment node
/**
 * REGRESSION review M-7 (2026-10-01): keeper-register enrolled ANY wrapper-owned market whose
 * creation tx carried the memo, with no completeness check and no ceiling, so a script could
 * fill the keeper's push batch with bare markets and drain its SOL. Driven through the REAL
 * handler with 9EPm's REAL creation tx and its REAL slab bytes; each case changes one thing:
 *  - the slab as it is on chain (finished, keeper-priced) -> 200, enrolled;
 *  - marketauth still the creator (the launch stopped before the stake pool, like A9u1KkM9) -> 409;
 *  - no insurance / no LP collateral -> 409; another oracle authority -> 403;
 *  - the creator already at the per-wallet ceiling, or the deployment full -> 403;
 * and in every refused case NOTHING is written (no markets row, no keeper blob).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { C_TOT_OFF, INSURANCE_OFF, liveSlab, MARKETAUTH_OFF, ORACLE_AUTHORITY_OFF } from "../fixtures/relaunch/m7-slabs";

const prevNetwork = process.env.NEXT_PUBLIC_DEFAULT_NETWORK;
process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
afterAll(() => {
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = prevNetwork;
});

const SLAB = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const WRAPPER = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const POOL = "Ebs3mXAzqZfzHfsdinTNw7gPy4uNyEAywcCiJxzLRrBW";
const CA = "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump";
const CREATOR = "9sM73A4MvS2ye2Fuvpr1tmkj68iA61eebuRKz1rnGUWa";
/** The exact request the launch page sent (recovered from the memo, see header). */
const REQUEST = {
  slabAddress: SLAB,
  mainnetCA: CA,
  dexPoolAddress: POOL,
  dexType: "pumpswap",
  symbol: "Percolator",
  payload: {
    decimals: 6,
    initial_price_e6: "3451",
    lp_collateral: "2200000000",
    max_leverage: 5.4,
    mint_address: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
    name: "Percolator",
    oracle_authority: "FF7KFfU5Bb3Mze2AasDHCCZuyhdaSLjUZy2K3JvjdB7x",
    oracle_mode: "keeper",
    symbol: "Percolator",
    trading_fee_bps: 5,
  },
  proofTx: "2U4TFzSboHomgWAo1REiwVMC6jA8BZR77VdeNBChnE4NvSDsghA1Bg59oJ3fP6Gzk4FTv6THAJANRoYwV5Q1PRbY",
};
// The whole live slab (fixtures/relaunch/m7-slabs.json, read-only): the route's review M-7 guard
// reads marketauth, insurance, c_tot and the oracle profile from it.

const fixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "relaunch", "9EPm.m1.tx.json"), "utf8")) as { txBase64: string; err: unknown };
const realTx = () => {
  const vtx = VersionedTransaction.deserialize(Buffer.from(fixture.txBase64, "base64"));
  return { meta: { err: fixture.err }, transaction: { message: vtx.message, signatures: vtx.signatures } };
};

const h = vi.hoisted(() => ({ existing: null as Record<string, unknown> | null, written: null as Record<string, unknown> | null, op: "", slab: null as Buffer | null, activeMine: 0, activeAll: 0 }));
const blobPut = vi.fn(async () => ({ url: "https://blob.invalid/x" }));

vi.mock("@vercel/blob", () => ({ put: blobPut, list: vi.fn(async () => ({ blobs: [] })), head: vi.fn(async () => null), del: vi.fn(async () => undefined) }));
vi.mock("@/lib/playground-keeper-signer", async () => {
  const { M7_KEEPER } = await import("../fixtures/relaunch/m7-slabs");
  return { getPlaygroundKeeperSigner: () => ({ publicKey: () => M7_KEEPER }) };
});
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/token-logo", () => ({ resolveTokenLogo: async () => null }));
vi.mock("@/lib/dex-pool-owner", async (orig) => ({ ...(await orig<object>()), classifyPoolsByOwner: vi.fn(async () => ({ [POOL]: "pumpswap" })) }));
vi.mock("@/lib/server-rpc", () => ({
  getServerConnection: () => ({
    getAccountInfo: async (pk: PublicKey) => (pk.toBase58() === SLAB ? { owner: new PublicKey(WRAPPER), data: h.slab ?? liveSlab(SLAB) } : null),
    getTransaction: async () => realTx(),
  }),
}));
/** Postgres-faithful on the integer columns (a fraction is 22P02, verified on the live DB). */
vi.mock("@/lib/supabase", () => {
  const reject = (p: Record<string, unknown>) =>
    ["decimals", "max_leverage", "trading_fee_bps"].some((k) => typeof p[k] === "number" && !Number.isInteger(p[k] as number))
      ? { code: "22P02", message: "invalid input syntax for type integer" }
      : null;
  return {
    getServerNetwork: () => "devnet",
    getServiceClient: () => ({
      from: () => ({
        select: (_c?: string, o?: { head?: boolean }) =>
          // Review M-7 enrollment-cap counts (select(..., { count, head })).
          o?.head
            ? (() => {
                let byDeployer = false;
                const q: Record<string, unknown> = {
                  eq: (c: string) => ((byDeployer ||= c === "deployer"), q),
                  neq: () => q,
                  then: (res: (v: unknown) => void) => res({ count: byDeployer ? h.activeMine : h.activeAll, error: null }),
                };
                return q;
              })()
            : ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.existing, error: null }) }) }) }),
        insert: async (p: Record<string, unknown>) => {
          const e = reject(p);
          if (!e) {
            h.written = p;
            h.op = "insert";
          }
          return { error: e };
        },
        update: (p: Record<string, unknown>) => {
          const q: Record<string, unknown> = {
            eq: () => q,
            select: async () => {
              const e = reject(p);
              if (!e) {
                h.written = p;
                h.op = "update";
              }
              return { data: e ? null : [{ id: "1" }], error: e };
            },
          };
          return q;
        },
      }),
    }),
  };
});

const { POST } = await import("@/app/api/playground/keeper-register/route");
const { PER_CREATOR_CAP_COPY, GLOBAL_CAP_COPY, DEFAULT_MAX_ACTIVE_PER_CREATOR, DEFAULT_MAX_ACTIVE_MARKETS } = await import("@/lib/keeper-enrollment-guard");

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest("https://percolator-playground.vercel.app/api/playground/keeper-register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  h.existing = null;
  h.written = null;
  h.op = "";
  h.slab = null;
  h.activeMine = 0;
  h.activeAll = 0;
  blobPut.mockClear();
});

const mutated = (f: (b: Buffer) => void) => {
  const b = liveSlab(SLAB);
  f(b);
  return b;
};
const refusedNothingWritten = () => {
  expect(h.written).toBeNull();
  expect(blobPut).not.toHaveBeenCalled();
};

describe("review M-7: only a finished, keeper-priced market under the ceilings is enrolled", () => {
  it("the slab as it is on chain -> 200, enrolled (active)", async () => {
    const res = await post(REQUEST);
    expect(res.status).toBe(200);
    expect(h.written).toMatchObject({ keeper_status: "active", slab_address: SLAB });
  });

  it("marketauth still the creator (launch stopped before the stake pool) -> 409, nothing written", async () => {
    h.slab = mutated((b) => new PublicKey(CREATOR).toBuffer().copy(b, MARKETAUTH_OFF));
    const res = await post(REQUEST);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/not ready.*incomplete/);
    refusedNothingWritten();
  });

  it("no insurance -> 409; no LP collateral -> 409; nothing written", async () => {
    h.slab = mutated((b) => b.fill(0, INSURANCE_OFF, INSURANCE_OFF + 16));
    expect((await post(REQUEST)).status).toBe(409);
    h.slab = mutated((b) => b.fill(0, C_TOT_OFF, C_TOT_OFF + 16));
    expect((await post(REQUEST)).status).toBe(409);
    refusedNothingWritten();
  });

  it("an oracle authority that is not our keeper -> 403 (final), nothing written", async () => {
    h.slab = mutated((b) => new PublicKey(CREATOR).toBuffer().copy(b, ORACLE_AUTHORITY_OFF));
    expect((await post(REQUEST)).status).toBe(403);
    refusedNothingWritten();
  });

  it("the creator at the per-wallet ceiling -> 403 with calm copy, nothing written", async () => {
    h.activeMine = DEFAULT_MAX_ACTIVE_PER_CREATOR;
    h.activeAll = DEFAULT_MAX_ACTIVE_PER_CREATOR;
    const res = await post(REQUEST);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(PER_CREATOR_CAP_COPY);
    refusedNothingWritten();
  });

  it("the deployment at its ceiling -> 429 (retryable, never a final 403), nothing written; one below -> enrolled", async () => {
    h.activeAll = DEFAULT_MAX_ACTIVE_MARKETS;
    const res = await post(REQUEST);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(((await res.json()) as { error: string }).error).toBe(GLOBAL_CAP_COPY);
    refusedNothingWritten();
    h.activeAll = DEFAULT_MAX_ACTIVE_MARKETS - 1;
    h.activeMine = DEFAULT_MAX_ACTIVE_PER_CREATOR - 1;
    expect((await post(REQUEST)).status).toBe(200);
  });

  // 2026-10-05 20:14 UTC: the 50th active row (PLAGUE) filled the old ceiling of 50, and every
  // launch after it (25+ markets, 7+ deployers) got a FINAL 403 and was left "UNKNOWN" for a day.
  it("regression: a deployment with 50 live markets still enrolls a new one (the old ceiling)", async () => {
    h.activeAll = 50;
    h.activeMine = 0;
    const res = await post(REQUEST);
    expect(res.status).toBe(200);
  });

  it("regression: a full deployment's refusal is retryable on the client (not the final 'refused')", async () => {
    h.activeAll = DEFAULT_MAX_ACTIVE_MARKETS;
    const res = await post(REQUEST);
    const { postKeeperRegistration } = await import("@/lib/keeper-register-client");
    const attempt = await postKeeperRegistration(
      { slabAddress: SLAB, dexPoolAddress: "x", proofTx: "p" },
      async () => res,
    );
    expect(attempt.registered).toBe(false);
    expect(attempt.retryable).toBe(true);
  });
});
