import { resolveDevnetProgramIds } from "@/lib/program-ids";

/** The stake program id for error attribution, or null when it cannot be resolved. */
export function stakeProgramIdOrNull(): string | null {
  try {
    return resolveDevnetProgramIds().stake;
  } catch {
    return null;
  }
}
