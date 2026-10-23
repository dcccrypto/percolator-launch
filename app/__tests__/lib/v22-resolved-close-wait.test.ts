/**
 * SEC-RC §S16AC Info I-S1: the S1-6 a/c resolved-close wait is recognised ONLY on a deployed S1-6 a/c wrapper.
 * Fixtures: the first 4096 ELF bytes of the 4 canonical builds (RC-S16AC.md §2/§8.1 and RC.md):
 *   rc-s16ac ddd5a2fa and rollback-s16ac bae71e12 (engine e59aa6a6) -> S1-6 a/c;
 *   RC 357fc23f and RC rollback fac4d19c (engine 1c96c22f) -> NOT (the negative controls).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RESOLVED_CLOSE_WAIT_COPY,
  __resetResolvedCloseWaitCache,
  __setResolvedCloseWaitForTest,
  classifyS16acElfPrefix,
  isResolvedCloseWait,
  resolvedCloseWaitLive,
} from "@/lib/v22/resolved-close-wait";
import { DEVNET_PROGRAM_IDS, DEVNET_V22_PROGRAM_IDS } from "@/lib/program-ids";

const elf = (n: string): Uint8Array =>
  new Uint8Array(Buffer.from(readFileSync(path.join(__dirname, "../fixtures/v22-s16ac", `wrapper-elf4096-${n}.b64`), "utf8").trim(), "base64"));
const ELF = {
  s16ac: elf("rc-s16ac-ddd5a2fa"),
  s16acRollback: elf("rollback-s16ac-bae71e12"),
  rc: elf("rc-357fc23f"),
  rcRollback: elf("rollback-fac4d19c"),
  // RC2 (RC2.md §3): the build that will ship.
  rc2s16ac: elf("rc2-s16ac-4fe8fd53"),
  rc2s16acRollback: elf("rollback2-s16ac-b6aec357"),
  rc2: elf("rc2-cc720a0e"),
  // RC2.2 (decision Option B, 2026-10-22): canonical = the S1-6 a/c twin; the plain twins are the negative controls.
  rc22s16ac: elf("rc22-s16ac-776d2491"),
  rollback4bS16ac: elf("rollback4b-s16ac-3958c36b"),
  rc22: elf("rc22-9b630735"),
  rollback4b: elf("rollback4b-71a891b9"),
  rc2Rollback: elf("rollback2-8b57d488"),
};
const W = DEVNET_V22_PROGRAM_IDS.wrapper;
const PD = new PublicKey("C6yjMetoTgaiUQLPYYJcYwyy7atrBFd7eNkpWbf89obG");

/** A connection that serves the program account -> ProgramData -> `prefix` (or throws). */
function conn(prefix: Uint8Array | null | "throw") {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async getAccountInfo(k: PublicKey) {
      reads++;
      if (prefix === "throw") throw new Error("rpc down");
      if (k.toBase58() === W) {
        const d = new Uint8Array(36);
        d.set(PD.toBytes(), 4);
        return { data: Buffer.from(d), owner: PublicKey.default, lamports: 1, executable: true };
      }
      if (k.equals(PD)) return prefix ? { data: Buffer.from(prefix), owner: PublicKey.default, lamports: 1, executable: false } : null;
      return null;
    },
  };
}

beforeEach(() => {
  __resetResolvedCloseWaitCache();
  __setResolvedCloseWaitForTest(null);
});
afterEach(() => __setResolvedCloseWaitForTest(null));

describe("I-S1 gate: classifyS16acElfPrefix", () => {
  it("the S1-6 a/c variant and its same-engine rollback are recognised", async () => {
    expect(await classifyS16acElfPrefix(W, ELF.s16ac)).toBe("s16ac");
    expect(await classifyS16acElfPrefix(W, ELF.s16acRollback)).toBe("s16ac");
  });
  it("NEGATIVE CONTROL: the RC and its rollback (engine 1c96c22f) are not", async () => {
    expect(await classifyS16acElfPrefix(W, ELF.rc)).toBe("other");
    expect(await classifyS16acElfPrefix(W, ELF.rcRollback)).toBe("other");
  });
  it("RC2 (the shipping build): rc2-s16ac 4fe8fd53 + rollback2-s16ac b6aec357 are S1-6 a/c", async () => {
    expect(await classifyS16acElfPrefix(W, ELF.rc2s16ac)).toBe("s16ac");
    expect(await classifyS16acElfPrefix(W, ELF.rc2s16acRollback)).toBe("s16ac");
  });
  it("NEGATIVE CONTROL: plain RC2 cc720a0e and rollback2 8b57d488 (engine 1c96c22f) are not", async () => {
    expect(await classifyS16acElfPrefix(W, ELF.rc2)).toBe("other");
    expect(await classifyS16acElfPrefix(W, ELF.rc2Rollback)).toBe("other");
  });
  it("RC2.2 canonical (Option B): rc22-s16ac 776d2491 + rollback4b-s16ac 3958c36b are S1-6 a/c", async () => {
    expect(await classifyS16acElfPrefix(W, ELF.rc22s16ac)).toBe("s16ac");
    expect(await classifyS16acElfPrefix(W, ELF.rollback4bS16ac)).toBe("s16ac");
  });
  it("NEGATIVE CONTROL: plain rc22 9b630735 and rollback4b 71a891b9 (engine 1c96c22f) must read OFF", async () => {
    expect(await classifyS16acElfPrefix(W, ELF.rc22)).toBe("other");
    expect(await classifyS16acElfPrefix(W, ELF.rollback4b)).toBe("other");
  });
  it("RC2.2 fixtures are the canonical artifacts' first 4096 bytes (sha256 prefixes)", async () => {
    const { sha256Hex } = await import("@/lib/program-upgrade-detect");
    expect(await sha256Hex(ELF.rc22s16ac)).toMatch(/^29c9f50049d60617/);
    expect(await sha256Hex(ELF.rollback4bS16ac)).toMatch(/^5f364f924c39e2f1/);
    expect(await sha256Hex(ELF.rc22)).toMatch(/^02e3d1b7/);
    expect(await sha256Hex(ELF.rollback4b)).toMatch(/^c66cc394/);
  });
  it("another program id is never S1-6 a/c, even with the variant's bytes; short / zeroed bytes are unknown", async () => {
    expect(await classifyS16acElfPrefix(DEVNET_PROGRAM_IDS.wrapper, ELF.s16ac)).toBe("other");
    expect(await classifyS16acElfPrefix(W, null)).toBe("unknown");
    expect(await classifyS16acElfPrefix(W, ELF.s16ac.subarray(0, 100))).toBe("unknown");
    expect(await classifyS16acElfPrefix(W, new Uint8Array(4096))).toBe("unknown");
  });
});

describe("I-S1 gate: resolvedCloseWaitLive (reads the deployed ProgramData)", () => {
  it("true on the deployed variant; cached", async () => {
    const c = conn(ELF.s16ac);
    expect(await resolvedCloseWaitLive(c, W)).toBe(true);
    const n = c.reads;
    expect(await resolvedCloseWaitLive(c, W)).toBe(true);
    expect(c.reads).toBe(n);
  });
  it("NEGATIVE CONTROL: false on the deployed RC, on a failed read, and for a non-v2.2 wrapper (no read at all)", async () => {
    expect(await resolvedCloseWaitLive(conn(ELF.rc), W)).toBe(false);
    __resetResolvedCloseWaitCache();
    expect(await resolvedCloseWaitLive(conn("throw"), W)).toBe(false);
    const c = conn(ELF.s16ac);
    expect(await resolvedCloseWaitLive(c, DEVNET_PROGRAM_IDS.wrapper)).toBe(false);
    expect(c.reads).toBe(0);
  });
});

describe("I-S1: isResolvedCloseWait", () => {
  it("21 raised by the CloseResolved itself, gate live -> the wait", () => {
    expect(isResolvedCloseWait({ index: 1, code: 21 }, 1, true)).toBe(true);
  });
  it("NEGATIVE CONTROLS: gate off, another code, or a 21 from another instruction (the ATA create) -> not the wait", () => {
    expect(isResolvedCloseWait({ index: 1, code: 21 }, 1, false)).toBe(false);
    expect(isResolvedCloseWait({ index: 1, code: 14 }, 1, true)).toBe(false);
    expect(isResolvedCloseWait({ index: 0, code: 21 }, 1, true)).toBe(false);
    expect(isResolvedCloseWait(null, 1, true)).toBe(false);
  });
  it("the copy is one calm line: waiting for the other side, the close goes through after; no error words", () => {
    expect(RESOLVED_CLOSE_WAIT_COPY).toMatch(/waiting for the other side to settle/);
    expect(RESOLVED_CLOSE_WAIT_COPY).toMatch(/close will go through/);
    expect(RESOLVED_CLOSE_WAIT_COPY).not.toMatch(/error|failed|locked|custom|0x15|21/i);
  });
});
