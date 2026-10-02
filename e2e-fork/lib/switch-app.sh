#!/usr/bin/env bash
# Swap the app under test on the running stack: stop the recorded app PID, write the p0b §1
# env (+ extra NEXT_PUBLIC_* flags passed as args), apply the slab-meta overlay, start next dev.
#   lib/switch-app.sh ~/wt/e2e-app-limits NEXT_PUBLIC_LIMITS_P1=0
set -euo pipefail
H="$(cd "$(dirname "$0")/.." && pwd)"; RUN="${RUN_DIR:-$H/.run}"; APP_DIR="$1"; shift
APP_PORT="${APP_PORT:-38590}"; RPC_PORT="${RPC_PORT:-38599}"
kill_tree(){ local p=$1 c; for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done; kill "$p" 2>/dev/null || true; }
if [[ -f "$RUN/pids/app" ]]; then p=$(cat "$RUN/pids/app"); kill_tree "$p"; for _ in $(seq 1 15); do kill -0 "$p" 2>/dev/null || break; sleep 1; done; kill -9 "$p" 2>/dev/null || true; rm -f "$RUN/pids/app"; fi
sleep 3; rm -rf "$APP_DIR/app/.next" 2>/dev/null || { sleep 5; rm -rf "$APP_DIR/app/.next"; }   # a branch switch can leave a Turbopack cache that panics
bash "$H/lib/app-env.sh" "$APP_DIR/app" "$RUN" "$RPC_PORT"
for kv in "$@"; do echo "$kv" >> "$APP_DIR/app/.env.local"; done
(cd "$H" && npx tsx lib/app-overlay.ts "$RUN/seed-state.json" "$APP_DIR/app")
( cd "$APP_DIR/app" && nohup node_modules/.bin/next dev -p "$APP_PORT" > "$RUN/app.log" 2>&1 < /dev/null & echo $! > "$RUN/pids/app" ) > /dev/null 2>&1
for _ in $(seq 1 150); do [[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/api/health")" != 000 ]] && break; sleep 2; done
curl -s -m 300 "http://localhost:$APP_PORT/api/markets" -o /dev/null -w "app $(git -C "$APP_DIR" rev-parse --short HEAD) markets %{http_code} %header{x-percolator-data-source}\n"
