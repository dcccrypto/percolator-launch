// @vitest-environment node
/** The OpenAPI spec and the routes must agree, both ways, down to method, scope and weight. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { buildOpenApi } from "@/lib/bot-api/openapi";
import { ERROR_CATALOG } from "@/lib/bot-api/errors";

const V1 = join(__dirname, "../../../app/api/v1");

function routeFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p, `${rel}/${name}`));
    else if (name === "route.ts") out.push(rel);
  }
  return out;
}

const specPaths = (buildOpenApi().paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
const toSpecPath = (rel: string) => `/api/v1${rel.replace(/\[(\w+)\]/g, "{$1}")}`;
const routes = routeFiles(V1).map((rel) => {
  const src = readFileSync(join(V1, rel, "route.ts"), "utf8");
  const call = /(?:botRoute|sseRoute)(?:<[^>]*>)?\(\s*\{\s*route:\s*"([^"]+)",\s*scope:\s*"(\w+)",\s*weight:\s*(\d+)/.exec(src);
  const method = /export (?:const|async function) (GET|POST)\b/.exec(src)?.[1];
  return { path: toSpecPath(rel), call, method };
});

describe("openapi spec", () => {
  it("has a path for every route and a route for every path", () => {
    expect(routes.length).toBeGreaterThanOrEqual(16);
    expect(Object.keys(specPaths).sort()).toEqual(routes.map((r) => r.path).sort());
  });

  it("matches each route's method, template, scope and weight", () => {
    for (const r of routes) {
      expect(r.call, r.path).not.toBeNull();
      expect(r.method, r.path).toBeDefined();
      const op = specPaths[r.path][r.method!.toLowerCase()];
      expect(op, `${r.method} ${r.path}`).toBeDefined();
      expect(Object.keys(specPaths[r.path])).toEqual([r.method!.toLowerCase()]);
      expect(r.call![1], r.path).toBe(r.path.replace("/api", ""));
      expect(op["x-scope"], r.path).toBe(r.call![2]);
      expect(op["x-weight"], r.path).toBe(Number(r.call![3]));
    }
  });

  it("lists every error code of the catalog with its status and retryable flag", () => {
    const spec = buildOpenApi() as { components: { schemas: { ErrorCode: { enum: string[] } } }; "x-error-catalog": Record<string, { status: number; retryable: boolean }> };
    const codes = Object.keys(ERROR_CATALOG).sort();
    expect([...spec.components.schemas.ErrorCode.enum].sort()).toEqual(codes);
    const text = JSON.stringify(spec);
    for (const c of codes) {
      expect(text).toContain(`"${c}"`);
      expect(spec["x-error-catalog"][c].status).toBe(ERROR_CATALOG[c as keyof typeof ERROR_CATALOG].status);
      expect(spec["x-error-catalog"][c].retryable).toBe(ERROR_CATALOG[c as keyof typeof ERROR_CATALOG].retryable);
    }
  });

  it("resolves every $ref and documents auth, rate-limit headers and Idempotency-Key", () => {
    const spec = buildOpenApi();
    const text = JSON.stringify(spec);
    for (const m of text.matchAll(/"\$ref":"#\/([^"]+)"/g)) {
      let node: unknown = spec;
      for (const part of m[1].split("/")) node = (node as Record<string, unknown>)?.[part];
      expect(node, m[1]).toBeDefined();
    }
    expect(text).toContain("bearerKey");
    expect(text).toContain("X-RateLimit-Remaining");
    expect(text).toContain("Retry-After");
    expect(text).toContain("Idempotency-Key");
    for (const p of ["/api/v1/orders", "/api/v1/positions/close", "/api/v1/deposits", "/api/v1/withdrawals"]) {
      expect(JSON.stringify(specPaths[p].post.parameters)).toContain("IdempotencyKey");
    }
    expect(spec.openapi).toBe("3.1.0");
  });
});

describe("GET /api/v1/openapi.json", () => {
  beforeEach(() => {
    process.env.BOT_API_ENABLED = "1";
    process.env.NEXT_PUBLIC_V22 = "1";
    process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
  });
  afterEach(() => {
    delete process.env.BOT_API_ENABLED;
    delete process.env.NEXT_PUBLIC_V22;
  });
  it("serves the spec anonymously with rate-limit headers", async () => {
    const { GET } = await import("@/app/api/v1/openapi.json/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/openapi.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBeTruthy();
    const body = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths["/api/v1/openapi.json"]).toBeDefined();
  });
});
