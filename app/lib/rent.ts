/**
 * Rent-exempt minimum per account: (data bytes + 128) × lamports per byte. The rate was
 * 6960; getMinimumBalanceForRentExemption on devnet AND mainnet now returns 5080/byte
 * (0 B → 650,240; 33,900 B → 172,862,240), so 6960 over-quoted every launch by ~37%.
 * ponytail: hard-coded rate — if rent changes again, read it once from
 * getMinimumBalanceForRentExemption(0) / 128 instead.
 */
export const RENT_PER_BYTE = 5080;
const RENT_OVERHEAD_BYTES = 128;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** Rent-exempt minimum, in SOL, for accounts of the given data sizes. */
export function rentSol(...sizes: number[]): number {
  return sizes.reduce((sum, bytes) => sum + (bytes + RENT_OVERHEAD_BYTES) * RENT_PER_BYTE, 0) / LAMPORTS_PER_SOL;
}
