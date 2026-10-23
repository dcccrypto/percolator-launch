/**
 * #3601: what the launch error panel may do for a v2.2 launch with a capacity bond. A bond launch exists only as ONE
 * transaction, so a retry at step 0 is a FRESH launch (a new slab keypair), never the step-by-step path.
 *
 * - `hidden`: the one transaction was sent but never confirmed and may have landed in full. A fresh launch could
 *   create a second market, so no Continue is offered (Start over and "check your markets" stay).
 * - `fresh`: nothing is on chain (declined, refused, simulation), so Continue starts the same launch afresh.
 * - `default`: not a bond launch at step 0; the normal retry path applies.
 */
export type BondRetryAction = "hidden" | "fresh" | "default";

export function bondRetryAction(a: { bond: boolean; step: number; resumeFromStep: number | null; outcomeUnknown: boolean }): BondRetryAction {
  if (!a.bond) return "default";
  if (a.outcomeUnknown) return "hidden";
  return a.step === 0 && a.resumeFromStep === null ? "fresh" : "default";
}

/**
 * One fresh launch per error: every fresh launch makes a new slab keypair, so a double click would start two. The
 * guard is re-armed when `launch` stopped before starting anything (it returns false), so the buttons never go dead
 * with no message; the caller re-arms it again whenever the error changes.
 */
export function freshLaunchOnce(guard: { current: boolean }, launch: () => boolean): void {
  if (guard.current) return;
  guard.current = true;
  if (!launch()) guard.current = false;
}
