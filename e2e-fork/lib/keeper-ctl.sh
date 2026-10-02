#!/usr/bin/env bash
# start|stop|status the HARNESS keeper. Only the PID recorded in $RUN/pids/keeper (and its
# child tree) is ever signalled — never a pattern kill (the live launchd keeper and other
# agents' keepers share the machine).
set -euo pipefail
H="$(cd "$(dirname "$0")/.." && pwd)"; RUN="${RUN_DIR:-$H/.run}"; KEEPER_DIR="${KEEPER_DIR:-$HOME/wt/e2e-keeper-0930}"
PF="$RUN/pids/keeper"; mkdir -p "$RUN/pids"
kill_tree(){ local p=$1 c; for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done; kill "$p" 2>/dev/null || true; }
alive(){ [[ -f "$PF" ]] && kill -0 "$(cat "$PF")" 2>/dev/null; }
case "${1:-status}" in
  start)
    alive && { echo "keeper already running ($(cat "$PF"))"; exit 0; }
    ( set -a; source "$RUN/keeper.env"; set +a; cd "$KEEPER_DIR"; nohup node_modules/.bin/tsx src/cross-cluster.ts >> "$RUN/keeper.log" 2>&1 & echo $! > "$PF" )
    echo "keeper started pid $(cat "$PF")";;
  stop)
    if alive; then kill_tree "$(cat "$PF")"; for _ in $(seq 1 20); do alive || break; sleep 0.5; done; fi
    rm -f "$PF"; echo "keeper stopped";;
  status) alive && echo running || echo stopped;;
esac
