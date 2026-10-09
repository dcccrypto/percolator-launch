#!/usr/bin/env bash
# full-suite-vs-base.sh -- run the WHOLE app test suite on this tree and on a base ref, and
# report the tests that fail on the tree but NOT on the base. Exit 1 if there are any.
#
# Why: CI only treats the app suite as non-blocking (.github/workflows/test.yml `app-tests`,
# continue-on-error), and the playground suite carries known failures, so a green-looking PR can hide
# a regression. This answers the only question that matters before merging: "did THIS change break
# anything the base did not already break?" Run it before merging (human or agent).
#
# Usage:   scripts/full-suite-vs-base.sh [BASE_REF]      (default: origin/playground)
# Env:     OUT_DIR=<dir>          where the JSON reports + lists go (default: a fresh mktemp dir)
#          SKIP_TREE_INSTALL=1    skip `pnpm install` for the current tree (its node_modules are fresh)
#          KEEP_BASE_WORKTREE=1   do not delete the temporary base worktree on exit
#
# How: the base is checked out in a TEMPORARY git worktree and gets its OWN dependencies
# (`pnpm install --frozen-lockfile --prefer-offline`; never symlinked or shared, since stale
# node_modules cause false failures). The current tree is run as-is (uncommitted changes included),
# after the same install. A failure is identified as "<file> :: <full test name>"; a test that fails on
# both is "pre-existing" and listed but does not fail the script. A tree test file that fails to load
# counts as a failure of the file. Needs: git, pnpm, node. Takes several minutes per run.
set -euo pipefail

BASE_REF="${1:-origin/playground}"
ROOT="$(git rev-parse --show-toplevel)"
OUT_DIR="${OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/full-suite-vs-base.XXXXXX")}"
mkdir -p "$OUT_DIR"
BASE_WT="$(mktemp -d "${TMPDIR:-/tmp}/suite-base-wt.XXXXXX")"
rmdir "$BASE_WT"

cleanup() {
  if [ "${KEEP_BASE_WORKTREE:-0}" != "1" ] && [ -d "$BASE_WT" ]; then
    git -C "$ROOT" worktree remove --force "$BASE_WT" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

run_suite() { # $1 = repo root, $2 = json out
  # vitest exits non-zero when tests fail; that is expected, we read the JSON.
  (cd "$1/app" && npx vitest run --reporter=json --outputFile="$2" >"$2.log" 2>&1) || true
  [ -s "$2" ] || { echo "ERROR: no JSON report at $2 (see $2.log)" >&2; exit 2; }
}

failing_list() { # $1 = json, prints sorted unique "file :: test"
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const out = new Set();
    for (const f of d.testResults) {
      const file = f.name.replace(/^.*\/app\//, "");
      const tests = f.assertionResults.filter((t) => t.status === "failed");
      for (const t of tests) out.add(`${file} :: ${t.fullName || t.title}`);
      if (f.status === "failed" && tests.length === 0) out.add(`${file} :: <file failed to load/run>`);
    }
    process.stdout.write([...out].sort().join("\n") + (out.size ? "\n" : ""));
  ' "$1"
}

totals() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(`${d.numTotalTests} tests, ${d.numFailedTests} failed, ${d.numFailedTestSuites} suites failed`)' "$1"; }

echo "== base: $BASE_REF (temporary worktree, own deps)"
git -C "$ROOT" worktree add --detach "$BASE_WT" "$BASE_REF" >/dev/null
(cd "$BASE_WT" && pnpm install --frozen-lockfile --prefer-offline >"$OUT_DIR/base-install.log" 2>&1)
run_suite "$BASE_WT" "$OUT_DIR/base.json"

echo "== tree: $ROOT"
if [ "${SKIP_TREE_INSTALL:-0}" != "1" ]; then
  (cd "$ROOT" && pnpm install --frozen-lockfile --prefer-offline >"$OUT_DIR/tree-install.log" 2>&1)
fi
run_suite "$ROOT" "$OUT_DIR/tree.json"

failing_list "$OUT_DIR/base.json" >"$OUT_DIR/base-fails.txt"
failing_list "$OUT_DIR/tree.json" >"$OUT_DIR/tree-fails.txt"
comm -13 "$OUT_DIR/base-fails.txt" "$OUT_DIR/tree-fails.txt" >"$OUT_DIR/new-fails.txt"
comm -12 "$OUT_DIR/base-fails.txt" "$OUT_DIR/tree-fails.txt" >"$OUT_DIR/both-fails.txt"
comm -23 "$OUT_DIR/base-fails.txt" "$OUT_DIR/tree-fails.txt" >"$OUT_DIR/fixed.txt"

echo
echo "base: $(totals "$OUT_DIR/base.json")"
echo "tree: $(totals "$OUT_DIR/tree.json")"
echo "fixed on tree (fail on base only): $(wc -l <"$OUT_DIR/fixed.txt" | tr -d ' ')"
echo "pre-existing (fail on both):       $(wc -l <"$OUT_DIR/both-fails.txt" | tr -d ' ')"
echo "reports in $OUT_DIR"

if [ -s "$OUT_DIR/new-fails.txt" ]; then
  echo
  echo "NEW FAILURES (fail on the tree, pass on $BASE_REF):"
  sed 's/^/  - /' "$OUT_DIR/new-fails.txt"
  exit 1
fi
echo "No new failures versus $BASE_REF."
