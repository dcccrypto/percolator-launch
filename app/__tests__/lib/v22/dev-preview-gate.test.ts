import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { devPreviewAllowed } from "@/lib/v22/dev-preview-gate";

describe("dev-preview gate (F13)", () => {
  it("needs the opt-in AND a non-production Vercel env", () => {
    expect(devPreviewAllowed({})).toBe(false);
    expect(devPreviewAllowed({ NEXT_PUBLIC_DEV_PREVIEW: "1" })).toBe(true);
    expect(devPreviewAllowed({ NEXT_PUBLIC_DEV_PREVIEW: "1", VERCEL_ENV: "preview" })).toBe(true);
    expect(devPreviewAllowed({ NEXT_PUBLIC_DEV_PREVIEW: "1", VERCEL_ENV: "production" })).toBe(false);
    expect(devPreviewAllowed({ VERCEL_ENV: "development" })).toBe(false);
  });

  // F13 gated /dev-preview/v22 only; /dev-preview/status-line kept the bare opt-in check and rendered on production.
  // Every dev-preview page, including the next one added, must go through the gate.
  it("every /dev-preview page is gated by devPreviewAllowed", () => {
    const dir = path.resolve(__dirname, "../../../app/dev-preview");
    const pages = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "page.tsx")))
      .map((e) => e.name);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    const ungated = pages.filter((p) => !/devPreviewAllowed\(/.test(fs.readFileSync(path.join(dir, p, "page.tsx"), "utf8")));
    expect(ungated).toEqual([]);
  });
});
