/**
 * M9: an order bigger than the side's fillable room (the ticket's `marketMaxQ`: the tightest of every cap the market enforces, including `ticketLimits.growthCapQ`) is clipped by the program, so the
 * ticket must never price, deposit for or submit the ask. null cap = no known limit.
 */
export function sideOverFillable(sizeQ: bigint, capQ: bigint | null): boolean {
  return capQ !== null && sizeQ > capQ;
}
