/**
 * Dual-wrapper reads (v1 ETDLAdi + the v2.1 fresh ids). LEAF module: imports no config, so
 * lib/config.ts can use it without a cycle.
 *
 * Finding (read-only Supabase SELECT, 2026-10-05): `markets` rows carry NO program or wrapper
 * column, so a row's world is only knowable from the OWNER of its slab account on chain. Every
 * "is this slab ours?" filter compares that owner with the configured wrapper; after the v2.1
 * cutover that filter would drop every v1 row (and the "v1 · close-only" label with it).
 *
 * Gate: `isMoveFlowEnabled()` (needs NEXT_PUBLIC_DEVNET_V21 and NEXT_PUBLIC_V21_MOVE). Off => every
 * function here returns "nothing extra", so callers behave exactly as before.
 */
import { isMoveFlowEnabled } from "./move/flag";
import { V1_PROGRAM_IDS, resolveV21ProgramIds } from "./move/ids";

export type MarketWorld = "v1" | "v21";

/** Every v1 and v2.1 program id (wrapper, matcher, nft, stake) the app should also trust. Empty when the flag is off. */
export function dualWorldProgramIds(): string[] {
  if (!isMoveFlowEnabled()) return [];
  const out = new Set<string>(Object.values(V1_PROGRAM_IDS));
  const v21 = resolveV21ProgramIds();
  if (v21) Object.values(v21).forEach((id) => out.add(id));
  return [...out];
}

/** The wrapper ids of both worlds (v2.1 only once its ids are configured). Empty when the flag is off. */
export function dualWorldWrapperIds(): string[] {
  if (!isMoveFlowEnabled()) return [];
  const out = [V1_PROGRAM_IDS.wrapper as string];
  const v21 = resolveV21ProgramIds();
  if (v21) out.push(v21.wrapper);
  return out;
}

/** Which world a wrapper id belongs to; null for any other program, and always null when the flag is off. */
export function worldOfWrapper(wrapper: string | null | undefined): MarketWorld | null {
  if (!wrapper || !isMoveFlowEnabled()) return null;
  if (wrapper === V1_PROGRAM_IDS.wrapper) return "v1";
  const v21 = resolveV21ProgramIds();
  if (v21 && wrapper === v21.wrapper) return "v21";
  return null;
}
