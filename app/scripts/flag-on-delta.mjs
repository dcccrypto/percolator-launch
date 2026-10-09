#!/usr/bin/env node
/**
 * By-name delta of the vitest suite with the v2.2 flag ON (`NEXT_PUBLIC_DEVNET_V22=1`) between a BASE checkout and this one.
 *
 * Why: with the flag on, hundreds of v2.1-fixture tests fail by design, so the raw failure count hides a real v2.2 regression. What matters is
 * which tests fail here and NOT in the base run with the same flag. Pick the base that isolates the change you care about (e.g. a worktree of
 * `origin/playground` plus the merge commit, or the previous head of this branch).
 *
 *   node scripts/flag-on-delta.mjs <path-to-base-worktree>/app [--json-base base.json] [--json-head head.json]
 *
 * Exit code 0 = no test fails here that passes in the base; 1 = new failures (listed); 2 = usage / run error.
 * `--json-base` / `--json-head` reuse a vitest `--reporter=json` file instead of running that side.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const base = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--json-base" && args[args.indexOf(a) - 1] !== "--json-head");
const jsonBase = flag("--json-base"), jsonHead = flag("--json-head");
if (!base && !jsonBase) { console.error("usage: flag-on-delta.mjs <base-app-dir> [--json-base f] [--json-head f]"); process.exit(2); }

function run(dir) {
  const out = join(mkdtempSync(join(tmpdir(), "flagdelta-")), "r.json");
  const r = spawnSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${out}`], { cwd: dir, env: { ...process.env, NEXT_PUBLIC_DEVNET_V22: "1" }, stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(out)) { console.error(`vitest produced no report in ${dir} (exit ${r.status})`); process.exit(2); }
  return out;
}
function load(file) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  const st = new Map();
  for (const f of d.testResults) {
    const name = f.name.includes("/app/") ? f.name.split("/app/").pop() : f.name;
    if (f.status === "failed" && f.assertionResults.length === 0) st.set(`${name} [file failed to load]`, "failed");
    for (const t of f.assertionResults) st.set(`${name} > ${t.fullName}`, t.status);
  }
  return st;
}
const head = load(jsonHead ?? run(resolve(process.cwd())));
const baseRes = load(jsonBase ?? run(resolve(base)));
const fails = (m) => new Set([...m].filter(([, s]) => s === "failed").map(([k]) => k));
const hf = fails(head), bf = fails(baseRes);
const added = [...hf].filter((k) => !bf.has(k)).sort();
const fixed = [...bf].filter((k) => !hf.has(k)).sort();
console.log(`flag ON  base: ${bf.size} failing   head: ${hf.size} failing`);
console.log(`new failures (fail here, not in base): ${added.length}`);
for (const k of added) console.log(`  + ${k}`);
console.log(`no longer failing: ${fixed.length}`);
process.exit(added.length ? 1 : 0);
