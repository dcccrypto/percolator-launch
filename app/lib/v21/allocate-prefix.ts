/**
 * Devnet v2.1 (P2b Earn allocation, Q1 of the #526 coordinator decisions): trades on a BOUND market
 * carry a tag 103 `VaultLpAllocate` in front, so the vault LP's capital (and with it growth's
 * `N_cap`) follows Earn's deposits. A recall (tag 98) leaves a market under-allocated only until
 * the next 103.
 *
 * Safety rules, all pinned by tests:
 *  - flag-gated: with `NEXT_PUBLIC_DEVNET_V21` unset nothing is ever built;
 *  - only RISK-INCREASING trades carry it. A close or reduce never does, so a 103 that refuses
 *    (100: a senior draw outstanding, impaired, no room) can never block an exit;
 *  - sim-gated: the 103 is simulated alone first and kept only when it passes. "No room" is a
 *    normal state (the market is already allocated up to alpha), not an error to show;
 *  - and if it still refuses (100) when the whole transaction is checked, the trade is rebuilt
 *    without it once (`isAllocateRefusal`).
 */
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { deriveLpBackingLedger } from "@percolatorct/sdk";
import { decodeLpVaultRegistryBound, decodeLpVaultRegistryDomain, decodeVaultLpState } from "@/lib/limits/decode";
import { deriveLpVaultRegistryPda, deriveVaultLpState } from "@/lib/limits/p3-ix";
import { extractErrorCode } from "@/lib/errorMessages";
import { WRAPPER_ERR_V21 } from "./wrapper-errors";
import { isDevnetV21Enabled } from "./flag";
import { buildVaultLpAllocateIx } from "./sdk";

/** The order grows the taker's exposure (an open, add or flip). A close or reduce is false. */
export function isRiskIncreasing(beforeQ: bigint | null, signedSizeQ: bigint): boolean {
  if (signedSizeQ === 0n) return false;
  if (beforeQ === null) return true; // unknown position: treat as opening (a close is known, by its position)
  if (beforeQ === 0n) return true;
  const after = beforeQ + signedSizeQ;
  if (after === 0n) return false;
  if ((beforeQ > 0n) !== (after > 0n)) return true; // flip
  return (after < 0n ? -after : after) > (beforeQ < 0n ? -beforeQ : beforeQ);
}

export interface AllocatePrefixDeps {
  connection: Pick<Connection, "getAccountInfo" | "getMultipleAccountsInfo">;
  /** Simulate `ixs` as the fee payer; resolves to `null` when it passes (refusal otherwise). */
  simulate: (ixs: TransactionInstruction[]) => Promise<{ err: unknown; rpcFailed: boolean }>;
}

export async function planAllocatePrefix(
  deps: AllocatePrefixDeps,
  p: {
    programId: PublicKey;
    market: PublicKey;
    cranker: PublicKey;
    /** The taker's signed position BEFORE the order (null = unread). */
    beforeQ: bigint | null;
    signedSizeQ: bigint;
  },
): Promise<TransactionInstruction[]> {
  if (!isDevnetV21Enabled()) return [];
  if (!isRiskIncreasing(p.beforeQ, p.signedSizeQ)) return [];
  try {
    const registry = deriveLpVaultRegistryPda(p.programId, p.market);
    const vaultLpState = deriveVaultLpState(p.programId, p.market);
    const [ri, si] = await deps.connection.getMultipleAccountsInfo([registry, vaultLpState], "confirmed");
    if (!ri || !si || !ri.owner.equals(p.programId) || !si.owner.equals(p.programId)) return [];
    const rd = new Uint8Array(ri.data);
    if (decodeLpVaultRegistryBound(rd) !== true) return [];
    const domain = decodeLpVaultRegistryDomain(rd);
    if (domain === null) return [];
    // The bound LP portfolio is recorded in the vault-LP state.
    const st = decodeVaultLpState(new Uint8Array(si.data));
    if (!st) return [];
    const ix = buildVaultLpAllocateIx({
      programId: p.programId,
      cranker: p.cranker,
      market: p.market,
      registry,
      vaultLpState,
      lpPortfolio: new PublicKey(st.lpPortfolio),
      ledger: deriveLpBackingLedger(p.programId, p.market, domain)[0],
      siblingLedger: deriveLpBackingLedger(p.programId, p.market, domain ^ 1)[0],
    });
    const sim = await deps.simulate([ix]);
    if (sim.rpcFailed || sim.err) return []; // no verdict, or "no room / drawing / impaired": not needed now
    return [ix];
  } catch {
    return [];
  }
}

/** The wrapper refused the allocation (Custom 100). Only tag 103 raises it. */
export function isAllocateRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err ?? "");
  return extractErrorCode(msg) === WRAPPER_ERR_V21.VaultLpAllocateRefused;
}
