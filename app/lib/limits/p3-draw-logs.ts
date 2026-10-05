/**
 * d119eebd senior-draw program logs (sol_log in src/v16_program.rs@d119eebd):
 *   p3_senior_draw deficit=D moved=M unfunded=U [even=E odd=O]
 *   p3_senior_draw_booked moved=M junior_cover=J senior_loss=L C=C outstanding=O
 *   p3_senior_draw_restored to_seniors=R C=C outstanding=O
 *   p3_residual_relabel domain=D atoms=A
 * Parsed from a confirmed transaction's log messages ("Program log: ..."). Values are atoms.
 */
import type { Connection } from "@solana/web3.js";

export type P3DrawEvent =
  | { kind: "draw"; deficit: bigint; moved: bigint; unfunded: bigint; even: bigint | null; odd: bigint | null }
  | { kind: "booked"; moved: bigint; juniorCover: bigint; seniorLoss: bigint; c: bigint; outstanding: bigint }
  | { kind: "restored"; toSeniors: bigint; c: bigint; outstanding: bigint }
  | { kind: "relabel"; domain: number; atoms: bigint };

const LINE = /^Program log: (p3_senior_draw_booked|p3_senior_draw_restored|p3_senior_draw|p3_residual_relabel)((?: [A-Za-z_]+=\d+)*)\s*$/;

function kv(rest: string): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const m of rest.matchAll(/([A-Za-z_]+)=(\d+)/g)) out[m[1]] = BigInt(m[2]);
  return out;
}

export function parseP3DrawLogs(logs: readonly string[] | null | undefined): P3DrawEvent[] {
  const out: P3DrawEvent[] = [];
  for (const l of logs ?? []) {
    const m = LINE.exec(l);
    if (!m) continue;
    const v = kv(m[2]);
    const need = (...ks: string[]) => ks.every((k) => v[k] !== undefined);
    switch (m[1]) {
      case "p3_senior_draw":
        if (need("deficit", "moved", "unfunded"))
          out.push({ kind: "draw", deficit: v.deficit, moved: v.moved, unfunded: v.unfunded, even: v.even ?? null, odd: v.odd ?? null });
        break;
      case "p3_senior_draw_booked":
        if (need("moved", "junior_cover", "senior_loss", "C", "outstanding"))
          out.push({ kind: "booked", moved: v.moved, juniorCover: v.junior_cover, seniorLoss: v.senior_loss, c: v.C, outstanding: v.outstanding });
        break;
      case "p3_senior_draw_restored":
        if (need("to_seniors", "C", "outstanding"))
          out.push({ kind: "restored", toSeniors: v.to_seniors, c: v.C, outstanding: v.outstanding });
        break;
      case "p3_residual_relabel":
        if (need("domain", "atoms")) out.push({ kind: "relabel", domain: Number(v.domain), atoms: v.atoms });
        break;
    }
  }
  return out;
}

export interface DrawSummary {
  earnAbsorbed: bigint;
  earnRestored: bigint;
}

/** Net effect on Earn of one transaction's draw events: senior loss booked and restored. */
export function summarizeDrawEvents(ev: readonly P3DrawEvent[]): DrawSummary | null {
  let absorbed = 0n;
  let restored = 0n;
  for (const e of ev) {
    if (e.kind === "booked") absorbed += e.seniorLoss;
    if (e.kind === "restored") restored += e.toSeniors;
  }
  return absorbed === 0n && restored === 0n ? null : { earnAbsorbed: absorbed, earnRestored: restored };
}

/** Best effort: the draw summary of a confirmed tx (null when none, or on any RPC failure). */
export async function readTxDrawSummary(
  connection: Pick<Connection, "getTransaction">,
  signature: string,
): Promise<DrawSummary | null> {
  try {
    // v1 (SIMD-0385) readable on web3.js >= 1.99; the node returns legacy / v0 / v1 alike.
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
    return summarizeDrawEvents(parseP3DrawLogs(tx?.meta?.logMessages));
  } catch {
    return null;
  }
}

/** The Earn panel's notice for a transaction that booked or restored a senior draw. */
export function drawNoticeText(s: DrawSummary, fmt: (atoms: bigint) => string): string {
  const parts: string[] = [];
  if (s.earnAbsorbed > 0n)
    parts.push(`Earn absorbed ${fmt(s.earnAbsorbed)}: a loss bigger than the creator's junior tranche, shared by every Earn depositor pro rata.`);
  if (s.earnRestored > 0n) parts.push(`${fmt(s.earnRestored)} was restored to Earn from the vault's recovery.`);
  return parts.join(" ");
}
