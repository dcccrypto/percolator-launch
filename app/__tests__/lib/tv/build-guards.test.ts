// @vitest-environment node
/**
 * Licence + gate guard rails for the TradingView library:
 *   - the leak checker (scripts/check-tv-library-leak.mjs) flags library files by path AND content
 *   - the build-time fetch verifies a content digest and installs only runtime files
 *   - the waitlist gate and middleware matcher let the library's static files through,
 *     while chart DATA (/api/*) stays gated
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateDecision, isExempt } from "@/lib/playground-gate";

const APP = path.resolve(__dirname, "../../..");
const REPO = path.resolve(APP, "..");

type LeakModule = {
  scanPaths(p: string[]): string[];
  hasLibraryContent(t: string): boolean;
  findLeaks(p: string[], read: (p: string) => string | null): { byPath: string[]; byContent: string[] };
};
type FetchModule = {
  treeDigest(dir: string): string;
  listFiles(dir: string): string[];
  installRuntime(src: string, dest: string, lock: { tag: string; commit: string; treeSha256: string; runtimeTreeSha256: string }): void;
  readLock(p?: string): { tag: string; commit: string; treeSha256: string; runtimeTreeSha256: string; blob: { pathname: string; tarballSha256: string } };
  main(env: Record<string, string | undefined>, deps?: Record<string, unknown>): Promise<number>;
  isInstalled(lock: { commit: string; treeSha256: string; runtimeTreeSha256: string }, dest: string): boolean;
  RUNTIME_ENTRIES: string[];
};
const leak = (await import(path.join(REPO, "scripts/check-tv-library-leak.mjs"))) as LeakModule;
const fetchLib = (await import(path.join(APP, "scripts/fetch-tv-library.mjs"))) as FetchModule;

// Library marker strings, assembled at runtime so this test file itself never contains them.
const MARK_LOADER = ["var TradingView=function(e)", '{"use strict"'].join("");
const MARK_PKG = ["CL v32.2.0 (internal", " id ", "8846a2fc43d5d351fe311999c84408cc85044f77"].join("");
const MARK_DTS = ["@module", "Charting Library"].join(" ");

describe("leak guard", () => {
  it("flags library paths", () => {
    expect(
      leak.scanPaths([
        "app/public/charting_library/charting_library.standalone.js",
        "charting_library.d.ts",
        "app/lib/tv/datafeed-api.d.ts",
        "vendor/tradingview/x.js",
        "app/public/tv-datafeeds/udf.js",
      ]),
    ).toHaveLength(5);
  });
  it("allows our own integration files", () => {
    expect(
      leak.scanPaths([
        "app/lib/tv/types.ts",
        "app/lib/tv/datafeed.ts",
        "app/components/trade/tv/TvChart.tsx",
        "app/public/tv-theme/percolator.css",
        "app/scripts/fetch-tv-library.mjs",
        "app/scripts/tv-library-lock.json",
        "scripts/check-tv-library-leak.mjs",
      ]),
    ).toEqual([]);
  });
  it("flags library CONTENT under any name (NEGATIVE CONTROL: each marker is caught)", () => {
    const MARK_WORKER = ["bundles/chartapi-local-", "backend.worker.", "ef8446b82697a228d7a2", ".js"].join("");
    for (const m of [MARK_LOADER, MARK_PKG, MARK_DTS, MARK_WORKER]) {
      expect(leak.hasLibraryContent(`x ${m} y`)).toBe(true);
    }
    const files: Record<string, string> = { "app/lib/renamed.js": `/* */${MARK_LOADER}`, "app/ok.ts": "export const a = 1; // TradingView UDF shape" };
    expect(leak.findLeaks(Object.keys(files), (p) => files[p] ?? null)).toEqual({ byPath: [], byContent: ["app/lib/renamed.js"] });
  });
  it("our own sources contain no library content", () => {
    for (const f of [
      "app/lib/tv/types.ts",
      "app/lib/tv/datafeed.ts",
      "app/lib/tv/theme.ts",
      "app/lib/tv/widgetOptions.ts",
      "app/components/trade/tv/TvChart.tsx",
      "app/public/tv-theme/percolator.css",
      "scripts/check-tv-library-leak.mjs",
    ]) {
      expect(leak.hasLibraryContent(readFileSync(path.join(REPO, f), "utf8")), f).toBe(false);
    }
  });
  it("the library folder is gitignored at both levels", () => {
    expect(readFileSync(path.join(REPO, ".gitignore"), "utf8")).toMatch(/^app\/public\/charting_library\/$/m);
    expect(readFileSync(path.join(APP, ".gitignore"), "utf8")).toMatch(/^\/public\/charting_library\/$/m);
  });
});

describe("build-time fetch", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), "tvfetch-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fakeLibrary(root: string) {
    const lib = path.join(root, "charting_library");
    mkdirSync(path.join(lib, "bundles"), { recursive: true });
    writeFileSync(path.join(lib, "charting_library.standalone.js"), "loader");
    writeFileSync(path.join(lib, "sameorigin.html"), "<html></html>");
    writeFileSync(path.join(lib, "bundles", "a.js"), "a");
    writeFileSync(path.join(lib, "charting_library.d.ts"), "types");
    writeFileSync(path.join(lib, "package.json"), "{}");
    return lib;
  }

  it("digest is deterministic and changes with any byte or name", () => {
    const lib = fakeLibrary(tmp());
    const d1 = fetchLib.treeDigest(lib);
    expect(fetchLib.treeDigest(lib)).toBe(d1);
    writeFileSync(path.join(lib, "bundles", "a.js"), "A");
    expect(fetchLib.treeDigest(lib)).not.toBe(d1);
    const lib2 = fakeLibrary(tmp());
    writeFileSync(path.join(lib2, "bundles", "b.js"), "");
    expect(fetchLib.treeDigest(lib2)).not.toBe(d1);
  });

  it("installs only the runtime files (no typings / package.json) and marks the version", () => {
    const lib = fakeLibrary(tmp());
    const dest = path.join(tmp(), "out");
    const lock = { tag: "v1.2.3", commit: "a".repeat(40), treeSha256: "b".repeat(64), runtimeTreeSha256: "d".repeat(64) };
    fetchLib.installRuntime(lib, dest, lock);
    expect(fetchLib.listFiles(dest)).toEqual([".percolator-version.json", "bundles/a.js", "charting_library.standalone.js", "sameorigin.html"]);
    expect(fetchLib.isInstalled(lock, dest)).toBe(true);
    expect(fetchLib.isInstalled({ ...lock, commit: "c".repeat(40) }, dest)).toBe(false);
    expect(fetchLib.isInstalled({ ...lock, runtimeTreeSha256: "e".repeat(64) }, dest)).toBe(false);
    rmSync(path.join(dest, "sameorigin.html"));
    expect(fetchLib.isInstalled(lock, dest)).toBe(false);
  });

  it("the committed lock pins a full commit and digest", () => {
    const lock = fetchLib.readLock();
    expect(lock.tag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.runtimeTreeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.blob.tarballSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.blob.pathname).toMatch(/^tv\/[\w.-]+\.tgz$/);
    const bad = path.join(tmp(), "lock.json");
    writeFileSync(bad, JSON.stringify({ tag: "v1.0.0", commit: "main", treeSha256: "x" }));
    const noRuntime = path.join(tmp(), "lock2.json");
    writeFileSync(noRuntime, JSON.stringify({ ...lock, runtimeTreeSha256: "nope" }));
    expect(() => fetchLib.readLock(noRuntime)).toThrow(/runtimeTreeSha256/);
    const badBlob = path.join(tmp(), "lock3.json");
    writeFileSync(badBlob, JSON.stringify({ ...lock, blob: { pathname: "../etc/passwd", tarballSha256: lock.blob.tarballSha256 } }));
    expect(() => fetchLib.readLock(badBlob)).toThrow(/blob\.pathname/);
    expect(() => fetchLib.readLock(bad)).toThrow();
  });

  it("the runtime set is exactly loader + iframe page + bundles", () => {
    expect(fetchLib.RUNTIME_ENTRIES).toEqual(["charting_library.standalone.js", "sameorigin.html", "bundles"]);
    expect(existsSync(path.join(APP, "scripts/tv-library-lock.json"))).toBe(true);
  });
});

describe("Vercel Blob distribution (main)", () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), "tvblob-")); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const muted = () => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); };

  /** A real runtime tarball + a lock that pins it. */
  function fixture() {
    const root = tmp();
    const lib = path.join(root, "pkg", "charting_library");
    mkdirSync(path.join(lib, "bundles"), { recursive: true });
    writeFileSync(path.join(lib, "charting_library.standalone.js"), "loader");
    writeFileSync(path.join(lib, "sameorigin.html"), "<html></html>");
    writeFileSync(path.join(lib, "bundles", "a.js"), "a");
    const tgz = path.join(root, "lib.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", path.join(root, "pkg"), "charting_library"]);
    const buf = readFileSync(tgz);
    const lock = {
      tag: "v9.9.9", commit: "a".repeat(40), treeSha256: "b".repeat(64),
      runtimeTreeSha256: fetchLib.treeDigest(lib),
      blob: { pathname: "tv/x.tgz", tarballSha256: createHash("sha256").update(buf).digest("hex") },
    };
    return { buf, lock, dest: path.join(root, "out") };
  }
  const blobOf = (buf: Buffer | null) => async () => (buf === null ? null : { statusCode: 200, stream: new Response(buf).body });

  it("installs from Blob when the tarball sha and the runtime tree both match", async () => {
    muted();
    const f = fixture();
    const code = await fetchLib.main({ BLOB_READ_WRITE_TOKEN: "t" }, { lock: f.lock, destDir: f.dest, getBlob: blobOf(f.buf) });
    expect(code).toBe(0);
    expect(fetchLib.isInstalled(f.lock, f.dest)).toBe(true);
    expect(fetchLib.listFiles(f.dest)).toContain("bundles/a.js");
  });
  it("NEGATIVE CONTROL: a tampered tarball fails the build and installs nothing", async () => {
    muted();
    const f = fixture();
    const bad = Buffer.concat([f.buf, Buffer.from("x")]);
    const code = await fetchLib.main({ BLOB_READ_WRITE_TOKEN: "t" }, { lock: f.lock, destDir: f.dest, getBlob: blobOf(bad) });
    expect(code).toBe(1);
    expect(existsSync(f.dest)).toBe(false);
  });
  it("NEGATIVE CONTROL: right tarball bytes but a wrong runtime-tree pin also fails", async () => {
    muted();
    const f = fixture();
    const code = await fetchLib.main({ BLOB_READ_WRITE_TOKEN: "t" }, { lock: { ...f.lock, runtimeTreeSha256: "0".repeat(64) }, destDir: f.dest, getBlob: blobOf(f.buf) });
    expect(code).toBe(1);
    expect(existsSync(f.dest)).toBe(false);
  });
  it("a missing blob degrades to the fallback chart (exit 0, nothing installed) unless TV_LIBRARY_REQUIRED=1", async () => {
    muted();
    const f = fixture();
    expect(await fetchLib.main({ BLOB_READ_WRITE_TOKEN: "t" }, { lock: f.lock, destDir: f.dest, getBlob: blobOf(null) })).toBe(0);
    expect(existsSync(f.dest)).toBe(false);
    expect(await fetchLib.main({ BLOB_READ_WRITE_TOKEN: "t", TV_LIBRARY_REQUIRED: "1" }, { lock: f.lock, destDir: f.dest, getBlob: blobOf(null) })).toBe(1);
  });
  it("no tokens at all: nothing fetched, build succeeds, any stale copy is removed", async () => {
    muted();
    const f = fixture();
    mkdirSync(f.dest, { recursive: true });
    writeFileSync(path.join(f.dest, "stale.js"), "x");
    const getBlob = vi.fn();
    expect(await fetchLib.main({}, { lock: f.lock, destDir: f.dest, getBlob })).toBe(0);
    expect(getBlob).not.toHaveBeenCalled();
    expect(existsSync(f.dest)).toBe(false);
  });
  it("an already-installed matching copy is not downloaded again", async () => {
    muted();
    const f = fixture();
    await fetchLib.main({ BLOB_READ_WRITE_TOKEN: "t" }, { lock: f.lock, destDir: f.dest, getBlob: blobOf(f.buf) });
    const getBlob = vi.fn();
    expect(await fetchLib.main({ BLOB_READ_WRITE_TOKEN: "t" }, { lock: f.lock, destDir: f.dest, getBlob })).toBe(0);
    expect(getBlob).not.toHaveBeenCalled();
  });
});

describe("gate + middleware for the library's static files", () => {
  const ON = { PLAYGROUND_GATE_ENABLED: "true", PLAYGROUND_ACCESS_SECRET: "s".repeat(40) };

  it("library + theme CSS pass the gate without a cookie", async () => {
    for (const p of [
      "/charting_library/charting_library.standalone.js",
      "/charting_library/sameorigin.html",
      "/charting_library/bundles/runtime.ba95fce24f0291a98470.js",
      "/tv-theme/percolator.css",
    ]) {
      expect(isExempt(p, "GET"), p).toBe(true);
      expect(await gateDecision(p, "GET", null, ON)).toBe("pass");
    }
  });

  it("chart DATA stays gated (NEGATIVE CONTROL)", async () => {
    for (const p of ["/api/candles/HBU9iugdcxdvQ9tNFuTLTtcB1bYXFdh4d5reD8M2dpop", "/api/tv/bars", "/api/markets"]) {
      expect(isExempt(p, "GET"), p).toBe(false);
      expect(await gateDecision(p, "GET", null, ON)).toBe("unauthorized");
    }
    expect(await gateDecision("/charting_library", "GET", null, ON)).toBe("redirect-locked");
    expect(await gateDecision("/trade/x", "GET", null, ON)).toBe("redirect-locked");
  });

  it("the middleware matcher skips the library + theme folders and nothing new", () => {
    const src = readFileSync(path.join(APP, "middleware.ts"), "utf8");
    const m = /matcher:\s*\[[\s\S]*?"(\/\(\(\?![^"]+)"/.exec(src);
    expect(m).not.toBeNull();
    const re = new RegExp(`^${m![1].replace(/\\\\/g, "\\")}$`);
    expect(re.test("/charting_library/bundles/x.js")).toBe(false);
    expect(re.test("/tv-theme/percolator.css")).toBe(false);
    expect(re.test("/api/candles/abc")).toBe(true);
    expect(re.test("/trade/abc")).toBe(true);
    expect(re.test("/charting_libraryX/a")).toBe(true);
  });
});
