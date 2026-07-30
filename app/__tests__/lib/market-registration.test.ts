/**
 * Registration write semantics.
 *
 * The branch that matters is "existing row with metadata_source='auto' gets
 * UPDATED". Measured on the live DB 2026-07-30, all 5 market rows were 'auto'
 * and POST /api/markets had never once created one: the indexer inserts a row
 * for any slab it discovers within ~60s, and the old endpoint 409'd against it,
 * so the creator's metadata lost every single time. Overwriting 'auto' is safe
 * because the caller has already been verified against the slab's live on-chain
 * marketauth before this function is reached.
 */
import { describe, it, expect } from "vitest";
import { upsertRegisteredMarketRow, type RegistrationRow } from "@/lib/market-registration";

type Captured = { op: "insert" | "update"; payload: Record<string, unknown> } | null;

/** Minimal supabase double covering only the calls this function makes. */
function fakeSupabase(opts: {
  existing?: { id: string; metadata_source: string } | null;
  readError?: boolean;
  insertError?: { code?: string } | null;
  updateError?: boolean;
}) {
  let captured: Captured = null;
  const client = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () =>
                      opts.readError
                        ? { data: null, error: { message: "boom" } }
                        : { data: opts.existing ?? null, error: null },
                  };
                },
              };
            },
          };
        },
        insert: async (payload: Record<string, unknown>) => {
          captured = { op: "insert", payload };
          return { error: opts.insertError ?? null };
        },
        update(payload: Record<string, unknown>) {
          captured = { op: "update", payload };
          return {
            eq() {
              return {
                eq: async () => ({ error: opts.updateError ? { message: "boom" } : null }),
              };
            },
          };
        },
      };
    },
  };
  return { client, get captured() { return captured; } };
}

const row = (over: Partial<RegistrationRow> = {}): RegistrationRow => ({
  slab_address: "SLAB1",
  mint_address: "MINT1",
  symbol: "FOO",
  name: "Foo Token",
  decimals: 6,
  deployer: "WALLET1",
  dex_pool_address: "POOL1",
  mainnet_ca: "CA1",
  oracle_mode: "admin",
  network: "devnet",
  ...over,
});

describe("upsertRegisteredMarketRow", () => {
  it("inserts when no row exists, as manual + active", async () => {
    const fake = fakeSupabase({ existing: null });
    const res = await upsertRegisteredMarketRow(fake.client as never, row());
    expect(res).toEqual({ ok: true, action: "inserted" });
    expect(fake.captured?.op).toBe("insert");
    expect(fake.captured?.payload.metadata_source).toBe("manual");
    expect(fake.captured?.payload.keeper_status).toBe("active");
  });

  it("OVERWRITES an indexer-written 'auto' row — the creator beats the guess", async () => {
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "auto" } });
    const res = await upsertRegisteredMarketRow(fake.client as never, row({ symbol: "REAL" }));
    expect(res).toEqual({ ok: true, action: "updated" });
    expect(fake.captured?.op).toBe("update");
    expect(fake.captured?.payload.symbol).toBe("REAL");
    expect(fake.captured?.payload.metadata_source).toBe("manual");
  });

  it("is idempotent over an existing 'manual' row (the retry path)", async () => {
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "manual" } });
    const res = await upsertRegisteredMarketRow(fake.client as never, row());
    expect(res).toEqual({ ok: true, action: "updated" });
  });

  it("always sets keeper_status='active' — registration is what enrolls a market", async () => {
    for (const existing of [null, { id: "1", metadata_source: "auto" as const }]) {
      const fake = fakeSupabase({ existing });
      await upsertRegisteredMarketRow(fake.client as never, row());
      expect(fake.captured?.payload.keeper_status).toBe("active");
    }
  });

  it("strips null optional fields so a retry cannot blank a good row", async () => {
    // The retry path has no CreateMarketParams, so it sends nulls for the
    // derived fields. Writing them would reset a correct row's leverage/fees.
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "manual" } });
    await upsertRegisteredMarketRow(
      fake.client as never,
      row({ max_leverage: null, trading_fee_bps: null, oracle_authority: null }),
    );
    expect(fake.captured?.payload).not.toHaveProperty("max_leverage");
    expect(fake.captured?.payload).not.toHaveProperty("trading_fee_bps");
    expect(fake.captured?.payload).not.toHaveProperty("oracle_authority");
  });

  it("keeps derived fields when they ARE supplied", async () => {
    const fake = fakeSupabase({ existing: null });
    await upsertRegisteredMarketRow(
      fake.client as never,
      row({ max_leverage: 4, trading_fee_bps: 30, oracle_authority: "CRANK1" }),
    );
    expect(fake.captured?.payload.max_leverage).toBe(4);
    expect(fake.captured?.payload.trading_fee_bps).toBe(30);
    expect(fake.captured?.payload.oracle_authority).toBe("CRANK1");
  });

  it("falls back to UPDATE when a concurrent insert wins the race (23505)", async () => {
    // The indexer's discovery pass can insert between our read and our write.
    const fake = fakeSupabase({ existing: null, insertError: { code: "23505" } });
    const res = await upsertRegisteredMarketRow(fake.client as never, row());
    expect(res).toEqual({ ok: true, action: "updated" });
  });

  it("reports a read failure rather than blindly inserting", async () => {
    const fake = fakeSupabase({ readError: true });
    const res = await upsertRegisteredMarketRow(fake.client as never, row());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(500);
  });

  it("reports an update failure", async () => {
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "auto" }, updateError: true });
    const res = await upsertRegisteredMarketRow(fake.client as never, row());
    expect(res.ok).toBe(false);
  });
});
