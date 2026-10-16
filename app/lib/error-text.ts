/**
 * The text of a thrown value, for error copy and logs (QA E2E-4, 2026-10-16).
 *
 * `e instanceof Error ? e.message : String(e)` turns any non-Error rejection (a JSON-RPC error body, a wallet's
 * `{ code, message }`, a simulation's `{ InstructionError: [...] }`) into "[object Object]", which no error map can
 * read. Errors and strings are unchanged; an InstructionError object is written the way web3.js logs it, so the
 * existing code extraction (custom program error: 0x..) still applies.
 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e === null || e === undefined) return String(e);
  if (typeof e === "object") {
    const o = e as { message?: unknown; code?: unknown; InstructionError?: unknown; err?: unknown };
    if (typeof o.message === "string" && o.message) return o.code !== undefined ? `${o.message} (code ${String(o.code)})` : o.message;
    const ie = (o.InstructionError ?? (o.err as { InstructionError?: unknown } | null | undefined)?.InstructionError) as [number, unknown] | undefined;
    if (Array.isArray(ie) && ie.length === 2) {
      const [ix, detail] = ie;
      const custom = (detail as { Custom?: unknown } | null)?.Custom;
      if (typeof custom === "number") return `Error processing Instruction ${ix}: custom program error: 0x${custom.toString(16)}`;
      return `Error processing Instruction ${ix}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    }
    try {
      const j = JSON.stringify(e);
      if (j && j !== "{}") return j;
    } catch { /* circular */ }
  }
  return String(e);
}
