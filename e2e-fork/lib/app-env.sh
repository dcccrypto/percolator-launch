#!/usr/bin/env bash
# Write <appDir>/.env.local per the p0b-frontend §1 env contract (LOCAL fork only).
set -euo pipefail
APP="$1"; RUN="$2"; P="${3:-28899}"
cat > "$APP/.env.local" <<ENV
# e2e-fork harness — LOCAL FORK ONLY (generated; throwaway keys)
NEXT_PUBLIC_DEFAULT_NETWORK=devnet
NEXT_PUBLIC_ALLOW_PROGRAM_ID_OVERRIDE=1
DEVNET_RPC_URL=http://127.0.0.1:$P
RPC_UPSTREAM_ORIGIN=http://localhost
NEXT_PUBLIC_SOLANA_WS_URL=ws://localhost:$((P+1))
NEXT_PUBLIC_WRAPPER_PROGRAM_ID=${WRAPPER_PROGRAM_ID:-ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB}
NEXT_PUBLIC_MATCHER_PROGRAM_ID=4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT
NEXT_PUBLIC_NFT_PROGRAM_ID=CNGBPZRALk9Xu8BdgWNyrLJ7daQ9eJYFf1GnEEC7YCU3
NEXT_PUBLIC_STAKE_PROGRAM_ID=GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3
NEXT_PUBLIC_TEST_USDC_MINT=DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC
NEXT_PUBLIC_API_URL=http://localhost:3299
DEVNET_MINT_AUTHORITY_KEYPAIR=$(cat "$RUN/home/.config/solana/percolator-devnet-mint-authority.json")
PLAYGROUND_KEEPER_KEYPAIR=$(cat "$RUN/home/.config/solana/percolator-v17-devnet.json")
ENV
for kv in ${APP_EXTRA_ENV:-}; do echo "$kv" >> "$APP/.env.local"; done
echo "app env → $APP/.env.local"
