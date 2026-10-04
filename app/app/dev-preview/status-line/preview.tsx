"use client";

import { StatusLine } from "@/components/ui/StatusLine";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

const W = resolveDevnetProgramIds().wrapper;
const err = (code: number) =>
  Object.assign(new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}\nProgram ${W} failed: custom program error: 0x${code.toString(16)}`), {
    name: "SimulationRefusal",
    code,
    programId: W,
    logs: [`Program ${W} invoke [1]`, `Program ${W} failed: custom program error: 0x${code.toString(16)}`],
  });

const CASES = [
  resolveUserMessage(err(WRAPPER_ERR.ExecPriceOutsideOracleBand), { surface: "trade", side: "long", symbol: "SOL", maxNow: "12.5" }),
  resolveUserMessage(err(WRAPPER_ERR.EngineStale), { surface: "trade" }),
  resolveUserMessage(err(WRAPPER_ERR.EngineLockActive), { surface: "trade", health: { adlReduceOnly: true } }),
  resolveUserMessage(err(WRAPPER_ERR.LpFloorHalt), { surface: "trade", side: "long" }),
  resolveUserMessage(err(WRAPPER_ERR.VaultLpSeniorImpaired), { surface: "earn-deposit" }),
  resolveUserMessage(err(WRAPPER_ERR.VaultLpPausedForSeniorDraw), { surface: "creator-stake" }),
  resolveUserMessage(new Error("custom program error: 0x7e7e7e"), { surface: "any" }),
];

export function StatusLinePreview() {
  return (
    <main className="mx-auto max-w-[340px] space-y-3 bg-[var(--bg)] p-4" data-testid="dev-preview">
      <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">StatusLine variants (UX WP-1)</p>
      {CASES.map((m) => (
        <StatusLine key={m.kind + m.variant} message={m} onAction={() => undefined} />
      ))}
      <p className="pt-4 text-[11px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">Ticket: catching up beyond the app&apos;s repair (UX WP-2)</p>
      <div data-testid="preview-wp2" className="space-y-2 border border-[var(--border)] p-3">
        <StatusLine message={{ kind: "engine-catching-up", variant: "wait", title: "Catching up", body: "Prices are catching up. Trading resumes once the market has caught up." }} />
        <button disabled className="w-full rounded-none bg-[var(--long)] py-3 text-[12px] font-bold uppercase tracking-[0.12em] text-black opacity-50">Waiting for prices…</button>
        <button disabled className="w-full rounded-none bg-[var(--long)] py-3 text-[12px] font-bold uppercase tracking-[0.12em] text-black opacity-50">Waiting for the latest price…</button>
      </div>
    </main>
  );
}
