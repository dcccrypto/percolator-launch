// @vitest-environment node
/** The SDK against the real route handlers (no network): a fetch adapter calls the exported GET/POST functions. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { BotApiError, BotClient, type FetchLike } from "../../../../packages/bot-sdk/src/index";
import { issueKey } from "@/lib/bot-api/keys";

type Handler = (req: NextRequest, ctx?: { params?: Promise<Record<string, string>> }) => Promise<Response>;

async function load(pathname: string): Promise<{ h: Handler; params: Record<string, string> } | null> {
  if (pathname === "/api/v1/openapi.json") return { h: (await import("@/app/api/v1/openapi.json/route")).GET as Handler, params: {} };
  if (pathname === "/api/v1/orders") return { h: (await import("@/app/api/v1/orders/route")).POST as Handler, params: {} };
  if (pathname === "/api/v1/orders/cancel") return { h: (await import("@/app/api/v1/orders/cancel/route")).POST as Handler, params: {} };
  return null;
}

const localFetch: FetchLike = async (input, init) => {
  const url = new URL(input);
  const r = await load(url.pathname);
  if (!r) return new Response("not wired in this test", { status: 404 });
  const req = new NextRequest(url, { method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body as string | undefined });
  return r.h(req, { params: Promise.resolve(r.params) });
};

beforeEach(() => {
  process.env.BOT_API_ENABLED = "1";
  process.env.NEXT_PUBLIC_V22 = "1";
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";
});
afterEach(() => {
  delete process.env.BOT_API_ENABLED;
  delete process.env.NEXT_PUBLIC_V22;
});

describe("bot-sdk against the local handlers", () => {
  const client = (apiKey?: string) => new BotClient({ baseUrl: "http://local.test", apiKey, fetch: localFetch, maxRetries: 0 });

  it("reads the OpenAPI document anonymously", async () => {
    const spec = await client().openapi();
    expect(spec.openapi).toBe("3.1.0");
  });

  it("turns the error envelope into a BotApiError (builder without a key)", async () => {
    const e = await client().buildOrder({ owner: "o", market: "m", side: "buy", size: "1" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BotApiError);
    expect(e).toMatchObject({ code: "unauthorized", status: 401, retryable: false });
    expect((e as BotApiError).requestId).toBeTruthy();
  });

  it("sends the key and Idempotency-Key the handler expects (validation error comes from the builder, not auth)", async () => {
    const { key } = await issueKey({ scopes: ["read", "build"], label: "sdk-test" });
    const e = await client(key).buildOrder({ owner: "not-a-key", market: "m", side: "buy", size: "1" }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "bad_request", status: 400 });
    const c = await client(key).cancelOrder("never-used-key-1").catch((x: unknown) => x);
    expect(c).toMatchObject({ code: "not_found" });
  });
});
