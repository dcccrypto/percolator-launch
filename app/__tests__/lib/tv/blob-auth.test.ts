import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs build script without type declarations
import { blobAuthFromEnv, downloadFromBlob } from "../../../scripts/fetch-tv-library.mjs";

describe("TradingView library blob credentials", () => {
  it("uses the private store via OIDC when TV_BLOB_STORE_ID is set", () => {
    expect(blobAuthFromEnv({ TV_BLOB_STORE_ID: "store_x", VERCEL_OIDC_TOKEN: "oidc" })).toEqual({ storeId: "store_x", oidcToken: "oidc" });
  });

  it("never falls back to the app's public-store token when TV_BLOB_STORE_ID is set", () => {
    expect(blobAuthFromEnv({ TV_BLOB_STORE_ID: "store_x", BLOB_READ_WRITE_TOKEN: "public-rw" })).toEqual({ storeId: "store_x" });
  });

  it("keeps the legacy read-write token path when no store id is set", () => {
    expect(blobAuthFromEnv({ BLOB_READ_WRITE_TOKEN: "rw" })).toEqual({ token: "rw" });
  });

  it("returns null with no credentials, so the build falls back to the perp chart", () => {
    expect(blobAuthFromEnv({})).toBeNull();
  });

  it("passes the store credentials through to get() with private access", async () => {
    let seen: Record<string, unknown> | null = null;
    const lock = { blob: { pathname: "tv/x.tgz" } };
    const out = await downloadFromBlob(lock, { storeId: "store_x" }, async (_p: string, o: Record<string, unknown>) => {
      seen = o;
      return null;
    });
    expect(out).toBeNull();
    expect(seen).toMatchObject({ access: "private", storeId: "store_x" });
  });
});
