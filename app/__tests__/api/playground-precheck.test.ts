import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { fakeWaitlistSupabase } from "../helpers/fakeWaitlistSupabase";

const state = vi.hoisted(() => ({ client: null as unknown, fail: false }));
vi.mock("@/lib/waitlist/supabase", () => ({ getWaitlistServiceSupabase: () => state.client }));

const rows = [
  { id: "a", email: "khubairnasir26@gmail.com", referral_code: "K" },
  { id: "b", email: "half@x.io", referral_code: null },
];
let ipN = 0;
const req = (email: unknown, ip = `10.0.0.${++ipN}`) =>
  new NextRequest("https://percolator.trade/api/playground/precheck", {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify({ email }),
  });

describe("POST /api/playground/precheck — only send a code to a waitlist email", () => {
  beforeEach(() => { state.client = fakeWaitlistSupabase(rows).client; vi.resetModules(); });
  it("a member (any casing) is on the list", async () => {
    const { POST } = await import("@/app/api/playground/precheck/route");
    expect(await (await POST(req("KhubairNasir26@gmail.com "))).json()).toEqual({ onList: true });
  });
  it("a legacy row without a referral code is on the list (the gate gives it a code after sign-in)", async () => {
    const { POST } = await import("@/app/api/playground/precheck/route");
    expect(await (await POST(req("Half@x.io"))).json()).toEqual({ onList: true });
  });
  it("CONTROL: an unknown email or junk is not", async () => {
    const { POST } = await import("@/app/api/playground/precheck/route");
    expect(await (await POST(req("nobody@x.io"))).json()).toEqual({ onList: false });
    expect(await (await POST(req(42))).json()).toEqual({ onList: false });
  });
  it("rate-limited callers are told to wait, and the answer is the same for members and non-members", async () => {
    const { POST } = await import("@/app/api/playground/precheck/route");
    for (let i = 0; i < 8; i++) await POST(req("khubairnasir26@gmail.com", "9.9.9.9"));
    const member = await POST(req("khubairnasir26@gmail.com", "9.9.9.9"));
    const stranger = await POST(req("nobody@x.io", "9.9.9.9"));
    expect(member.status).toBe(429);
    expect(stranger.status).toBe(429);
    expect(await member.json()).toEqual({ onList: false, limited: true });
    expect(await stranger.json()).toEqual({ onList: false, limited: true });
  });
  it("the 8th try in the window is still answered normally", async () => {
    const { POST } = await import("@/app/api/playground/precheck/route");
    for (let i = 0; i < 7; i++) await POST(req("nobody@x.io", "8.8.8.8"));
    const r = await POST(req("khubairnasir26@gmail.com", "8.8.8.8"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ onList: true });
  });
  it("a DB failure fails open for the code only (access is still decided by the gate)", async () => {
    state.client = fakeWaitlistSupabase(rows, { failColumn: "email" }).client;
    const { POST } = await import("@/app/api/playground/precheck/route");
    expect(await (await POST(req("nobody@x.io"))).json()).toMatchObject({ onList: true, unverified: true });
  });
});
