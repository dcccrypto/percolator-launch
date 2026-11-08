/**
 * Every /dev-preview page is reachable only with NEXT_PUBLIC_DEV_PREVIEW=1 AND never on a Vercel production deployment (review
 * F13). F13 gated /dev-preview/v22, but /dev-preview/status-line kept the bare opt-in check, so an opt-in on a production
 * deployment would serve it. This renders each real page module (default export) under each env: it must call notFound()
 * (throws) when the gate says no, and render when it says yes. A new dev-preview page without the gate fails here.
 *
 * The page set and the gap were first reported by 6figpsolseeker in dcccrypto/percolator-launch#3763 (closed); this test
 * and fix are our own re-implementation.
 */
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<Record<string, unknown>>()), notFound }));

const DIR = path.resolve(__dirname, "../../app/dev-preview");
const PAGES = readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(path.join(DIR, e.name, "page.tsx")))
  .map((e) => e.name)
  .sort();

afterEach(() => {
  vi.unstubAllEnvs();
  notFound.mockClear();
});

const render = async (name: string) => {
  const mod = (await import(`../../app/dev-preview/${name}/page.tsx`)) as { default: () => unknown };
  return mod.default();
};

describe("every /dev-preview page is gated by devPreviewAllowed", () => {
  it("the scan finds the known pages", () => {
    expect(PAGES).toEqual(expect.arrayContaining(["status-line", "v22"]));
  });

  describe.each(PAGES)("/dev-preview/%s", (name) => {
    it.each([
      ["no opt-in", {}],
      ["opt-in on a Vercel production deployment", { NEXT_PUBLIC_DEV_PREVIEW: "1", VERCEL_ENV: "production" }],
      ["production without opt-in", { VERCEL_ENV: "production" }],
    ])("404 with %s", async (_n, env: Record<string, string>) => {
      vi.stubEnv("NEXT_PUBLIC_DEV_PREVIEW", env.NEXT_PUBLIC_DEV_PREVIEW ?? "");
      vi.stubEnv("VERCEL_ENV", env.VERCEL_ENV ?? "");
      await expect(render(name)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFound).toHaveBeenCalled();
    });

    it("renders with the opt-in on a preview deployment", async () => {
      vi.stubEnv("NEXT_PUBLIC_DEV_PREVIEW", "1");
      vi.stubEnv("VERCEL_ENV", "preview");
      await expect(render(name)).resolves.toBeTruthy();
      expect(notFound).not.toHaveBeenCalled();
    });
  });
});
