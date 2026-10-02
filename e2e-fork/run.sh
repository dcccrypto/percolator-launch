#!/usr/bin/env bash
# One-command local E2E: ONE surfpool (--offline, hermetic) → candidate .so install
# (cheatcodes, byte-verified) → read-only mainnet DEX snapshot loaded into it → throwaway
# sandbox keys → P0a seed → keeper (feat/keeper-fee-loop) → app (feat/p0b-self-heal)
# → chain + Playwright journeys.
# LOCAL ONLY: every RPC written to is 127.0.0.1/localhost. Mainnet/devnet are read
# once, read-only (DEX pool snapshot; live matcher dump), both cached + sha-checked.
# Process hygiene: only PIDs recorded in $RUN/pids/* are ever killed (never pkill -f).
#
#   ./run.sh                    # full run (fresh validator), stops services at the end
#   ./run.sh --keep             # leave services running
#   STAGE=setup ./run.sh        # bring the stack up and leave it running
#   STAGE=journeys ./run.sh     # journeys against the running stack
#   STAGE=stop ./run.sh         # stop everything this harness started
#
# Components (env): WRAPPER_SO STAKE_SO NFT_SO [MATCHER_SO] SEED_KIT KEEPER_DIR APP_DIR
# Ports (env): RPC_PORT (ws = +1), APP_PORT, KEEPER_HEALTH_PORT — defaults in the 385xx range.
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
RUN="${RUN_DIR:-$H/.run}"
: "${WRAPPER_SO:=$HOME/deploycand-v183/out/wrapper-v18.3-freshid.so}"
: "${STAKE_SO:=$HOME/deploycand-v183/out/stake-v18.3.so}"
: "${NFT_SO:=$HOME/deploycand-v183/out/nft-v18.3.so}"
: "${MATCHER_SO:=}"
: "${SEED_KIT:=$HOME/wt/ops-p0a-kit/relaunch}"
: "${KEEPER_DIR:=$HOME/wt/e2e-keeper-0930}"
: "${APP_DIR:=$HOME/wt/e2e-app-0930}"
: "${RPC_PORT:=38599}"; : "${APP_PORT:=38590}"; : "${KEEPER_HEALTH_PORT:=38591}"
RPC="http://127.0.0.1:$RPC_PORT"
STAGE="${STAGE:-all}"
KEEP=0; [[ "${1:-}" == "--keep" ]] && KEEP=1
export WRAPPER_SO STAKE_SO NFT_SO MATCHER_SO RPC RUN_DIR="$RUN" KEEPER_DIR APP_PORT
export MRPC="$RPC" E2E_APP_URL="http://localhost:$APP_PORT"
mkdir -p "$RUN/shots" "$RUN/pids" "$RUN/cache"
log(){ printf '\n[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
wait_rpc(){ for _ in $(seq 1 60); do curl -sf "$1" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' >/dev/null && return 0; sleep 1; done; echo "rpc $1 not up" >&2; return 1; }
port_free(){ ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
kill_tree(){ local p=$1 c; for c in $(pgrep -P "$p" 2>/dev/null || true); do kill_tree "$c"; done; kill "$p" 2>/dev/null || true; }
stop_pidfile(){ local f="$RUN/pids/$1" p; [[ -f "$f" ]] || return 0; p="$(cat "$f")"; kill_tree "$p"
  for _ in $(seq 1 15); do kill -0 "$p" 2>/dev/null || break; sleep 1; done
  kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; rm -f "$f"; }
# surfpool forks a server child that can outlive the recorded launcher PID: also stop any listener
# on OUR ports whose cwd is OUR run dir (never anything else)
stop_own_listeners(){ local port p; for port in "$RPC_PORT" "$APP_PORT"; do for p in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
  [[ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" == "$RUN"* || "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" == "$APP_DIR"* ]] || continue
  kill "$p" 2>/dev/null; sleep 2; kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done; done; }
stop_all(){ bash "$H/lib/keeper-ctl.sh" stop >/dev/null || true; stop_pidfile app; stop_pidfile surfpool; stop_own_listeners; }

# single-instance lock (two concurrent runs share state and race the seed)
LOCK="$RUN/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then echo "another run.sh (pid $(cat "$LOCK/pid")) holds $LOCK" >&2; exit 3; fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT

if [[ "$STAGE" == stop ]]; then stop_all; log "stopped"; exit 0; fi

if [[ "$STAGE" == all || "$STAGE" == setup ]]; then
  df -h "$HOME" | tail -1
  log "stop previous harness services (recorded PIDs only)"; stop_all; sleep 2
  for p in "$RPC_PORT" $((RPC_PORT+1)) "$APP_PORT" "$KEEPER_HEALTH_PORT"; do port_free "$p" || { echo "port $p is in use by someone else — pick another range" >&2; exit 4; }; done
  rm -rf "$RUN/surfpool-logs" "$RUN/seed-state.json" "$RUN/results.json"

  log "surfpool --offline :$RPC_PORT (the only validator; hermetic)"
  ( cd "$RUN" && nohup surfpool start --offline --no-tui --no-deploy --no-studio --port "$RPC_PORT" --ws-port $((RPC_PORT+1)) --log-path ./surfpool-logs > surfpool.log 2>&1 & echo $! > "$RUN/pids/surfpool" )
  wait_rpc "$RPC"

  log "sandbox: throwaway keys + local Sim-USDC mint"
  [[ -f "$RUN/authority.json" ]] || solana-keygen new --no-bip39-passphrase -s -o "$RUN/authority.json" >/dev/null
  (cd "$H" && npx tsx lib/sandbox.ts "$RUN" "$RPC" "$RPC")

  log "install + byte-verify candidate programs"
  # upgrade authority = the sandbox admin (live: FbTbDeGW is both; P1 tag 93 is upgrade-authority-gated)
  (cd "$H" && npx tsx lib/install-programs.ts "$RPC" "$(solana-keygen pubkey "$RUN/home/.config/solana/percolator-v17-devnet.json")" "$RUN/programs.json")

  log "mainnet DEX pool snapshot → local validator (price source for seed + keeper)"
  (cd "$H" && npx tsx lib/mainnet-snapshot.ts "$RPC" "$RUN/cache/mainnet-dex.json")
  # wizard journey token (WIF) pools — read-only snapshot, cached
  (cd "$H" && EXTRA_POOLS=ADEjbFryutjfrJTpZfFPRMFhF7XBisPY63Awe79EVhe9,4mMDQ5kG9fFrBSQeedErsUoTBhY5KKnsKWGvenXRTwSy npx tsx lib/mainnet-snapshot.ts "$RPC" "$RUN/cache/mainnet-dex-wif.json")

  log "P0a seed (copy of $SEED_KIT, sha recorded) under the sandbox HOME"
  mkdir -p "$RUN/seed-kit/lib"
  cp "$SEED_KIT"/*.ts "$RUN/seed-kit/"; cp "$SEED_KIT"/lib/*.ts "$RUN/seed-kit/lib/"   # whole kit (seed + drills)
  shasum -a 256 "$RUN/seed-kit/newmarkets-v18.3.ts" | tee "$RUN/seed-kit.sha256"
  (cd "$RUN/seed-kit" && HOME="$RUN/home" SEED_TARGET=fork SEED_RPC_URL="$RPC" SEED_WS_URL="ws://127.0.0.1:$((RPC_PORT+1))" \
     SEED_STATE="$RUN/seed-state.json" TSX_DISABLE_CACHE=1 "$H/node_modules/.bin/tsx" newmarkets-v18.3.ts ${SEED_ONLY:+--only=$SEED_ONLY} > "$RUN/seed.log" 2>&1) \
     || { tail -40 "$RUN/seed.log"; echo "SEED FAILED"; exit 1; }
  grep -E 'ALL-GREEN' "$RUN/seed.log"

  log "keeper ($KEEPER_DIR @ $(git -C "$KEEPER_DIR" rev-parse --short HEAD))"
  (cd "$H" && npx tsx lib/keeper-registry.ts "$RUN/seed-state.json" "$RUN/keeper-registry.json")
  cat > "$RUN/keeper.env" <<ENV
HOME=$RUN/home
DEVNET_RPC_URL=$RPC
ALLOW_INSECURE_LOCAL_RPC=true
MAINNET_RPC_URL=$RPC
KEEPER_KEYPAIR_PATH=$RUN/home/.config/solana/percolator-v17-devnet.json
REGISTRY_PATH=$RUN/keeper-registry.json
CC_HEALTH_PORT=$KEEPER_HEALTH_PORT
CC_HEALTH_BIND=127.0.0.1
WRAPPER_PROGRAM_ID=${WRAPPER_PROGRAM_ID:-ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB}
STAKE_PROGRAM_ID=GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3
LP_FEE_CRANK_INTERVAL_MS=15000
CRANK_INTERVAL_MS=10000
TSX_DISABLE_CACHE=1
ENV
  : > "$RUN/keeper.log"; bash "$H/lib/keeper-ctl.sh" start

  log "app ($APP_DIR @ $(git -C "$APP_DIR" rev-parse --short HEAD)) — env contract p0b §1 + slab-meta overlay"
  bash "$H/lib/app-env.sh" "$APP_DIR/app" "$RUN" "$RPC_PORT"
  (cd "$H" && npx tsx lib/app-overlay.ts "$RUN/seed-state.json" "$APP_DIR/app")
  ( cd "$APP_DIR/app" && nohup node_modules/.bin/next dev -p "$APP_PORT" > "$RUN/app.log" 2>&1 & echo $! > "$RUN/pids/app" )
  for _ in $(seq 1 150); do [[ "$(curl -s -m 5 -o /dev/null -w "%{http_code}" "http://localhost:$APP_PORT/api/health")" != 000 ]] && break; sleep 2; done
  curl -s -m 300 "http://localhost:$APP_PORT/api/markets" -o "$RUN/markets.json" -w 'markets api %{http_code} %header{x-percolator-data-source}\n'
fi

[[ "$STAGE" == setup ]] && { log "setup done (services left running)"; exit 0; }
log "journeys: chain-level, non-destructive (on-chain asserts)"
(cd "$H" && ONLY=C1,C2,C3,C4,C5,F1,F2,F6,F5 npx tsx journeys/run-chain.ts) || CHAIN_FAIL=1
log "journeys: UI (Playwright + test wallet, on-chain asserts)"
(cd "$H" && npx playwright test -c playwright.config.ts) || UI_FAIL=1
log "journeys: chain-level, DESTRUCTIVE last (F-3 freeze / owner exits / permissionless resolve — resolves markets)"
(cd "$H" && ONLY=${DESTRUCTIVE:-F7} npx tsx journeys/run-chain.ts) || CHAIN_FAIL=1
log "done: chain=${CHAIN_FAIL:-0} ui=${UI_FAIL:-0}  results → $RUN/results.json"
[[ $KEEP == 1 || "$STAGE" == journeys ]] || stop_all
[[ -z "${CHAIN_FAIL:-}${UI_FAIL:-}" ]]
