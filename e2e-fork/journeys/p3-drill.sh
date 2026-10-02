#!/usr/bin/env bash
# Run the P0a kit's p3-drill.ts (copied into .run/seed-kit by run.sh) against the harness validator.
# ONLY change: warp() → real elapsed slots (surfpool --offline cannot time-travel). The drill's
# market is removed from the keeper registry for the run (its oracle must go dead for D3); the
# other markets keep their keeper. Usage: DRILL_MARKET=Percolator bash journeys/p3-drill.sh
set -euo pipefail
H="$(cd "$(dirname "$0")/.." && pwd)"; RUN="${RUN_DIR:-$H/.run}"; M="${DRILL_MARKET:-Percolator}"
K="$RUN/seed-kit"; cp "$K/p3-drill.ts" "$K/p3-drill.harness-$M.ts"
python3 - "$K/p3-drill.harness-$M.ts" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
i = s.index("async function warp(slots: bigint) {"); j = s.index("\n}\n", i) + 3
s = s[:i] + '''async function warp(slots: bigint) {
  // HARNESS: real elapsed slots (surfpool --offline cannot time-travel)
  const target = BigInt(await conn.getSlot("confirmed")) + slots;
  while (BigInt(await conn.getSlot("confirmed")) < target) await new Promise((r) => setTimeout(r, 5000));
}
''' + s[j:]
open(p, "w").write(s)
PY
SLAB=$(python3 -c "import json;print(json.load(open('$RUN/seed-state.json'))['markets']['$M']['slab'])")
python3 - "$RUN/keeper-registry.json" "$SLAB" "$RUN/drill-entry-$M.json" <<'PY'
import json, sys
p, slab, out = sys.argv[1:4]; r = json.load(open(p)); e = [m for m in r["markets"] if m["marketAddress"] == slab]; json.dump(e, open(out, "w"))
PY
python3 - "$RUN/keeper-registry.json" "$SLAB" <<'PY'
import json, sys
p, slab = sys.argv[1], sys.argv[2]; r = json.load(open(p)); r["markets"] = [m for m in r["markets"] if m["marketAddress"] != slab]; json.dump(r, open(p, "w"), indent=2)
PY
sleep 20  # registry reload
( cd "$K" && HOME="$RUN/home" SEED_RPC_URL="${RPC:-http://127.0.0.1:38599}" SEED_WS_URL="ws://127.0.0.1:38600" SEED_STATE="$RUN/seed-state.json" DRILL_MARKET="$M" DRILL_OUT="$RUN/p3-drill-$M.json" DRILL_CLOSE_LP_FIRST="${DRILL_CLOSE_LP_FIRST:-}" \
  TSX_DISABLE_CACHE=1 "$H/node_modules/.bin/tsx" p3-drill.harness-$M.ts ) 2>&1 | tee "$RUN/p3-drill-$M.log"
python3 - "$RUN/keeper-registry.json" "$RUN/drill-entry-$M.json" <<'PY'
import json, sys
p, ent = sys.argv[1:3]; r = json.load(open(p)); r["markets"] += json.load(open(ent)); json.dump(r, open(p, "w"), indent=2)
PY
