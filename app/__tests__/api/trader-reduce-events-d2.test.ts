// @vitest-environment node
/** D2 gate: GET /api/trader/:wallet/reduce-events?portfolios=... reads v22_events (server-only table) for those portfolios. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const WALLET = "AXa339sRttD8mdHUyDdGbGQyZNQnR17fFKzg9P5Ui5ym";
const P1 = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const P2 = "7h3wNxjzPo6pTfWQ7uiTjDSsprGEeMNh696efmYrpAX2";
const M = "ENdXK8k6iiWCAx4Z9XfoKLg9oXsEbPL4hEtmEmUqozDZ";

const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], calls: [] as Array<[string, ...unknown[]]>, error: null as null | { message: string } }));

vi.mock("@/lib/upstash-rate-limit", () => ({ createUpstashRateLimiter: () => ({ check: async () => ({ allowed: true }) }) }));
vi.mock("@/lib/supabase", () => ({
  getServerNetwork: () => "devnet",
  getServiceClient: () => ({
    from: (t: string) => {
      h.calls.push(["from", t]);
      const preds: Array<(r: Record<string, unknown>) => boolean> = [];
      const q: Record<string, unknown> = {};
      q.select = (c: string) => { h.calls.push(["select", c]); return q; };
      q.eq = (c: string, v: unknown) => { h.calls.push(["eq", c, v]); preds.push((r) => r[c] === v); return q; };
      q.in = (c: string, v: unknown[]) => { h.calls.push(["in", c, v]); preds.push((r) => v.includes(r[c])); return q; };
      q.not = (c: string, op: string, v: string) => { h.calls.push(["not", c, op, v]); return q; };
      q.order = (c: string, o: unknown) => { h.calls.push(["order", c, o]); return q; };
      q.limit = (n: number) => { h.calls.push(["limit", n]); return q; };
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(h.error ? { data: null, error: h.error } : { data: h.rows.filter((r) => preds.every((p) => p(r))), error: null }).then(res);
      return q;
    },
  }),
}));

import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { GET } from "@/app/api/trader/[wallet]/reduce-events/route";

const call = (qs: string, wallet = WALLET) =>
  GET(new NextRequest(`http://x/api/trader/${wallet}/reduce-events${qs}`), { params: Promise.resolve({ wallet }) });
const ev = (actor: string, reason: number, kind = "reduce_event", network = "devnet") => ({
  signature: `sig-${actor.slice(0, 4)}-${reason}`, kind, slab_address: M, asset_index: 0, actor, amount: "10",
  block_time: "2026-10-29T10:00:00Z", slot: 5, network, detail: { reason, signed_reduced_q: "10", price_e6: "1" },
});

beforeEach(() => {
  h.rows = [];
  h.calls = [];
  h.error = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://sb";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
});
afterEach(() => __setDevnetV22ForTest(null));

describe("reduce-events route", () => {
  it("v2.2 off: nothing, and the database is never touched", async () => {
    __setDevnetV22ForTest(false);
    const r = await call(`?portfolios=${P1}`);
    expect(await r.json()).toEqual({ available: false, events: [] });
    expect(h.calls).toEqual([]);
  });
  it("returns this network's reduce events for the listed portfolios only, newest first, capped", async () => {
    __setDevnetV22ForTest(true);
    h.rows = [ev(P1, 8), ev(P2, 3), ev(M, 8), ev(P1, 3, "fill_event"), ev(P1, 2, "reduce_event", "mainnet")];
    const body = await (await call(`?portfolios=${P1},${P2}`)).json();
    expect(body.available).toBe(true);
    expect(body.events.map((e: { signature: string }) => e.signature).sort()).toEqual([`sig-${P1.slice(0, 4)}-8`, `sig-${P2.slice(0, 4)}-3`].sort());
    expect(body.events.find((e: { reason: number }) => e.reason === 8).lpStop).toBe(true);
    expect(h.calls).toContainEqual(["from", "v22_events"]);
    expect(h.calls).toContainEqual(["eq", "kind", "reduce_event"]);
    expect(h.calls).toContainEqual(["eq", "network", "devnet"]);
    expect(h.calls).toContainEqual(["order", "block_time", { ascending: false, nullsFirst: false }]);
    expect(h.calls).toContainEqual(["order", "slot", { ascending: false, nullsFirst: false }]);
    // the trader's own reduces (1 rebalance, 7 resolved close) are excluded in SQL, before the limit
    expect(h.calls).toContainEqual(["not", "detail->>reason", "in", "(1,7)"]);
    expect(h.calls.some((c) => c[0] === "limit" && (c[1] as number) <= 100)).toBe(true);
  });
  it("no valid portfolio, or a bad wallet: an empty answer / 400, no query", async () => {
    __setDevnetV22ForTest(true);
    expect(await (await call("?portfolios=junk")).json()).toEqual({ available: true, events: [] });
    expect((await call(`?portfolios=${P1}`, "nope")).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
  it("a database error is 'unavailable', never a 500", async () => {
    __setDevnetV22ForTest(true);
    h.error = { message: "relation v22_events does not exist" };
    const r = await call(`?portfolios=${P1}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ available: false, events: [] });
  });
});
