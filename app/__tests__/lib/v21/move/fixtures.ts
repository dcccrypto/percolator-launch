import { Keypair } from "@solana/web3.js";
import type { MoveInput, V1MarketSnapshot } from "@/lib/v21/move/plan";
import { successorFor, type SuccessorEntry } from "@/lib/v21/move/successors";

export const pk = (): string => Keypair.generate().publicKey.toBase58();

export const SOL_SLAB = pk();
export const V21_SOL_SLAB = pk();

export const SUCCESSORS: SuccessorEntry[] = [
  { symbol: "SOL", mint: null, v21Slab: V21_SOL_SLAB, v21Earn: true },
  { symbol: "PENGU", mint: null, v21Slab: null, v21Earn: false },
];

export function market(over: Partial<V1MarketSnapshot> = {}): V1MarketSnapshot {
  return {
    slab: SOL_SLAB,
    symbol: "SOL",
    mint: null,
    collateralDecimals: 6,
    resolved: false,
    portfolio: { capital: 5_000_000n, releasedPnl: 0n, openLegs: 0, closeOnly: false },
    earn: null,
    creatorFeeAtoms: 0n,
    v21: { marketCapital: 0n, earnShares: 0n },
    ...over,
  };
}

export function input(markets: V1MarketSnapshot[], over: Partial<MoveInput> = {}): MoveInput {
  return {
    nowSlot: 1_000n,
    markets,
    successors: SUCCESSORS,
    v21Live: true,
    successorOf: (m) => successorFor(SUCCESSORS, m.mint, m.symbol),
    ...over,
  };
}
