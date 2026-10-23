/**
 * #3463: no burn-admin overclaim anywhere, and the market page's chip reads the key a burn actually clears.
 * On a wrapper market the slab header's `admin` is the market authority (SlabProvider shim), which UpdateAssetAuthority
 * never zeroes, so the chip keyed off it said "Admin Active" after a burn. It now reads asset 0's asset_admin.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

const wrapper = { is: true };
const assetAdmin = { key: PublicKey.default as PublicKey, throws: false };
vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/layout")>()),
  isWrapperAccount: () => wrapper.is,
}));
vi.mock("@/lib/v18-wire", async (orig) => ({
  ...(await orig<typeof import("@/lib/v18-wire")>()),
  readAssetAdmin: () => {
    if (assetAdmin.throws) throw new Error("slab too short");
    return assetAdmin.key;
  },
}));

import { ADMIN_BURN_COPY, creatorAdminBurned } from "@/lib/admin-burn-copy";

const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
const raw = new Uint8Array(64);

describe("creatorAdminBurned (#3463)", () => {
  beforeEach(() => {
    wrapper.is = true;
    assetAdmin.key = PublicKey.default;
    assetAdmin.throws = false;
  });
  it("wrapper market: burned exactly when asset 0's asset_admin is zero, whatever the header (market authority) says", () => {
    const marketAuth = Keypair.generate().publicKey;
    expect(creatorAdminBurned(raw, marketAuth)).toBe(true);
    assetAdmin.key = Keypair.generate().publicKey;
    expect(creatorAdminBurned(raw, PublicKey.default)).toBe(false);
  });
  it("an unreadable profile or no data is unknown (no chip), never a guess", () => {
    assetAdmin.throws = true;
    expect(creatorAdminBurned(raw, PublicKey.default)).toBeNull();
    wrapper.is = false;
    expect(creatorAdminBurned(null, null)).toBeNull();
  });
  it("legacy slab: the header admin", () => {
    wrapper.is = false;
    expect(creatorAdminBurned(raw, PublicKey.default)).toBe(true);
    expect(creatorAdminBurned(raw, Keypair.generate().publicKey)).toBe(false);
  });
  it("chip labels name the creator key, not admin control as a whole", () => {
    expect(ADMIN_BURN_COPY.chipBurned).toBe("Creator key burned");
    expect(ADMIN_BURN_COPY.chipActive).toBe("Creator key held");
    expect(`${ADMIN_BURN_COPY.chipBurned} ${ADMIN_BURN_COPY.chipActive}`).not.toMatch(/renounced/i);
  });
});

describe("no burn-admin overclaim on the surfaces #3463 / the review named", () => {
  it("market page: chip from creatorAdminBurned, not the header's market authority", () => {
    const p = src("app/trade/[slab]/page.tsx");
    expect(p).toContain("creatorAdminBurned(slabRaw, header?.admin)");
    expect(p).not.toMatch(/Admin Renounced|Admin Active/);
    expect(p).not.toMatch(/header\.admin\.toBase58\(\) === "1{32}"/);
  });
  it("ticker: no 'burn the admin key.' slogan", () => {
    expect(src("components/layout/TickerBanner.tsx")).not.toMatch(/burn the admin key/i);
  });
  it("landing: the hero names the creator's key, and no 'once burned' claim", () => {
    const p = src("app/page.tsx");
    expect(p).not.toMatch(/can burn its own admin key/i);
    expect(p).not.toMatch(/once burned/i);
    expect(p).toContain("ADMIN_BURN_COPY.landing");
  });
  it("Your Markets burn confirmation: what a burn clears, not 'any admin actions'", () => {
    const p = src("components/my-markets/CreatorMarketRow.tsx");
    expect(p).toContain("{ADMIN_BURN_COPY.confirm}");
    expect(p).not.toMatch(/perform any admin actions/i);
    expect(ADMIN_BURN_COPY.confirm).toMatch(/price-feed, insurance and backing keys/);
    expect(ADMIN_BURN_COPY.confirm).toMatch(/market authority/);
  });
});
