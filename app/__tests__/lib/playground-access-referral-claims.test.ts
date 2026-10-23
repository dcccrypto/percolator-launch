// @vitest-environment node
/**
 * Portfolio > Referrals: the optional `ref` (referral code, from #3191) and `uid` (keyed Privy-user tag)
 * claims, proven against the gate's mint side (fixture: a verbatim copy of percolator.trade's
 * lib/playground-access.ts with those claims).
 */
import { describe, expect, it } from "vitest";
import * as gate from "../fixtures/gate-playground-access.uid";
import { mintSession, privyUserTag, readHandoff, readSession } from "@/lib/playground-access";
import { decideEnter } from "@/lib/playground-enter";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;
const DID = "did:privy:cm1abcdefghijklmnop";

describe("privyUserTag is byte-compatible with the gate", () => {
  it("the playground's Web Crypto tag equals the gate's Node tag", async () => {
    expect(await privyUserTag(DID, SECRET)).toBe(gate.privyUserTag(DID, SECRET));
  });

  // Shared vector, pinned identically on percolator.trade (`main`, __tests__/lib/playground-access.test.ts):
  // if either side changes the derivation, both suites break even though neither imports the other.
  it("matches the vector the gate pins", async () => {
    expect(await privyUserTag("did:privy:cm1owner000000000000", "s".repeat(40))).toBe("S6aKBBv7X44b_af1E6gH5w");
  });

  it("is 22 base64url chars, differs per user and per secret, and never contains the id", async () => {
    const t = await privyUserTag(DID, SECRET);
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(t).not.toBe(await privyUserTag(`${DID}x`, SECRET));
    expect(t).not.toBe(await privyUserTag(DID, "o".repeat(40)));
    expect(t).not.toContain("privy");
  });
});

describe("a gate handoff carries ref + uid into the session", () => {
  it("handoff -> /enter -> session keeps both claims", async () => {
    const uid = gate.privyUserTag(DID, SECRET);
    const handoff = gate.mintHandoff("row-1", 12, SECRET, NOW, "AB23XYZ9", uid);
    expect(await readHandoff(handoff, SECRET, NOW)).toMatchObject({ ref: "AB23XYZ9", uid });

    const out = await decideEnter({ token: handoff, team: null }, { PLAYGROUND_ACCESS_SECRET: SECRET }, async () => true, NOW);
    expect(out.ok).toBe(true);
    const session = out.ok ? out.cookie : "";
    expect(await readSession(session, SECRET, NOW)).toMatchObject({ sub: "row-1", ref: "AB23XYZ9", uid });
  });

  it("an older handoff without the claims still enters, and the session has neither", async () => {
    const handoff = gate.mintHandoff("row-1", 12, SECRET, NOW);
    const out = await decideEnter({ token: handoff, team: null }, { PLAYGROUND_ACCESS_SECRET: SECRET }, async () => true, NOW);
    expect(out.ok).toBe(true);
    const claims = await readSession(out.ok ? out.cookie : "", SECRET, NOW);
    expect(claims).not.toBeNull();
    expect(claims).not.toHaveProperty("ref");
    expect(claims).not.toHaveProperty("uid");
  });
});

describe("malformed optional claims are dropped, never a reason to refuse", () => {
  it.each([
    ["ref with a slash", { ref: "AB/../x" }, "ref"],
    ["ref too long", { ref: "A".repeat(33) }, "ref"],
    ["uid wrong length", { uid: "short" }, "uid"],
    ["uid not base64url", { uid: "!".repeat(22) }, "uid"],
  ])("%s", async (_name, extra, key) => {
    const session = await mintSession("row-1", 12, SECRET, NOW, (extra as { ref?: string }).ref, (extra as { uid?: string }).uid);
    const claims = await readSession(session, SECRET, NOW);
    expect(claims).toMatchObject({ sub: "row-1", pos: 12 });
    expect(claims).not.toHaveProperty(key);
  });

  it("an edited ref breaks the signature", async () => {
    const session = await mintSession("row-1", 12, SECRET, NOW, "AB23XYZ9", await privyUserTag(DID, SECRET));
    const [body, mac] = session.split(".");
    const json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    json.ref = "ZZZZZZZZ";
    const forged = `${Buffer.from(JSON.stringify(json)).toString("base64url")}.${mac}`;
    expect(await readSession(forged, SECRET, NOW)).toBeNull();
  });
});
