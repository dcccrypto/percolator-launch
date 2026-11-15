#!/bin/zsh
# usage: bench-markets.sh <port>   — 20 sequential GETs, prints p50/p95 (ms) and response size
PORT=${1:-3111}
URL="http://localhost:$PORT/api/markets"
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{time_total} %{size_download} %{http_code}\n" "$URL"
done | sort -n | awk '{t[NR]=$1*1000; s=$2; c=$3} END {printf "n=%d p50=%.0fms p95=%.0fms min=%.0fms max=%.0fms size=%dB http=%s\n", NR, t[int(NR*0.5+0.5)], t[int(NR*0.95+0.5)], t[1], t[NR], s, c}'
