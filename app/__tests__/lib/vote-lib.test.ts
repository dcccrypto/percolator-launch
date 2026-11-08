/**
 * Pure vote helpers: Ed25519 verification (genuine signatures from freshly
 * generated SYNTHETIC keypairs), outcome rule, exact formatting, strict body
 * parsing, admin header auth.
 */
import { describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import nacl from "tweetnacl";

vi.mock("server-only", () => ({}));

import { verifyVoteSignature, decodeCanonical } from "@/lib/allocation-vote/vote-verify";
import { buildVoteMessage, START_CONFIRMATION } from "@/lib/allocation-vote/vote-message";
import { decideWinner, formatUnits, sharePercent } from "@/lib/allocation-vote/vote-tally";
import { parseChallenge, parseSubmit } from "@/lib/allocation-vote/vote-request";
import { isAdminAuthorized, readVoteAdminSecret } from "@/lib/allocation-vote/vote-admin";

const L = (1n << 252n) + 27742317777372353535851937790883648493n; // RFC 8032 group order

it("vote-verify uses the RFC 8032 group order", async () => {
  const src = (await import("node:fs")).readFileSync(require("node:path").resolve(__dirname, "../../lib/allocation-vote/vote-verify.ts"), "utf8");
  const lit = /const L_BYTES = \[([^\]]*)\]/.exec(src)![1]!;
  const bytes = lit.split(",").map((x) => x.trim()).filter(Boolean).map((x) => Number(x));
  expect(bytes).toHaveLength(32);
  expect(bytes.reduceRight((a, b) => (a << 8n) | BigInt(b), 0n)).toBe(L);
});
const kp = nacl.sign.keyPair();
const wallet = bs58.encode(kp.publicKey);
const fields = { choice: "buy-and-burn" as const, wallet, nonce: "0f".repeat(32), issuedAt: "2026-11-08T01:00:00.000Z", expiresAt: "2026-11-08T01:05:00.000Z" };
const message = buildVoteMessage(fields);
const sign = (m: string, sk = kp.secretKey) => nacl.sign.detached(Uint8Array.from(Buffer.from(m, "utf8")), sk);

describe("verifyVoteSignature", () => {
  it("accepts a genuine signature of the exact message", () => {
    const sig = sign(message);
    expect(verifyVoteSignature(wallet, message, bs58.encode(sig))).toEqual(Uint8Array.from(sig));
  });

  it("rejects another wallet's signature, any message edit, and a choice swap", () => {
    const other = nacl.sign.keyPair();
    expect(verifyVoteSignature(wallet, message, bs58.encode(sign(message, other.secretKey)))).toBeNull();
    expect(verifyVoteSignature(wallet, message + " ", bs58.encode(sign(message)))).toBeNull();
    const swapped = buildVoteMessage({ ...fields, choice: "weekly-fee-claims" });
    expect(verifyVoteSignature(wallet, swapped, bs58.encode(sign(message)))).toBeNull();
  });

  it("rejects a malleated signature (S + L) that tweetnacl alone might accept", () => {
    const sig = sign(message);
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
    let t = s + L;
    const mal = Uint8Array.from(sig);
    for (let i = 32; i < 64; i++) {
      mal[i] = Number(t & 255n);
      t >>= 8n;
    }
    if (t === 0n) expect(verifyVoteSignature(wallet, message, bs58.encode(mal))).toBeNull();
  });

  it("rejects malformed/non-canonical encodings and wrong lengths", () => {
    const sig = bs58.encode(sign(message));
    for (const bad of ["", "0".repeat(88), sig.slice(1), sig + "1", " " + sig, 42, null, ["x"]]) {
      expect(verifyVoteSignature(wallet, message, bad)).toBeNull();
    }
    expect(verifyVoteSignature("1" + wallet, message, sig)).toBeNull();
    expect(decodeCanonical("1".repeat(32), 32)).not.toBeNull(); // 32 zero bytes, canonical
    expect(decodeCanonical("1".repeat(33), 32)).toBeNull();
  });
});

describe("decideWinner: balance weighted, ties and zero -> buy-and-burn", () => {
  it.each([
    [0n, 0n, "buy-and-burn"],
    [5n, 5n, "buy-and-burn"],
    [6n, 5n, "weekly-fee-claims"],
    [5n, 6n, "buy-and-burn"],
    [2n ** 70n + 1n, 2n ** 70n, "weekly-fee-claims"],
    [2n ** 70n, 2n ** 70n, "buy-and-burn"],
  ] as const)("fee=%s burn=%s -> %s", (fee, burn, want) => {
    expect(decideWinner(fee, burn)).toBe(want);
  });
  it("refuses negative tallies", () => {
    expect(() => decideWinner(-1n, 0n)).toThrow();
  });
});

describe("exact formatting", () => {
  it("formats base units without floats", () => {
    expect(formatUnits(18_446_744_073_709_551_615n, 6)).toBe("18446744073709.551615");
    expect(formatUnits(1_000_000n, 6)).toBe("1");
    expect(formatUnits(1n, 6)).toBe("0.000001");
    expect(formatUnits(0n, 6)).toBe("0");
    expect(formatUnits(36_893_488_147_419_103_230n, 0)).toBe("36893488147419103230");
  });
  it("share percent rounds down to 2 decimals and handles zero", () => {
    expect(sharePercent(1n, 3n)).toBe("33.33");
    expect(sharePercent(2n, 3n)).toBe("66.66");
    expect(sharePercent(0n, 0n)).toBe("0.00");
    expect(sharePercent(3n, 3n)).toBe("100.00");
  });
});

describe("strict request parsing", () => {
  it("challenge: exactly wallet + choice", () => {
    expect(parseChallenge(JSON.stringify({ wallet, choice: "buy-and-burn" }))).toEqual({ ok: true, wallet, choice: "buy-and-burn" });
    for (const body of [
      {}, { wallet }, { wallet, choice: "abstain" }, { wallet, choice: "buy-and-burn", extra: 1 },
      { wallet: [wallet], choice: "buy-and-burn" }, { wallet: ` ${wallet}`, choice: "buy-and-burn" },
      [{ wallet, choice: "buy-and-burn" }], { wallet: "0OIl", choice: "buy-and-burn" },
    ]) {
      expect(parseChallenge(JSON.stringify(body)).ok).toBe(false);
    }
    expect(parseChallenge("not json").ok).toBe(false);
    expect(parseChallenge("x".repeat(2000))).toMatchObject({ ok: false, status: 413 });
  });

  it("submit: exactly the six string fields, strict formats", () => {
    const good = { wallet, choice: "buy-and-burn", nonce: fields.nonce, issuedAt: fields.issuedAt, expiresAt: fields.expiresAt, signature: bs58.encode(sign(message)) };
    expect(parseSubmit(JSON.stringify(good)).ok).toBe(true);
    for (const patch of [
      { nonce: "0F".repeat(32) }, { nonce: "0f".repeat(31) }, { issuedAt: "2026-11-08T01:00:00Z" },
      { expiresAt: "tomorrow" }, { signature: "0x00" }, { choice: "BUY-AND-BURN" }, { extra: "1" }, { signature: 5 },
    ]) {
      expect(parseSubmit(JSON.stringify({ ...good, ...patch })).ok).toBe(false);
    }
  });
});

describe("admin auth", () => {
  const secret = "s".repeat(40);
  it("only Bearer <exact secret> passes", () => {
    expect(isAdminAuthorized(`Bearer ${secret}`, secret)).toBe(true);
    for (const h of [null, "", secret, `Basic ${secret}`, `Bearer ${secret}x`, `Bearer  ${secret}`, `bearer ${secret}`, `Bearer ${secret.slice(1)}`]) {
      expect(isAdminAuthorized(h, secret)).toBe(false);
    }
  });
  it("secret must be configured and >= 32 chars", () => {
    expect(readVoteAdminSecret({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readVoteAdminSecret({ VOTE_ADMIN_SECRET: "short" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(readVoteAdminSecret({ VOTE_ADMIN_SECRET: secret } as unknown as NodeJS.ProcessEnv)).toBe(secret);
  });
  it("start confirmation names the poll", () => {
    expect(START_CONFIRMATION).toBe("START perc-fee-policy-2026-11");
  });
});
