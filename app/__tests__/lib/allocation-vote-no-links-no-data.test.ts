/**
 * The allocation and vote pages are reachable by direct URL only:
 *  - nothing in the app links to them (header, footer, nav, homepage, waitlist),
 *  - the sitemap does not list them,
 *  - and nothing synthetic, private, or raw-dataset-shaped ships with them.
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["app", "components", "hooks", "lib", "public"];
const SURFACE_FILES = new Set([
  "middleware.ts",
]);
const COPY_FILE = "lib/allocation-vote/copy.ts";
const SURFACE_DIRS = ["app/allocation/", "app/vote/", "app/api/allocation/", "app/api/vote/", "lib/allocation-vote/"];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "charting_library") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|json|md|html|txt|xml)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p);
const all = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const isSurface = (f: string) => SURFACE_FILES.has(f) || SURFACE_DIRS.some((d) => f.startsWith(d));

describe("no links to /allocation or /vote", () => {
  it("scanned a real tree (not vacuous)", () => {
    const r = all.map(rel);
    expect(r).toContain("components/layout/Header.tsx");
    expect(r).toContain("components/layout/Footer.tsx");
    expect(r).toContain("app/waitlist/page.tsx");
    expect(r).toContain("app/allocation/page.tsx");
    expect(r).toContain("app/vote/page.tsx");
  });

  it("no file outside the surfaces themselves mentions the routes", () => {
    const pattern = /["'`(]\s*(?:https?:\/\/[^"'`\s)]*)?\/(?:api\/)?(?:allocation|vote)(?=["'`/?#)\s])/;
    const offenders = all
      .map(rel)
      .filter((f) => !isSurface(f))
      .filter((f) => pattern.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the surfaces do not link to each other either", () => {
    for (const f of ["app/allocation/page.tsx", "app/vote/page.tsx"]) {
      expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/href=/);
    }
  });

  it("sitemap excludes both routes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { default: sitemap } = await import("@/app/sitemap");
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => /\/(allocation|vote)(\/|$)/.test(u))).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe("no synthetic, private, or raw data in the new surfaces", () => {
  const surfaceSources = all.map(rel).filter((f) => SURFACE_DIRS.some((d) => f.startsWith(d)));

  it("found the surface sources", () => {
    expect(surfaceSources.length).toBeGreaterThanOrEqual(10);
  });

  it.each([
    ["synthetic markers", /SYNTHETIC|synthetic-|fixture/i],
    ["base58 wallet-length strings", /[1-9A-HJ-NP-Za-km-z]{32,44}/],
    ["64-hex hashes (export/manifest digests, signatures)", /\b[0-9a-f]{64}\b/i],
    ["raw dataset / manifest files", /\.csv\b|manifest\.json|import\//],
    // Any 5+ digit figure (amounts, totals, slots, balances) is out of place here.
    ["large numeric figures", /\b\d[\d,_]{4,}\b/],
    ["pool / raise wording", /holder pool|raise/i],
    ["seed phrase or private key material", /secretKey|privateKey|mnemonic|BEGIN [A-Z ]*PRIVATE KEY/],
  ])("no %s", (label, re) => {
    // The published terms (20% of the full $250,000 raise) live in exactly one
    // file, copy.ts, which is pinned verbatim below instead.
    const exempt = label === "large numeric figures" || label === "pool / raise wording" ? new Set([COPY_FILE]) : new Set<string>();
    const offenders = surfaceSources.filter((f) => !exempt.has(f) && re.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("copy.ts holds only the published terms (pinned) and no other figures", async () => {
    const { ALLOCATION_COPY } = await import("@/lib/allocation-vote/copy");
    expect(ALLOCATION_COPY.terms).toEqual([
      "Holders in the 7 Nov 2026 snapshot share a guaranteed floor of 20% of the full $250,000 raise ($50,000), split in proportion to snapshot balance.",
      "If you commit more than your allocation, the excess commitment is refunded.",
      "All figures are provisional until the raise.",
    ]);
    const src = fs.readFileSync(path.join(ROOT, COPY_FILE), "utf8").replace(/\$250,000|\$50,000/g, "");
    expect(src).not.toMatch(/\b\d[\d,_]{4,}\b/);
    expect(src).not.toMatch(/\bcap\b|capped|maximum|reserve|releas|v2\.2|\bbuild\b|—/i);
  });

  it("no data files were added under the surfaces", () => {
    const nonCode = surfaceSources.filter((f) => !/\.(ts|tsx)$/.test(f));
    expect(nonCode).toEqual([]);
  });
});
