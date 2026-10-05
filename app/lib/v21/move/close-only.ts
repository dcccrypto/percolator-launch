/**
 * v1 close-only policy for the trade ticket. v1 keeps pricing and cranking so exits are safe, but
 * takes no new risk. A trade that only REDUCES an existing position (never flips it) is a close and
 * stays allowed; so do withdrawals and everything outside the open-order button.
 */
import { isMoveFlowEnabled } from "./flag";
import { isV1CloseOnly } from "./ids";
import { UserFacingError } from "@/lib/errorMessages";

export type TradeDirection = "long" | "short";

/**
 * `existing` is the signed position (positive long, negative short); `size` the positive size of
 * the order in the same base units. True when the order leaves the account with more exposure.
 */
export function isRiskIncreasing(existing: bigint, direction: TradeDirection, size: bigint): boolean {
  if (size <= 0n) return false;
  if (existing === 0n) return true;
  const sameSide = (existing > 0n) === (direction === "long");
  if (sameSide) return true;
  const abs = existing < 0n ? -existing : existing;
  return size > abs; // flipping through zero opens the other side
}

/** The ticket must refuse this order on a v1 close-only market. */
export function v1BlocksOrder(p: { v1CloseOnly: boolean; existing: bigint; direction: TradeDirection; size: bigint }): boolean {
  return p.v1CloseOnly && isRiskIncreasing(p.existing, p.direction, p.size);
}

/** New money or new risk a v1 close-only market must not take. Withdraw, close, claim and Earn exit are not listed: they stay open. */
export type V1BlockedAction = "deposit" | "add-margin" | "earn-deposit" | "first-trade";

/** What the app refuses and what it still allows, in one place. App-side only. */
export const V1_CLOSE_ONLY_REFUSAL =
  "This is a v1 market and it is close-only. This app no longer takes deposits, margin or new trades here. You can still close positions, withdraw, collect Earn withdrawals and claim fees. Move your funds to v2.1 from the Move page.";

/** The ONE decision: should the app refuse new money on this market? Pure in its inputs. */
export function v1BlocksNewFunds(programId: string | null | undefined, enabled: boolean): boolean {
  return isV1CloseOnly(programId, enabled);
}

/** Hook-level guard (no UI bypass inside the app). Reads the flag itself. Throws a calm, specific error. */
export function assertV1AllowsNewFunds(programId: string | { toBase58(): string } | null | undefined, _action: V1BlockedAction): void {
  const id = programId == null ? null : typeof programId === "string" ? programId : programId.toBase58();
  if (v1BlocksNewFunds(id, isMoveFlowEnabled())) throw new UserFacingError(V1_CLOSE_ONLY_REFUSAL);
}
