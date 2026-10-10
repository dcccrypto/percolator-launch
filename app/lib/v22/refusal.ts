import { resolveDevnetProgramIds } from "@/lib/program-ids";

/**
 * An error shaped like the runtime's own refusal, for a quote that already says the program would refuse
 * (107, 108, 114, 115, 123, 124 ...). It goes through `resolveUserMessage` like any on-chain failure, so the
 * user sees the same calm line whether the refusal came from our quote or from the simulation.
 */
export function wrapperRefusal(code: number): Error {
  const id = resolveDevnetProgramIds().wrapper;
  return new Error(`Program ${id} failed: custom program error: 0x${code.toString(16)}`);
}
