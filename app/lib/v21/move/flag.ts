/**
 * "Move to v2.1" flag. Requires the v2.1 flag (isDevnetV21Enabled) AND NEXT_PUBLIC_V21_MOVE.
 * Default off: with either unset there is no route content, no label, no ticket restriction.
 * Literal env reads (Next inlines NEXT_PUBLIC_* only when read literally).
 */
import { isDevnetV21Enabled } from "../flag";

const on = (v: string | undefined): boolean => v === "1" || v === "true";

let override: boolean | null = null;

/** Test seam: `null` = read the environment. */
export function __setMoveFlowForTest(v: boolean | null): void {
  override = v;
}

export function isMoveFlowEnabled(): boolean {
  if (override !== null) return override && isDevnetV21Enabled();
  return isDevnetV21Enabled() && on(process.env.NEXT_PUBLIC_V21_MOVE);
}
