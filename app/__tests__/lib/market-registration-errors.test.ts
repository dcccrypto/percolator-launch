// @vitest-environment node
/**
 * Error and cap-refusal paths of upsertRegisteredMarketRow: failed writes
 * surface a diagnosable 500, enrollment-cap refusals pass their status/code
 * through, and no failure path ever reports ok. Supabase and the cap check
 * are doubles; nothing touches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const checkEnrollmentCaps = vi.fn();
vi.mock("@/lib/keeper-enrollment-guard", () => ({
  checkEnrollmentCaps: (...a: unknown[]) => checkEnrollmentCaps(...a),
}));

import { upsertRegisteredMarketRow, type RegistrationRow } from "@/lib/market-registration";

type Err = { code?: string; message?: string; details?: string; hint?: string } | null;

function fake(opts: {
  existing?: Record<string, unknown> | null;
  insertError?: Err;
  /** Result of each plain (admin) update, in order. */
  updateErrors?: Err[];
  /** Result of the proof-path guarded update. */
  proofUpdate?: { data?: unknown; error?: Err };
}) {
  const calls = { insert: 0, update: 0 };
  const updateErrors = [...(opts.updateErrors ?? [])];
  const client = {
    from() {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: opts.existing ?? null, error: null }) }) }),
        }),
        insert: async () => {
          calls.insert++;
          return { error: opts.insertError ?? null };
        },
        update() {
          calls.update++;
          const q: Record<string, unknown> = {
            eq: () => q,
            select: async () => ({
              data: opts.proofUpdate?.data ?? [{ id: "1" }],
              error: opts.proofUpdate?.error ?? null,
            }),
            then: (res: (v: unknown) => void) => res({ error: updateErrors.shift() ?? null }),
          };
          return q;
        },
      };
    },
  };
  return { client: client as never, calls };
}

const row: RegistrationRow = {
  slab_address: "Slab1",
  mint_address: "Mint1",
  symbol: "TST",
  name: "Test",
  decimals: 6,
  deployer: "Wallet1",
  dex_pool_address: "Pool1",
  mainnet_ca: null,
  oracle_mode: "keeper",
  network: "devnet",
};

const caps = { perCreator: 3, perDeployment: 100 } as never;

beforeEach(() => {
  checkEnrollmentCaps.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("insert failures", () => {
  it("non-23505 insert error -> 500 with every error field in detail", async () => {
    const { client } = fake({
      insertError: { code: "23514", message: "check violation", details: "row fails", hint: "fix it" },
    });
    const r = await upsertRegisteredMarketRow(client, row, "admin");
    expect(r).toEqual({
      ok: false,
      status: 500,
      error: "Failed to register market",
      detail: "code=23514 | check violation | row fails | fix it",
    });
  });

  it("insert error with no fields still yields a 500 (empty detail)", async () => {
    const { client } = fake({ insertError: {} });
    const r = await upsertRegisteredMarketRow(client, row, "proof");
    expect(r).toMatchObject({ ok: false, status: 500, error: "Failed to register market", detail: "" });
  });

  it("admin 23505 then failing update -> 500, not a silent success", async () => {
    const { client, calls } = fake({
      insertError: { code: "23505" },
      updateErrors: [{ code: "42501", message: "permission denied" }],
    });
    const r = await upsertRegisteredMarketRow(client, row, "admin");
    expect(r).toEqual({
      ok: false,
      status: 500,
      error: "Failed to register market",
      detail: "code=42501 | permission denied",
    });
    expect(calls.update).toBe(1);
  });

  it("admin 23505 then ok update -> updated", async () => {
    const { client } = fake({ insertError: { code: "23505" } });
    expect(await upsertRegisteredMarketRow(client, row, "admin")).toEqual({
      ok: true,
      action: "updated",
      keeperActive: true,
    });
  });
});

describe("update failures", () => {
  it("proof update error on an auto row -> 500, no retry", async () => {
    const { client, calls } = fake({
      existing: { id: "1", metadata_source: "auto" },
      proofUpdate: { error: { message: "boom", code: "XX000" } },
    });
    const r = await upsertRegisteredMarketRow(client, row, "proof");
    expect(r).toEqual({
      ok: false,
      status: 500,
      error: "Failed to update market registration",
      detail: "code=XX000 | boom",
    });
    expect(calls.update).toBe(1);
  });

  it("admin update error on an existing row -> 500", async () => {
    const { client } = fake({
      existing: { id: "1", metadata_source: "manual" },
      updateErrors: [{ message: "nope" }],
    });
    const r = await upsertRegisteredMarketRow(client, row, "admin");
    expect(r).toMatchObject({ ok: false, status: 500, error: "Failed to update market registration", detail: "nope" });
  });
});

describe("enrollment caps (proof path)", () => {
  it("refusal passes status, error, detail and code through and writes nothing", async () => {
    checkEnrollmentCaps.mockResolvedValue({
      ok: false,
      status: 429,
      error: "cap reached",
      detail: "count query failed",
      code: "creator_cap",
    });
    const { client, calls } = fake({});
    const r = await upsertRegisteredMarketRow(client, row, "proof", caps);
    expect(r).toEqual({
      ok: false,
      status: 429,
      error: "cap reached",
      detail: "count query failed",
      code: "creator_cap",
    });
    expect(calls.insert).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      "[market-registration] enrollment count failed:",
      "count query failed",
    );
  });

  it("refusal without detail/code omits those keys and logs nothing", async () => {
    checkEnrollmentCaps.mockResolvedValue({ ok: false, status: 429, error: "cap reached" });
    const { client } = fake({ existing: { id: "1", metadata_source: "auto", keeper_status: "retired" } });
    const r = await upsertRegisteredMarketRow(client, row, "proof", caps);
    expect(r).toEqual({ ok: false, status: 429, error: "cap reached" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("allowed -> proceeds to insert", async () => {
    checkEnrollmentCaps.mockResolvedValue({ ok: true });
    const { client } = fake({});
    const r = await upsertRegisteredMarketRow(client, row, "proof", caps);
    expect(r).toEqual({ ok: true, action: "inserted", keeperActive: true });
    expect(checkEnrollmentCaps).toHaveBeenCalledWith(
      expect.anything(),
      { slab: "Slab1", deployer: "Wallet1", network: "devnet" },
      caps,
    );
  });

  it("already-active row is not re-counted", async () => {
    const { client } = fake({ existing: { id: "1", metadata_source: "auto", keeper_status: "active" } });
    const r = await upsertRegisteredMarketRow(client, row, "proof", caps);
    expect(r).toMatchObject({ ok: true, action: "updated" });
    expect(checkEnrollmentCaps).not.toHaveBeenCalled();
  });

  it("admin path is never capped", async () => {
    const { client } = fake({});
    await upsertRegisteredMarketRow(client, row, "admin", caps);
    expect(checkEnrollmentCaps).not.toHaveBeenCalled();
  });
});
