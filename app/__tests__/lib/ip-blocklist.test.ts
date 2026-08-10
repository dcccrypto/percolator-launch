/**
 * Regression — GH#2486: the IP blocklist must work for IPv6, not just IPv4.
 *
 * The old inline implementation in middleware.ts parsed with `_ipToInt`, which
 * returned -1 for anything that wasn't four dotted octets. Two distinct effects,
 * and it matters which is which:
 *
 *   - IPv6 CIDR entries were DROPPED at parse time (`net === -1 → null`), so no
 *     IPv6 range could be banned at all.
 *   - Bare IPv6 entries were NOT dropped — they fell through to
 *     `{ type: "exact", ip: entry }` and matched by string equality. So a ban
 *     worked only for the exact spelling supplied. IPv6 has many textual forms
 *     for one address, so the same host in expanded, uppercase, or bracketed
 *     form walked straight past its own ban.
 *
 * Both are asserted below, plus the wiring: middleware must use this module and
 * carry no inline IPv4-only parser (a unit test of the matcher alone stays green
 * if middleware keeps its own copy).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isIpBlocked, parseBlocklist, parseIp } from "@/lib/ip-blocklist";

describe("parseIp", () => {
  it("parses IPv4", () => {
    expect(parseIp("192.168.1.100")?.family).toBe(4);
    expect(Array.from(parseIp("192.168.1.100")!.bytes)).toEqual([192, 168, 1, 100]);
  });

  it("parses every textual form of one IPv6 address to the same bytes", () => {
    const forms = [
      "2001:db8::1",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
      "2001:DB8::1",
      "[2001:db8::1]",
      "[2001:db8::1]:443",
      "2001:db8::1%eth0",
    ];
    const expected = Array.from(parseIp("2001:db8::1")!.bytes);
    for (const f of forms) {
      expect(Array.from(parseIp(f)!.bytes), f).toEqual(expected);
    }
  });

  it("folds IPv4-mapped IPv6 down to IPv4 (else the mapping is a bypass)", () => {
    const mapped = parseIp("::ffff:192.168.1.100");
    expect(mapped?.family).toBe(4);
    expect(Array.from(mapped!.bytes)).toEqual([192, 168, 1, 100]);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "unknown", "999.1.1.1", "1.2.3", "2001:db8::1::2", "not-an-ip", "0x7f.0.0.1"]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });

  it("rejects leading-zero IPv4 octets (010 must not slip past a ban on 10)", () => {
    expect(parseIp("010.0.0.1")).toBeNull();
  });
});

describe("blocklist matching — the GH#2486 bugs", () => {
  it("keeps IPv6 CIDR entries instead of dropping them", () => {
    const list = parseBlocklist(["2001:db8::/32"]);
    expect(list).toHaveLength(1); // old parser produced 0
    expect(isIpBlocked("2001:db8::99", list)).toBe(true);
    expect(isIpBlocked("2001:db9::99", list)).toBe(false);
  });

  it("blocks an IPv6 host in EVERY textual form, not just the spelling supplied", () => {
    const list = parseBlocklist(["2001:db8::1"]);
    for (const form of [
      "2001:db8::1",
      "2001:0db8:0000:0000:0000:0000:0000:0001", // old code: false
      "2001:DB8::1", // old code: false
      "[2001:db8::1]:443", // old code: false
    ]) {
      expect(isIpBlocked(form, list), form).toBe(true);
    }
  });

  it("still blocks IPv4 exactly and by CIDR (no regression)", () => {
    const list = parseBlocklist(["192.168.1.100", "10.0.0.0/8"]);
    expect(isIpBlocked("192.168.1.100", list)).toBe(true);
    expect(isIpBlocked("10.255.3.4", list)).toBe(true);
    expect(isIpBlocked("11.0.0.1", list)).toBe(false);
    expect(isIpBlocked("192.168.1.101", list)).toBe(false);
  });

  it("catches an IPv4 rule presented in IPv4-mapped IPv6 notation", () => {
    const list = parseBlocklist(["10.0.0.0/8"]);
    expect(isIpBlocked("::ffff:10.1.2.3", list)).toBe(true);
  });

  it("does not cross families (an IPv4 /8 must not swallow IPv6)", () => {
    const list = parseBlocklist(["10.0.0.0/8"]);
    expect(isIpBlocked("2001:db8::1", list)).toBe(false);
  });

  it("honours non-byte-aligned IPv6 prefixes", () => {
    const list = parseBlocklist(["2001:db8:8000::/33"]);
    expect(isIpBlocked("2001:db8:8000::5", list)).toBe(true);
    expect(isIpBlocked("2001:db8:7fff::5", list)).toBe(false);
  });

  it("never matches an unparseable client IP (incl. the 'unknown' sentinel)", () => {
    const list = parseBlocklist(["0.0.0.0/0"]);
    expect(isIpBlocked("unknown", list)).toBe(false);
    expect(isIpBlocked("", list)).toBe(false);
    expect(isIpBlocked("1.2.3.4", list)).toBe(true); // /0 does match a real v4
  });

  it("reports invalid entries instead of dropping them silently", () => {
    const seen: string[] = [];
    const list = parseBlocklist(["1.2.3.4", "nonsense", "2001:db8::/200"], (e) => seen.push(e));
    expect(list).toHaveLength(1);
    expect(seen).toEqual(["nonsense", "2001:db8::/200"]);
  });

  it("an empty blocklist blocks nothing", () => {
    expect(isIpBlocked("1.2.3.4", [])).toBe(false);
  });
});

describe("middleware uses the shared matcher", () => {
  const src = readFileSync(resolve(__dirname, "../../middleware.ts"), "utf8");

  it("calls isIpBlocked / parseBlocklist", () => {
    expect(src).toContain("isIpBlocked(");
    expect(src).toContain("parseBlocklist(");
  });

  it("has no inline IPv4-only parser left", () => {
    // The exact shape that caused this: split on "." and bail on != 4 parts.
    expect(src).not.toMatch(/split\("\."\)\.map\(Number\)/);
    // Match a re-declared parser, not the comment that records why it went —
    // that history is worth keeping in the file.
    expect(src).not.toMatch(/function\s+_ipToInt/);
  });
});
