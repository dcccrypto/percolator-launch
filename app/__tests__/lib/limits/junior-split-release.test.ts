// @vitest-environment node
/**
 * Tag 102 (Resolved) pays from ONE domain's backing bucket per call while its gate (`physical - C`) spans both
 * domains. A junior claim above the registry-domain bucket must therefore be split into two 102s, or the
 * remainder is refused / left unclaimed (LP lane, 2026-10-20: ~254M of a 1000M junior was left behind).
 */
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import * as C from "@/lib/limits/constants";
import { decodeTerminalBacking, decodeTerminalBackingDomains } from "@/lib/limits/decode";
import { buildJuniorResolvedReleaseIxs, splitJuniorRelease } from "@/lib/limits/junior-resolved-release";
import { encodeVaultLpReleaseSurplus } from "@/lib/limits/p3-ix";

const k = () => Keypair.generate().publicKey;
function market(buckets: [bigint, bigint]): Uint8Array {
  const d = new Uint8Array(C.assetEngineOff(1) + 1301);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, C.WRAPPER_MAGIC, true);
  v.setUint16(8, C.WRAPPER_VERSION_V18, true);
  d[10] = C.KIND_MARKET_ACCOUNT;
  const put = (off: number, x: bigint) => { v.setBigUint64(off, x & ((1n << 64n) - 1n), true); v.setBigUint64(off + 8, x >> 64n, true); };
  put(C.assetEngineOff(0) + C.SLOT_BACKING_LONG + C.BUCKET_FRESH_UNLIENED_BACKING_NUM, buckets[0] * C.BOUND_SCALE + 7n);
  put(C.assetEngineOff(0) + C.SLOT_BACKING_SHORT + C.BUCKET_FRESH_UNLIENED_BACKING_NUM, buckets[1] * C.BOUND_SCALE);
  return d;
}

describe("decodeTerminalBackingDomains", () => {
  it("returns [registry domain, sibling] floored, consistent with the summed physical", () => {
    const d = market([400n, 300n]);
    expect(decodeTerminalBackingDomains(d, 0)).toEqual([400n, 300n]);
    expect(decodeTerminalBackingDomains(d, 1)).toEqual([300n, 400n]);
    const [a, b] = decodeTerminalBackingDomains(d, 0)!;
    expect(a + b).toBe(decodeTerminalBacking(d, 0)!.physical);
  });
});

describe("splitJuniorRelease", () => {
  it("one leg when the claim fits the registry domain's bucket (or no per-domain figures)", () => {
    expect(splitJuniorRelease(300n, 0, [400n, 300n])).toEqual([{ sourceDomain: 0, amount: 300n }]);
    expect(splitJuniorRelease(900n, 0, null)).toEqual([{ sourceDomain: 0, amount: 900n }]);
  });
  it("two legs when it exceeds the bucket: own bucket first, the rest from the sibling domain", () => {
    expect(splitJuniorRelease(650n, 0, [400n, 300n])).toEqual([{ sourceDomain: 0, amount: 400n }, { sourceDomain: 1, amount: 250n }]);
    expect(splitJuniorRelease(650n, 1, [400n, 300n])).toEqual([{ sourceDomain: 1, amount: 400n }, { sourceDomain: 0, amount: 250n }]);
  });
  it("an empty own bucket sends everything to the sibling", () => {
    expect(splitJuniorRelease(250n, 0, [0n, 300n])).toEqual([{ sourceDomain: 1, amount: 250n }]);
  });
});

describe("buildJuniorResolvedReleaseIxs", () => {
  const vm = { programId: k(), market: k(), registry: k(), vaultLpState: k(), lpPortfolio: k(), ledger: k(), siblingLedger: k() } as never;
  const c = { vm, domain: 0, owner: k(), ownerAta: k(), mint: k(), vaultToken: k(), vaultAuthority: k() };
  const amounts = (ixs: ReturnType<typeof buildJuniorResolvedReleaseIxs>) => ixs.slice(1).map((i) => [...i.data]);
  it("emits one 102 per leg with the leg's source domain on the wire", () => {
    const ixs = buildJuniorResolvedReleaseIxs(c, 650n, false, [400n, 300n]);
    expect(ixs).toHaveLength(3); // ATA create + two 102s
    expect(amounts(ixs)).toEqual([[...encodeVaultLpReleaseSurplus(400n, 0)], [...encodeVaultLpReleaseSurplus(250n, 1)]]);
  });
  it("is the single 102 it always was without per-domain figures", () => {
    const ixs = buildJuniorResolvedReleaseIxs(c, 650n, false);
    expect(amounts(ixs)).toEqual([[...encodeVaultLpReleaseSurplus(650n, 0)]]);
  });
});
