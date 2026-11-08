/**
 * SYNTHETIC fixtures for the PERC allocation DB/import tests. Every owner is
 * a seeded hash, base58-encoded: valid 32-byte keys that are no one's wallet.
 */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import type { ValidatedSnapshot, HolderRow } from "@/scripts/allocation/import-lib";

export function syntheticOwner(i: number | string): string {
  return bs58.encode(createHash("sha256").update(`SYNTHETIC-perc-alloc-owner-${i}`).digest());
}

export function syntheticKey(i: number | string): Buffer {
  return createHash("sha256").update(`SYNTHETIC-client-${i}`).digest();
}

/**
 * 3 eligible (1:2:3 balances, $600.00 floor -> 100/200/300) + 2 excluded.
 * With `exception`, e3 is counted under an approved balance exception.
 */
export function syntheticSnapshot(tag = "a", opts: { exception?: boolean } = {}): ValidatedSnapshot {
  const x = !!opts.exception;
  const holders: HolderRow[] = [
    { owner: syntheticOwner(`${tag}-e1`), eligible: true, balanceRaw: 1_000_001n, allocationCents: 10_000n, reasons: [], basis: "snapshot" },
    { owner: syntheticOwner(`${tag}-e2`), eligible: true, balanceRaw: 2_000_002n, allocationCents: 20_000n, reasons: [], basis: "snapshot" },
    { owner: syntheticOwner(`${tag}-e3`), eligible: true, balanceRaw: 3_000_003n, allocationCents: 30_000n, reasons: [], basis: x ? "exception" : "snapshot" },
    { owner: syntheticOwner(`${tag}-x1`), eligible: false, balanceRaw: 5n, allocationCents: 0n, reasons: ["off-curve", "LP"], basis: "snapshot" },
    { owner: syntheticOwner(`${tag}-x2`), eligible: false, balanceRaw: 7_500_000n, allocationCents: 0n, reasons: ["off-curve"], basis: "snapshot" },
  ];
  return {
    meta: {
      label: "SYNTHETIC 1 Jan 2000",
      snapshotDate: "2000-01-01",
      snapshotSlot: 1n,
      tokenDecimals: 6,
      fullRaiseCents: 300_000n,
      floorPercent: "20",
      floorCents: 60_000n,
      // Per-tag hashes: different synthetic snapshots never look like the same inputs.
      eligibleCsvSha256: createHash("sha256").update(`SYNTHETIC-eligible-${tag}`).digest("hex"),
      allHoldersCsvSha256: createHash("sha256").update(`SYNTHETIC-all-${tag}`).digest("hex"),
      manifestSha256: createHash("sha256").update(`SYNTHETIC-manifest-${tag}`).digest("hex"),
      teamExclusionBasis: "SYNTHETIC owner statement",
      teamExclusionVerified: false,
      exceptionOwners: x ? 1 : 0,
      exceptionBasis: x ? "SYNTHETIC approved balance exception" : null,
      exceptionFilesSha256: x ? ["d".repeat(64)] : [],
      baseManifestSha256: x ? "e".repeat(64) : null,
    },
    holders,
    eligibleCount: 3,
    excludedCount: 2,
    eligibleRawTotal: 6_000_006n,
  };
}
