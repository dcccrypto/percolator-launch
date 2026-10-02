/** Results recorder: every step is {journey, market, step, ok, evidence}. Persisted after each step. */
import fs from "node:fs";
import path from "node:path";
import { RUN, j } from "./perc.ts";

export interface Step { journey: string; market?: string; step: string; ok: boolean; expected?: string; actual?: string; sigs?: string[]; err?: string; at: string }
const FILE = path.join(RUN, "results.json");
function load(): Step[] { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } }
export function record(s: Omit<Step, "at">): Step {
  const all = load();
  const st = { ...s, at: new Date().toISOString() };
  all.push(st);
  fs.writeFileSync(FILE, j(all).replace(/},{/g, "},\n{"));
  fs.appendFileSync(FILE.replace(/\.json$/, ".jsonl"), j(st) + "\n"); // append-only copy: safe with concurrent writers
  console.log(`${st.ok ? "PASS" : "FAIL"} [${s.journey}${s.market ? `/${s.market}` : ""}] ${s.step}${s.actual ? ` — ${s.actual}` : ""}${s.err ? ` — ERR ${s.err.split("\n")[0]}` : ""}`);
  return st;
}
/** Assert helper: records and returns ok. Never throws (a failing assert must not hide later steps). */
export function check(journey: string, market: string | undefined, step: string, ok: boolean, expected: string, actual: string, sigs?: string[]): boolean {
  record({ journey, market, step, ok, expected, actual, sigs });
  return ok;
}
export class Abort extends Error {}
/** Run a journey body; any throw is recorded as a FAIL step and the journey stops (others continue). */
export async function journey(name: string, market: string | undefined, body: () => Promise<void>): Promise<boolean> {
  try { await body(); return true; } catch (e) {
    record({ journey: name, market, step: "journey aborted", ok: false, err: (e as Error).message });
    return false;
  }
}
