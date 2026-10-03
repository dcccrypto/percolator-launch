/**
 * UX WP-9 (audit §3.11, MM-1): N INDEPENDENT transactions under ONE wallet approval.
 *
 * Each unit is simulated first (a refused unit is reported and never signed: the wallet never
 * sees it; a unit whose simulation could not RUN is held back the same way, #2743), the rest
 * are built on one blockhash and signed with ONE signAll, then broadcast one by one. Units stay independent: one failing does not undo another (for money, partial success
 * beats all-or-nothing; e.g. tag 90 creator-fee claims are CAS-bound per market). Pure over
 * injected deps; the hooks bind them to the connection and the wallet.
 */
import type { Transaction, TransactionInstruction } from "@solana/web3.js";

export interface ApprovalUnit<K> {
  key: K;
  instructions: TransactionInstruction[];
}

export interface OneApprovalDeps<Tx> {
  /**
   * Pre-sign verdict for one unit: `err` null when it would land, else the refusal (never prompts).
   * `unchecked: true` means the simulation itself could not run (RPC failure) — there is NO
   * verdict, so the unit is not signed (#2743: "could not check" is never "would land").
   */
  simulate: (ixs: TransactionInstruction[]) => Promise<{ err: unknown; consumed: number | null; unchecked?: boolean }>;
  /** Build one unsigned tx per unit on ONE blockhash; `index` makes each tx distinct. */
  build: (ixs: TransactionInstruction[], consumed: number | null, index: number) => Promise<Tx> | Tx;
  /** ONE wallet approval for the whole list. */
  signAll: (txs: Tx[]) => Promise<Tx[]>;
  broadcast: (tx: Tx) => Promise<string>;
}

export type UnitOutcome<K> =
  | { key: K; ok: true; signature: string }
  | { key: K; ok: false; stage: "refused" | "unchecked" | "failed"; error: unknown };

export async function runOneApproval<K, Tx = Transaction>(units: readonly ApprovalUnit<K>[], d: OneApprovalDeps<Tx>): Promise<UnitOutcome<K>[]> {
  const out = new Map<number, UnitOutcome<K>>();
  const go: { i: number; unit: ApprovalUnit<K>; consumed: number | null }[] = [];
  for (const [i, unit] of units.entries()) {
    const v = await d.simulate(unit.instructions);
    if (v.err) out.set(i, { key: unit.key, ok: false, stage: "refused", error: v.err });
    else if (v.unchecked) out.set(i, { key: unit.key, ok: false, stage: "unchecked", error: null });
    else go.push({ i, unit, consumed: v.consumed });
  }
  if (go.length > 0) {
    const txs: Tx[] = [];
    for (const [n, g] of go.entries()) txs.push(await d.build(g.unit.instructions, g.consumed, n));
    const signed = await d.signAll(txs);
    for (const [n, g] of go.entries()) {
      const tx = signed[n];
      try {
        if (tx === undefined) throw new Error("the wallet returned fewer signed transactions");
        out.set(g.i, { key: g.unit.key, ok: true, signature: await d.broadcast(tx) });
      } catch (error) {
        out.set(g.i, { key: g.unit.key, ok: false, stage: "failed", error });
      }
    }
  }
  return units.map((_, i) => out.get(i)!);
}
