/**
 * M-4: one owner-portfolio discovery for every flow. "Not found" (a completed scan with no
 * owned portfolio) is distinct from "RPC failed" (retried, then PortfolioLookupError) — a
 * swallowed 429 used to read as "no account" and the first-trade flow created a duplicate.
 */
import { describe, it, expect, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { V17_PORTFOLIO_ACCOUNT_LEN } from "@percolatorct/sdk";
import {
  findOwnerPortfolio,
  listOwnerPortfolios,
  pickOwnerPortfolio,
  scanOwnerPortfolios,
  PortfolioLookupError,
  isPortfolioLookupError,
  PORTFOLIO_LOOKUP_COPY,
  OWNER_PORTFOLIO_OWNER_OFF,
} from "@/lib/owner-portfolio";
import { humanizeError } from "@/lib/errorMessages";

const owner = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const PROGRAM = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;

vi.mock("@/lib/lpPortfolio", () => ({
  // Fixture marker: byte 9000 = 1 means "this is the market's LP portfolio".
  isLpPortfolio: (d: Uint8Array) => d[9000] === 1,
}));
vi.mock("@percolatorct/sdk", async (orig) => {
  const real = await orig<typeof import("@percolatorct/sdk")>();
  return {
    ...real,
    parsePortfolioV17: (d: Uint8Array) => ({ owner: new PublicKey(d.slice(OWNER_PORTFOLIO_OWNER_OFF, OWNER_PORTFOLIO_OWNER_OFF + 32)) }),
  };
});

function pf(o: PublicKey, lp = false) {
  const d = Buffer.alloc(V17_PORTFOLIO_ACCOUNT_LEN);
  o.toBuffer().copy(d, OWNER_PORTFOLIO_OWNER_OFF);
  if (lp) d[9000] = 1;
  return d;
}
const pk = (s: string) => new PublicKey(s);
// Base58 order: "2…" < "3…" < "4…"
const A = pk("2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr");
const B = pk("3t2iZ8GbqAQWNCs8ckF9yQEiwqCbnybEbN2L1k6Q2bvQ");
const C = pk("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM");
const noSleep = { sleep: async () => {} };

describe("pickOwnerPortfolio — the single deterministic selector", () => {
  it("lowest pubkey wins regardless of RPC order", () => {
    const r1 = pickOwnerPortfolio([{ pubkey: C, account: { data: pf(owner) } }, { pubkey: A, account: { data: pf(owner) } }, { pubkey: B, account: { data: pf(owner) } }], owner);
    const r2 = pickOwnerPortfolio([{ pubkey: B, account: { data: pf(owner) } }, { pubkey: C, account: { data: pf(owner) } }, { pubkey: A, account: { data: pf(owner) } }], owner);
    expect(r1?.pubkey.equals(A)).toBe(true);
    expect(r2?.pubkey.equals(A)).toBe(true);
  });
  it("drops the LP portfolio and any account whose decoded owner is not the wallet", () => {
    const r = pickOwnerPortfolio(
      [{ pubkey: A, account: { data: pf(owner, true) } }, { pubkey: B, account: { data: pf(other) } }, { pubkey: C, account: { data: pf(owner) } }],
      owner,
    );
    expect(r?.pubkey.equals(C)).toBe(true);
  });
  it("only foreign / LP accounts → null", () => {
    expect(pickOwnerPortfolio([{ pubkey: A, account: { data: pf(owner, true) } }, { pubkey: B, account: { data: pf(other) } }], owner)).toBeNull();
  });
});

describe("listOwnerPortfolios — the full owned set the selector chooses from (#2560 groundwork)", () => {
  it("returns every owned, non-LP portfolio sorted by base58, regardless of RPC order", () => {
    const list = listOwnerPortfolios(
      [{ pubkey: C, account: { data: pf(owner) } }, { pubkey: A, account: { data: pf(owner) } }, { pubkey: B, account: { data: pf(owner) } }],
      owner,
    );
    expect(list.map((p) => p.pubkey.toBase58())).toEqual([A, B, C].map((k) => k.toBase58()));
  });

  it("drops the LP portfolio and any account whose decoded owner is not the wallet", () => {
    const list = listOwnerPortfolios(
      [{ pubkey: A, account: { data: pf(owner, true) } }, { pubkey: B, account: { data: pf(other) } }, { pubkey: C, account: { data: pf(owner) } }],
      owner,
    );
    expect(list.map((p) => p.pubkey.equals(C))).toEqual([true]);
  });

  it("no owned, non-LP portfolio → empty array", () => {
    expect(listOwnerPortfolios([{ pubkey: A, account: { data: pf(owner, true) } }, { pubkey: B, account: { data: pf(other) } }], owner)).toEqual([]);
  });

  it("pickOwnerPortfolio is EXACTLY the head of listOwnerPortfolios (bit-identical refactor)", () => {
    const cases: { pubkey: PublicKey; account: { data: Buffer } }[][] = [
      [{ pubkey: C, account: { data: pf(owner) } }, { pubkey: A, account: { data: pf(owner) } }, { pubkey: B, account: { data: pf(owner) } }],
      [{ pubkey: A, account: { data: pf(owner, true) } }, { pubkey: B, account: { data: pf(other) } }, { pubkey: C, account: { data: pf(owner) } }],
      [{ pubkey: A, account: { data: pf(owner, true) } }, { pubkey: B, account: { data: pf(other) } }],
      [],
    ];
    for (const r of cases) {
      const head = listOwnerPortfolios(r, owner)[0] ?? null;
      const picked = pickOwnerPortfolio(r, owner);
      expect(picked?.pubkey.toBase58() ?? null).toBe(head?.pubkey.toBase58() ?? null);
    }
  });
});

describe("scanOwnerPortfolios / findOwnerPortfolio — not-found vs RPC-failed", () => {
  it("a completed empty scan is null (the only case a caller may create)", async () => {
    const c = { getProgramAccounts: vi.fn(async () => []) };
    await expect(findOwnerPortfolio(c as never, PROGRAM, MARKET, owner, noSleep)).resolves.toBeNull();
    expect(c.getProgramAccounts).toHaveBeenCalledTimes(1);
  });
  it("transient failures are retried, then the real answer is returned", async () => {
    const c = {
      getProgramAccounts: vi
        .fn()
        .mockRejectedValueOnce(new Error("429 Too Many Requests"))
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce([{ pubkey: B, account: { data: pf(owner) } }]),
    };
    const got = await findOwnerPortfolio(c as never, PROGRAM, MARKET, owner, noSleep);
    expect(got?.equals(B)).toBe(true);
    expect(c.getProgramAccounts).toHaveBeenCalledTimes(3);
  });
  it("every attempt failing THROWS PortfolioLookupError (never null)", async () => {
    const c = { getProgramAccounts: vi.fn(async () => { throw new Error("429 Too Many Requests"); }) };
    const err = await findOwnerPortfolio(c as never, PROGRAM, MARKET, owner, noSleep).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortfolioLookupError);
    expect(isPortfolioLookupError(err)).toBe(true);
    expect((err as Error).message).toBe(PORTFOLIO_LOOKUP_COPY);
    expect(c.getProgramAccounts).toHaveBeenCalledTimes(3);
  });
  it("a non-array RPC result is a failure, not 'no account'", async () => {
    const c = { getProgramAccounts: vi.fn(async () => undefined) };
    await expect(scanOwnerPortfolios(c as never, PROGRAM, MARKET, owner, noSleep)).rejects.toBeInstanceOf(PortfolioLookupError);
  });
  it("filters on magic, market @16 and the MUTABLE owner @116", async () => {
    const c = { getProgramAccounts: vi.fn(async () => []) };
    await scanOwnerPortfolios(c as never, PROGRAM, MARKET, owner, noSleep);
    const filters = (c.getProgramAccounts.mock.calls[0] as unknown as [PublicKey, { filters: Array<{ memcmp: { offset: number; bytes: string } }> }])[1].filters;
    expect(filters.map((f) => f.memcmp.offset)).toEqual([0, 16, 116]);
    expect(filters[1].memcmp.bytes).toBe(MARKET.toBase58());
    expect(filters[2].memcmp.bytes).toBe(owner.toBase58());
  });
  it("humanizeError passes the calm copy through unchanged", () => {
    expect(humanizeError(new PortfolioLookupError(new Error("429")).message)).toBe(PORTFOLIO_LOOKUP_COPY);
  });
});
