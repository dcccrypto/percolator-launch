// @vitest-environment node
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
  existing?: { id: string; metadata_source: string; dex_pool_address?: string | null; mainnet_ca?: string | null; keeper_status?: string } | null;
  readError?: boolean;
  insertError?: { code?: string } | null;
  updateError?: boolean;
  /** The row's metadata_source at WRITE time (a concurrent maintainer edit), if it changed. */
  existingAtWrite?: string;
}) {
  let captured: Captured = null;
  const updateFilters: Array<Array<[string, unknown]>> = [];
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
          const filters: Array<[string, unknown]> = [];
          const result = () => ({ error: opts.updateError ? { message: "boom" } : null });
          // A chainable, awaitable filter builder (PostgREST shape): .eq(...)* [.select()].
          const q: Record<string, unknown> = {
            eq(col: string, v: unknown) {
              filters.push([col, v]);
              return q;
            },
            select: async () => {
              updateFilters.push(filters);
              const guard = filters.find(([c]) => c === "metadata_source");
              const rowSource = opts.existingAtWrite ?? opts.existing?.metadata_source;
              const hit = !guard || guard[1] === rowSource;
              return { ...result(), data: hit ? [{ id: "1" }] : [] };
            },
            then: (res: (v: unknown) => void) => {
              updateFilters.push(filters);
              res(result());
            },
          };
          return q;
        },
      };
    },
  };
  return { client, updateFilters, get captured() { return captured; } };
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

describe("upsertRegisteredMarketRow (admin path)", () => {
  it("inserts when no row exists, as manual + active", async () => {
    const fake = fakeSupabase({ existing: null });
    const res = await upsertRegisteredMarketRow(fake.client as never, row(), "admin");
    expect(res).toEqual({ ok: true, action: "inserted", keeperActive: true });
    expect(fake.captured?.op).toBe("insert");
    expect(fake.captured?.payload.metadata_source).toBe("manual");
    expect(fake.captured?.payload.keeper_status).toBe("active");
  });

  it("OVERWRITES an indexer-written 'auto' row — the creator beats the guess", async () => {
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "auto" } });
    const res = await upsertRegisteredMarketRow(fake.client as never, row({ symbol: "REAL" }), "admin");
    expect(res).toEqual({ ok: true, action: "updated", keeperActive: true });
    expect(fake.captured?.op).toBe("update");
    expect(fake.captured?.payload.symbol).toBe("REAL");
    expect(fake.captured?.payload.metadata_source).toBe("manual");
  });

  it("is idempotent over an existing 'manual' row (the retry path)", async () => {
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "manual" } });
    const res = await upsertRegisteredMarketRow(fake.client as never, row(), "admin");
    expect(res).toEqual({ ok: true, action: "updated", keeperActive: true });
  });

  it("always sets keeper_status='active' — registration is what enrolls a market", async () => {
    for (const existing of [null, { id: "1", metadata_source: "auto" as const }]) {
      const fake = fakeSupabase({ existing });
      await upsertRegisteredMarketRow(fake.client as never, row(), "admin");
      expect(fake.captured?.payload.keeper_status).toBe("active");
    }
  });

  it("strips null optional fields so a retry cannot blank a good row", async () => {
    // The retry path has no CreateMarketParams, so it sends nulls for the
    // derived fields. Writing them would reset a correct row's leverage/fees.
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "manual" } });
    await upsertRegisteredMarketRow(
      fake.client as never,
      row({ max_leverage: null, trading_fee_bps: null, oracle_authority: null }), "admin"
    );
    expect(fake.captured?.payload).not.toHaveProperty("max_leverage");
    expect(fake.captured?.payload).not.toHaveProperty("trading_fee_bps");
    expect(fake.captured?.payload).not.toHaveProperty("oracle_authority");
  });

  it("keeps derived fields when they ARE supplied", async () => {
    const fake = fakeSupabase({ existing: null });
    await upsertRegisteredMarketRow(
      fake.client as never,
      row({ max_leverage: 4, trading_fee_bps: 30, oracle_authority: "CRANK1" }), "admin"
    );
    expect(fake.captured?.payload.max_leverage).toBe(4);
    expect(fake.captured?.payload.trading_fee_bps).toBe(30);
    expect(fake.captured?.payload.oracle_authority).toBe("CRANK1");
  });

  it("falls back to UPDATE when a concurrent insert wins the race (23505)", async () => {
    // The indexer's discovery pass can insert between our read and our write.
    const fake = fakeSupabase({ existing: null, insertError: { code: "23505" } });
    const res = await upsertRegisteredMarketRow(fake.client as never, row(), "admin");
    expect(res).toEqual({ ok: true, action: "updated", keeperActive: true });
  });

  it("reports a read failure rather than blindly inserting", async () => {
    const fake = fakeSupabase({ readError: true });
    const res = await upsertRegisteredMarketRow(fake.client as never, row(), "admin");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(500);
  });

  it("reports an update failure", async () => {
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "auto" }, updateError: true });
    const res = await upsertRegisteredMarketRow(fake.client as never, row(), "admin");
    expect(res.ok).toBe(false);
  });

  it("maps oracle_mode 'keeper' to 'admin' — the column rejects 'keeper'", async () => {
    // markets_oracle_mode_check allows only ('pyth','hyperp','admin'). The
    // wizard's fourth type, "keeper", is an admin-oracle market whose authority
    // is delegated — sending it raw is what failed the first live launch, and
    // what made POST /api/markets fail every time before that.
    const fake = fakeSupabase({ existing: null });
    await upsertRegisteredMarketRow(fake.client as never, row({ oracle_mode: "keeper" }), "admin");
    expect(fake.captured?.payload.oracle_mode).toBe("admin");
  });

  it("leaves the other oracle modes untouched", async () => {
    for (const mode of ["pyth", "hyperp", "admin"]) {
      const fake = fakeSupabase({ existing: null });
      await upsertRegisteredMarketRow(fake.client as never, row({ oracle_mode: mode }), "admin");
      expect(fake.captured?.payload.oracle_mode).toBe(mode);
    }
  });
});

describe("registration completeness (what the markets page needs)", () => {
  it("writes logo_url when supplied — the indexer can never fill it in later", async () => {
    // updateAutoMarketMetadata is guarded by .eq("metadata_source","auto"), so
    // once registration marks the row 'manual' the indexer's logo pass can
    // never touch it again. Registration is the only chance.
    const fake = fakeSupabase({ existing: null });
    await upsertRegisteredMarketRow(fake.client as never, row({ logo_url: "https://cdn/x.png" }), "admin");
    expect(fake.captured?.payload.logo_url).toBe("https://cdn/x.png");
  });

  it("omits logo_url when resolution failed, rather than blanking an existing one", async () => {
    const fake = fakeSupabase({ existing: { id: "1", metadata_source: "auto" } });
    await upsertRegisteredMarketRow(fake.client as never, row({ logo_url: null }), "admin");
    expect(fake.captured?.payload).not.toHaveProperty("logo_url");
  });

  it("writes every field the markets page renders", async () => {
    const fake = fakeSupabase({ existing: null });
    await upsertRegisteredMarketRow(
      fake.client as never,
      row({ symbol: "TRIP", name: "TripleT", max_leverage: 10, trading_fee_bps: 30, logo_url: "L" }), "admin"
    );
    const p = fake.captured!.payload;
    for (const k of ["symbol", "name", "max_leverage", "trading_fee_bps", "logo_url",
                     "dex_pool_address", "deployer", "keeper_status", "metadata_source"]) {
      expect(p, `missing ${k}`).toHaveProperty(k);
    }
    expect(p.keeper_status).toBe("active");
    expect(p.metadata_source).toBe("manual");
  });
});

/**
 * Security review 2026-09-30 (WP-7 M-1 / M-2): the PROOF path's proof is a public, replayable
 * creation tx, so what it may write is narrower than the admin path.
 */
describe("upsertRegisteredMarketRow (proof path)", () => {
  it("inserts a new row and replaces the indexer's 'auto' guess", async () => {
    const a = fakeSupabase({ existing: null });
    expect(await upsertRegisteredMarketRow(a.client as never, row(), "proof")).toEqual({ ok: true, action: "inserted", keeperActive: true });
    const b = fakeSupabase({ existing: { id: "1", metadata_source: "auto" } });
    expect(await upsertRegisteredMarketRow(b.client as never, row({ symbol: "REAL" }), "proof")).toEqual({ ok: true, action: "updated", keeperActive: true });
    expect(b.captured?.payload.symbol).toBe("REAL");
  });
  it("NEVER overwrites a creator-registered ('manual') row", async () => {
    const f = fakeSupabase({ existing: { id: "1", metadata_source: "manual", dex_pool_address: "POOL1", mainnet_ca: "CA1", keeper_status: "active" } });
    expect(await upsertRegisteredMarketRow(f.client as never, row({ name: "Official SOL Perp" }), "proof")).toEqual({ ok: true, action: "unchanged", keeperActive: true });
    expect(f.captured).toBeNull();
  });
  it("never re-activates a retired row", async () => {
    const f = fakeSupabase({ existing: { id: "1", metadata_source: "manual", dex_pool_address: "POOL1", mainnet_ca: "CA1", keeper_status: "retired" } });
    expect(await upsertRegisteredMarketRow(f.client as never, row(), "proof")).toEqual({ ok: true, action: "unchanged", keeperActive: false });
    expect(f.captured).toBeNull();
  });
  it("refuses to change an existing pool or CA (422, final), on manual and auto rows", async () => {
    for (const existing of [
      { id: "1", metadata_source: "manual", dex_pool_address: "OTHER", mainnet_ca: "CA1" },
      { id: "1", metadata_source: "manual", dex_pool_address: "POOL1", mainnet_ca: "OTHERCA" },
      { id: "1", metadata_source: "auto", dex_pool_address: "OTHER", mainnet_ca: null },
    ]) {
      const f = fakeSupabase({ existing });
      const r = await upsertRegisteredMarketRow(f.client as never, row(), "proof");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(422);
      expect(f.captured).toBeNull();
    }
  });
  it("re-review I-R1: the auto-row update carries metadata_source='auto' in the write itself", async () => {
    const f = fakeSupabase({ existing: { id: "1", metadata_source: "auto" } });
    await upsertRegisteredMarketRow(f.client as never, row(), "proof");
    expect(f.updateFilters[0]).toContainEqual(["metadata_source", "auto"]);
  });
  it("re-review I-R1: a maintainer edit between read and write (row now 'manual') is not overwritten", async () => {
    const f = fakeSupabase({ existing: { id: "1", metadata_source: "auto" }, existingAtWrite: "manual" });
    const r = await upsertRegisteredMarketRow(f.client as never, row(), "proof");
    // zero rows updated -> re-applied once -> the fake still reads 'auto' -> second guarded write also misses
    expect(r).toEqual({ ok: false, status: 503, error: "The market row changed while registering. Try again." });
    expect(f.updateFilters.every((fs) => fs.some(([c, v]) => c === "metadata_source" && v === "auto"))).toBe(true);
  });
  it("NEGATIVE CONTROL: the admin path may still update a manual row / change its pool", async () => {
    const f = fakeSupabase({ existing: { id: "1", metadata_source: "manual", dex_pool_address: "OTHER", mainnet_ca: "CA1" } });
    expect(await upsertRegisteredMarketRow(f.client as never, row(), "admin")).toEqual({ ok: true, action: "updated", keeperActive: true });
    expect(f.captured?.op).toBe("update");
  });
  it("a 23505 race re-applies the proof rules; it never blind-updates", async () => {
    const f = fakeSupabase({ existing: null, insertError: { code: "23505" } });
    const r = await upsertRegisteredMarketRow(f.client as never, row(), "proof");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
    expect(f.captured?.op).toBe("insert");
  });
});

describe("integer columns (2026-10-01: slab 9EPm, max_leverage 5.4 -> 22P02 -> 500, never enrolled)", () => {
  /** Postgres-faithful on the integer columns: a fraction is 22P02 (verified on the live DB). */
  const strictFake = () => {
    let written: Record<string, unknown> | null = null;
    const reject = (p: Record<string, unknown>) =>
      ["decimals", "max_leverage", "trading_fee_bps"].some((k) => typeof p[k] === "number" && !Number.isInteger(p[k] as number))
        ? { code: "22P02", message: 'invalid input syntax for type integer: "5.4"' }
        : null;
    const client = {
      from() {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
          insert: async (p: Record<string, unknown>) => {
            const e = reject(p);
            if (!e) written = p;
            return { error: e };
          },
        };
      },
    };
    return { client, get written() { return written; } };
  };

  it("a fractional leverage registers, stored rounded DOWN (never above the engine's cap)", async () => {
    const f = strictFake();
    const res = await upsertRegisteredMarketRow(f.client as never, row({ max_leverage: 5.4, trading_fee_bps: 30 }), "proof");
    expect(res).toEqual({ ok: true, action: "inserted", keeperActive: true });
    expect(f.written?.max_leverage).toBe(5);
    expect(f.written?.keeper_status).toBe("active");
  });

  it("a sub-1x figure is stored as 1, a non-finite one is left to the column default", async () => {
    const f = strictFake();
    await upsertRegisteredMarketRow(f.client as never, row({ max_leverage: 0.7 }), "proof");
    expect(f.written?.max_leverage).toBe(1);
    const g = strictFake();
    await upsertRegisteredMarketRow(g.client as never, row({ max_leverage: Number.NaN }), "proof");
    expect(g.written).not.toBeNull();
    expect("max_leverage" in (g.written ?? {})).toBe(false);
  });

  it("NEGATIVE CONTROL: the strict double does reject the raw fraction (what production saw)", async () => {
    const f = strictFake();
    const { error } = await (f.client.from().insert as (p: Record<string, unknown>) => Promise<{ error: unknown }>)({ max_leverage: 5.4 });
    expect(error).toMatchObject({ code: "22P02" });
  });
});
