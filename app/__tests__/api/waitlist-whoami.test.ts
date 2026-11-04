/**
 * POST /api/waitlist/whoami — the waitlist page's "welcome back" lookup, and the
 * only way back in for a member who joined by email (the email tab's sign-in).
 *
 * An early email member whose row missed the referral-code backfill used to be
 * reported `found: false` forever; the verified session now earns the row its
 * code. A lookup outage must not read as "not on the list".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivyAuthOk } from "@/lib/privy-auth";
import { fakeWaitlistSupabase, fillerRows, type FakeRow } from "../helpers/fakeWaitlistSupabase";

const h = vi.hoisted(() => ({ client: null as unknown, auth: null as unknown }));
vi.mock("@/lib/waitlist/supabase", () => ({ getWaitlistServiceSupabase: () => h.client }));
vi.mock("@/lib/privy-auth", () => ({ verifyPrivyAuth: async () => h.auth }));

import { POST } from "@/app/api/waitlist/whoami/route";

const auth = (over: Partial<PrivyAuthOk> = {}): PrivyAuthOk => ({
  ok: true,
  userId: "did:privy:me",
  email: null,
  emails: [],
  solanaWallets: [],
  ...over,
});
const call = async () => {
  const res = await POST(new Request("https://percolator.trade/api/waitlist/whoami", { method: "POST" }));
  return { status: res.status, body: await res.json() };
};
const use = (rows: FakeRow[], opts = {}) => {
  const f = fakeWaitlistSupabase(rows, opts);
  h.client = f.client;
  return f;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("email members", () => {
  it("a verified email finds its row, with code and position", async () => {
    use([...fillerRows(2), { id: "row-e", email: "early@x.io", referral_code: "EARLYCDE" }]);
    h.auth = auth({ email: "early@x.io", emails: ["early@x.io"] });
    expect(await call()).toEqual({ status: 200, body: { found: true, referral_code: "EARLYCDE", position: 3, returning: true } });
  });

  it("an early row without a referral code is given one, not reported missing", async () => {
    const rows: FakeRow[] = [...fillerRows(1), { id: "row-old", email: "early@x.io", referral_code: null }];
    use(rows);
    h.auth = auth({ email: "early@x.io", emails: ["early@x.io"] });
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ found: true, position: 2 });
    expect(body.referral_code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(rows[1].referral_code).toBe(body.referral_code);
  });

  it("matches a row stored in mixed case, and any verified email (not only the first)", async () => {
    use([{ id: "row-m", email: "Second@X.io", referral_code: "SECONDCD" }]);
    h.auth = auth({ email: "first@x.io", emails: ["first@x.io", "second@x.io"] });
    expect((await call()).body).toMatchObject({ found: true, referral_code: "SECONDCD" });
  });

  it("an existing code is never rewritten", async () => {
    const rows: FakeRow[] = [{ id: "row-k", email: "k@x.io", referral_code: "KEEPCODE" }];
    const { calls } = use(rows);
    h.auth = auth({ email: "k@x.io", emails: ["k@x.io"] });
    expect((await call()).body.referral_code).toBe("KEEPCODE");
    expect(calls.some((c) => c.kind === "update" && c.column === "referral_code")).toBe(false);
  });
});

describe("CONTROL", () => {
  it("an email with no row is found: false", async () => {
    use(fillerRows(3));
    h.auth = auth({ email: "nobody@x.io", emails: ["nobody@x.io"] });
    expect(await call()).toEqual({ status: 200, body: { found: false } });
  });

  it("a lookup outage is a 500, not found: false", async () => {
    use([{ id: "row-e", email: "early@x.io", referral_code: "EARLYCDE" }], { failColumn: "email" });
    h.auth = auth({ email: "early@x.io", emails: ["early@x.io"] });
    expect((await call()).status).toBe(500);
  });

  it("a code that cannot be assigned is a 500, not found: false", async () => {
    use([{ id: "row-old", email: "early@x.io", referral_code: null }], { failUpdate: "XX000" });
    h.auth = auth({ email: "early@x.io", emails: ["early@x.io"] });
    expect((await call()).status).toBe(500);
  });

  it("an unauthenticated caller learns nothing", async () => {
    use([{ id: "row-e", email: "early@x.io", referral_code: "EARLYCDE" }]);
    h.auth = { ok: false, status: 401, reason: "missing token" };
    const { status, body } = await call();
    expect(status).toBe(401);
    expect(JSON.stringify(body)).not.toMatch(/EARLYCDE|found/);
  });
});
