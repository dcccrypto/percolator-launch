import { describe, expect, it } from "vitest";
import { devPreviewAllowed } from "@/lib/v22/dev-preview-gate";

describe("dev-preview gate (F13)", () => {
  it("needs the opt-in AND a non-production Vercel env", () => {
    expect(devPreviewAllowed({})).toBe(false);
    expect(devPreviewAllowed({ NEXT_PUBLIC_DEV_PREVIEW: "1" })).toBe(true);
    expect(devPreviewAllowed({ NEXT_PUBLIC_DEV_PREVIEW: "1", VERCEL_ENV: "preview" })).toBe(true);
    expect(devPreviewAllowed({ NEXT_PUBLIC_DEV_PREVIEW: "1", VERCEL_ENV: "production" })).toBe(false);
    expect(devPreviewAllowed({ VERCEL_ENV: "development" })).toBe(false);
  });
});
