import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SEC: the playground keeper-register route must not echo raw upstream
 * (@vercel/blob) error text to the caller — those strings can name internal
 * store IDs / paths (info-leak). The raw error is logged server-side; the
 * client gets only a generic message.
 */
describe("keeper-register does not leak raw error detail", () => {
  const src = readFileSync(
    resolve(__dirname, "../../app/api/playground/keeper-register/route.ts"),
    "utf8",
  );

  it("no `detail` field is returned in a JSON response", () => {
    // The raw err.message must not be surfaced to the client under any key.
    // (It remains in console.error server-side.)
    expect(src).not.toMatch(/\bdetail\s*[:,]/);
  });

  it("the blob-write failure still returns a generic error message", () => {
    expect(src).toContain("Failed to persist market registration to Blob store");
  });
});
