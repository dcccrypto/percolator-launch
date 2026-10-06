// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { isAllocateRefusal, isRiskIncreasing, planAllocatePrefix } from "@/lib/v21/allocate-prefix";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { TAG_VAULT_LP_ALLOCATE, deriveVaultLpExt, decodeVaultLpExtV19, encodeVaultLpAllocate, VAULT_LP_EXT_ACCOUNT_LEN } from "@/lib/v21/sdk";
import { deriveLpVaultRegistryPda, deriveVaultLpState } from "@/lib/limits/p3-ix";
import { registryBytes, vaultLpStateBytes } from "./fixtures";

const k = () => Keypair.generate().publicKey;
const PROG = k();
const MARKET = k();
const CRANKER = k();
const LP = k();

afterEach(() => __setDevnetV21ForTest(null));

function fakeConn(over: { bound?: boolean; missing?: boolean; foreignOwner?: boolean } = {}) {
  const owner = over.foreignOwner ? k() : PROG;
  const infos = over.missing
    ? [null, null]
    : [
        { owner, data: Buffer.from(registryBytes({ bound: over.bound ?? true, domain: 0 })) },
        { owner, data: Buffer.from(vaultLpStateBytes(LP.toBytes())) },
      ];
  return { getAccountInfo: vi.fn(), getMultipleAccountsInfo: vi.fn(async () => infos) } as never;
}
const ok = vi.fn(async () => ({ err: null, rpcFailed: false }));
const plan = (conn: unknown, sim = ok, over: { beforeQ?: bigint | null; signedSizeQ?: bigint } = {}) =>
  planAllocatePrefix({ connection: conn as never, simulate: sim }, { programId: PROG, market: MARKET, cranker: CRANKER, beforeQ: over.beforeQ ?? 0n, signedSizeQ: over.signedSizeQ ?? 5n });

describe("isRiskIncreasing", () => {
  it("opens, adds and flips increase; closes and reduces do not", () => {
    expect(isRiskIncreasing(0n, 5n)).toBe(true);
    expect(isRiskIncreasing(10n, 5n)).toBe(true);
    expect(isRiskIncreasing(-10n, -5n)).toBe(true);
    expect(isRiskIncreasing(10n, -15n)).toBe(true); // flip
    expect(isRiskIncreasing(10n, -10n)).toBe(false); // close
    expect(isRiskIncreasing(10n, -4n)).toBe(false); // reduce
    expect(isRiskIncreasing(-10n, 4n)).toBe(false);
    expect(isRiskIncreasing(10n, 0n)).toBe(false);
    expect(isRiskIncreasing(null, 5n)).toBe(true); // unknown position: treated as an open
  });
});

describe("tag 103 rides only where it is allowed", () => {
  it("flag OFF (today): never built, and the network is never touched", async () => {
    __setDevnetV21ForTest(false);
    const conn = fakeConn();
    expect(await plan(conn)).toEqual([]);
    expect((conn as { getMultipleAccountsInfo: ReturnType<typeof vi.fn> }).getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
  it("flag ON, bound market, an open: one 103 with the nine accounts in the wrapper's order", async () => {
    __setDevnetV21ForTest(true);
    const ixs = await plan(fakeConn());
    expect(ixs).toHaveLength(1);
    const ix = ixs[0];
    expect(ix.data[0]).toBe(103);
    expect(ix.data).toHaveLength(17);
    expect(ix.keys).toHaveLength(9);
    const reg = deriveLpVaultRegistryPda(PROG, MARKET);
    const st = deriveVaultLpState(PROG, MARKET);
    expect(ix.keys.map((m) => m.pubkey.toBase58())).toEqual([
      CRANKER, MARKET, reg, st, LP, ix.keys[5].pubkey, ix.keys[6].pubkey, deriveVaultLpExt(PROG, MARKET), PublicKey.default,
    ].map((p) => p.toBase58()));
    expect(ix.keys.map((m) => `${m.isSigner ? "s" : "-"}${m.isWritable ? "w" : "-"}`).join(" ")).toBe("sw -w -w -w -w -w -w -w --");
  });
  it("a CLOSE or a reduce never carries it, so a refusal can never block an exit", async () => {
    __setDevnetV21ForTest(true);
    const conn = fakeConn();
    expect(await plan(conn, ok, { beforeQ: 10n, signedSizeQ: -10n })).toEqual([]);
    expect(await plan(conn, ok, { beforeQ: -10n, signedSizeQ: 3n })).toEqual([]);
    expect(ok).not.toHaveBeenCalled();
  });
  it("not bound, or the accounts are missing / foreign: nothing", async () => {
    __setDevnetV21ForTest(true);
    expect(await plan(fakeConn({ bound: false }))).toEqual([]);
    expect(await plan(fakeConn({ missing: true }))).toEqual([]);
    expect(await plan(fakeConn({ foreignOwner: true }))).toEqual([]);
  });
  it("sim-gated: kept only if the 103 alone simulates clean (no room / drawing / impaired is not an error)", async () => {
    __setDevnetV21ForTest(true);
    expect(await plan(fakeConn(), vi.fn(async () => ({ err: { InstructionError: [0, { Custom: 100 }] }, rpcFailed: false })))).toEqual([]);
    expect(await plan(fakeConn(), vi.fn(async () => ({ err: null, rpcFailed: true })))).toEqual([]);
  });
  it("never throws: a failing read yields no prefix", async () => {
    __setDevnetV21ForTest(true);
    const conn = { getAccountInfo: vi.fn(), getMultipleAccountsInfo: vi.fn(async () => { throw new Error("rpc"); }) } as never;
    expect(await plan(conn)).toEqual([]);
  });
});

describe("refusal 100 and the wire", () => {
  it("isAllocateRefusal recognises Custom 100 in every shape and nothing else", () => {
    expect(isAllocateRefusal(new Error("custom program error: 0x64"))).toBe(true);
    expect(isAllocateRefusal(new Error('{"InstructionError":[1,{"Custom":100}]}'))).toBe(true);
    expect(isAllocateRefusal({ InstructionError: [0, { Custom: 100 }] })).toBe(true);
    expect(isAllocateRefusal(new Error("custom program error: 0x65"))).toBe(false);
    expect(isAllocateRefusal("user rejected")).toBe(false);
  });
  it("encodeVaultLpAllocate is [103, u128 LE]", () => {
    expect(TAG_VAULT_LP_ALLOCATE).toBe(103);
    const b = encodeVaultLpAllocate((1n << 128n) - 1n);
    expect([...b.subarray(0, 3)]).toEqual([103, 255, 255]);
    expect(encodeVaultLpAllocate(258n).subarray(0, 4)).toEqual(Uint8Array.of(103, 2, 1, 0));
    expect(() => encodeVaultLpAllocate(-1n)).toThrow();
  });
  it("VaultLpExtV19 decodes at +16: alpha 50%, buffer 30% are the wrapper defaults", () => {
    const a = new Uint8Array(VAULT_LP_EXT_ACCOUNT_LEN);
    const dv = new DataView(a.buffer);
    dv.setBigUint64(16 + 32, 7n, true);
    dv.setUint16(16 + 96, 5_000, true);
    dv.setUint16(16 + 98, 3_000, true);
    a[16 + 104] = 1;
    const x = decodeVaultLpExtV19(a)!;
    expect(x.allocatedAtoms).toBe(7n);
    expect(x.allocAlphaBps).toBe(5_000);
    expect(x.allocBufferBps).toBe(3_000);
    a[16 + 104] = 0;
    expect(decodeVaultLpExtV19(a)).toBeNull();
    expect(decodeVaultLpExtV19(new Uint8Array(10))).toBeNull();
  });
});
