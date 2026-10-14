#!/usr/bin/env bash
# Copies the BASE versions of the files the harness compares against into scripts/perf/.old/
# (git show, never stash/checkout). Not committed; delete with `rm -rf scripts/perf/.old`.
#   BASE_REF=origin/feat/v22-app bash scripts/perf/prepare-old.sh   (run from app/)
set -euo pipefail
BASE_REF="${BASE_REF:-origin/feat/v22-app}"
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/.old"
rm -rf "$out" && mkdir -p "$out"
git show "$BASE_REF:app/lib/chart/trade-feed.ts" > "$out/trade-feed.ts"
git show "$BASE_REF:app/scripts/local-price-ws-server.ts" > "$out/local-price-ws-server.ts.txt"
git show "$BASE_REF:app/app/api/candles/[slab]/route.ts" > "$out/candles-route.ts"
git show "$BASE_REF:app/lib/market-registry.ts" > "$out/market-registry.ts.txt"
echo "$BASE_REF @ $(git rev-parse "$BASE_REF")" > "$out/BASE"
echo "old copies from $(cat "$out/BASE") -> $out"
