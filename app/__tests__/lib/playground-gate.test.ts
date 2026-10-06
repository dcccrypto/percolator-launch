/**
 * lib/playground-gate — the verdict behind both /authorize and /enter.
 *
 * Membership and position must match /api/waitlist/whoami (so a member reading
 * "#812" is judged on #812), and every failure must close the door without
 * being mislabelled as "not on the list" or "in the queue".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decidePlaygroundAccess } from "@/lib/playground-gate";
import type { PrivyAuthOk } from "@/lib/privy-auth";
import { fakeWaitlistSupabase, fillerRows } from "../helpers/fakeWaitlistSupabase";

const auth = (over: Partial<PrivyAuthOk> = {}): PrivyAuthOk => ({
  ok: true,
  userId: "did:privy:me",
  email: null,
  emails: [],
  solanaWallets: [],
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("resolution order mirrors whoami", () => {
  it("DID match inside the cutoff is granted, with the row id and RPC position", async () => {
    const { client } = fakeWaitlistSupabase([
      ...fillerRows(4),
      { id: "row-me", privy_did: "did:privy:me", pubkey: "MYPUBKEY", referral_code: "ME" },
    ]);
    const v = await decidePlaygroundAccess(auth(), () => client, 1000);
    expect(v).toEqual({ kind: "granted", rowId: "row-me", position: 5, cutoff: 1000, referralCode: "ME" });
  });

  it("matches on ANY linked wallet, not just the first", async () => {
    const { client } = fakeWaitlistSupabase([{ id: "row-w", pubkey: "SECOND", referral_code: "W" }]);
    const v = await decidePlaygroundAccess(auth({ solanaWallets: ["FIRST", "SECOND"] }), () => client, 1000);
    expect(v.kind).toBe("granted");
  });

  it("matches on ANY verified email, not just the primary", async () => {
    const { client } = fakeWaitlistSupabase([{ id: "row-e", email: "second@x.io", referral_code: "E" }]);
    const v = await decidePlaygroundAccess(
      auth({ email: "first@x.io", emails: ["first@x.io", "second@x.io"] }),
      () => client,
      1000,
    );
    expect(v.kind).toBe("granted");
  });

  it("2026-10-02 live: an email-only signup (no DID, no wallet) is granted on its verified email, any casing", async () => {
    const rows = [...fillerRows(1), { id: "row-k", email: "Khubairnasir26@Gmail.com", referral_code: "K" }];
    const { client, calls } = fakeWaitlistSupabase(rows);
    const v = await decidePlaygroundAccess(auth({ emails: ["khubairnasir26@gmail.com"] }), () => client, 1000);
    expect(v).toMatchObject({ kind: "granted", rowId: "row-k" });
    // ...and the DID is stored so the next sign-in matches directly.
    expect(calls.some((c) => c.kind === "update")).toBe(true);
    expect(rows[1].privy_did).toBe("did:privy:me");
  });

  it("a row with no referral code is not a membership (whoami's definition)", async () => {
    const { client } = fakeWaitlistSupabase([{ id: "row-half", privy_did: "did:privy:me", pubkey: "P", referral_code: null }]);
    expect(await decidePlaygroundAccess(auth(), () => client, 1000)).toEqual({ kind: "not_member" });
  });

  it("no row at all is not_member — the same verdict, nothing more", async () => {
    const { client } = fakeWaitlistSupabase(fillerRows(3));
    expect(await decidePlaygroundAccess(auth(), () => client, 1000)).toEqual({ kind: "not_member" });
  });
});

describe("the cutoff", () => {
  it("position == cutoff is in; cutoff + 1 is told its own position", async () => {
    const rows = [...fillerRows(999), { id: "row-me", privy_did: "did:privy:me", pubkey: "ME1000", referral_code: "ME" }];
    const at = await decidePlaygroundAccess(auth(), () => fakeWaitlistSupabase(rows).client, 1000);
    expect(at).toMatchObject({ kind: "granted", position: 1000 });

    const past = [...fillerRows(1000), { id: "row-me", privy_did: "did:privy:me", pubkey: "ME1001", referral_code: "ME" }];
    const v = await decidePlaygroundAccess(auth(), () => fakeWaitlistSupabase(past).client, 1000);
    expect(v).toEqual({ kind: "not_yet", position: 1001, cutoff: 1000 });
  });
});

describe("fails CLOSED, and says so honestly", () => {
  const me = { id: "row-me", privy_did: "did:privy:me", pubkey: "MYPUBKEY", email: "me@x.io", referral_code: "ME" };

  it("a Supabase error on the row lookup is unavailable, not 'not on the list'", async () => {
    // supabase-js returns { error } rather than throwing; ignoring it would
    // tell a real member they are not a member.
    const { client } = fakeWaitlistSupabase([me], { failColumn: "privy_did" });
    expect(await decidePlaygroundAccess(auth(), () => client, 1000)).toEqual({ kind: "unavailable" });
  });

  it("a position RPC error is unavailable, not 'in the queue'", async () => {
    const { client } = fakeWaitlistSupabase([me], { failRpc: true });
    expect(await decidePlaygroundAccess(auth(), () => client, 1000)).toEqual({ kind: "unavailable" });
  });

  it("a member with an unreadable position is unavailable", async () => {
    const { client } = fakeWaitlistSupabase([me], { rpcValue: null });
    expect(await decidePlaygroundAccess(auth(), () => client, 1000)).toEqual({ kind: "unavailable" });
  });

  it("an unconfigured client (getter throws) is unavailable", async () => {
    const v = await decidePlaygroundAccess(auth(), () => {
      throw new Error("env vars not set");
    }, 1000);
    expect(v).toEqual({ kind: "unavailable" });
  });

  it("never logs an email or a wallet — only the DID", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = fakeWaitlistSupabase([me], { failColumn: "email" });
    await decidePlaygroundAccess(
      auth({ userId: "did:privy:nobody", emails: ["me@x.io"], solanaWallets: ["NOTMINE"] }),
      () => client,
      1000,
    );
    expect(warn).toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("did:privy:nobody");
    expect(logged).not.toContain("me@x.io");
    expect(logged).not.toContain("NOTMINE");
  });
});
