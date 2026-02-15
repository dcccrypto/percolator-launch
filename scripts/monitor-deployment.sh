#!/bin/bash
# Monitor Railway deployment and verify hidden features fix

set -e

RAILWAY_URL="https://percolator-api-production.up.railway.app/health"
SUPABASE_URL="https://ygvbajglkrwkbjdjyhxi.supabase.co/rest/v1/market_stats"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlndmJhamdsa3J3a2JqZGp5aHhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0OTczNTcsImV4cCI6MjA4NjA3MzM1N30.7whzbcLHuGKhPmyN01ZZT6fdVcRubAcYqzFP48RnVlA"

echo "🔍 MONITORING RAILWAY DEPLOYMENT"
echo "================================"
echo ""

# Check current uptime
echo "📊 Current Railway Status:"
UPTIME=$(curl -s "$RAILWAY_URL" | python3 -c "import sys, json; print(json.load(sys.stdin)['uptimeMs'])")
UPTIME_MIN=$((UPTIME / 60000))
echo "   Uptime: ${UPTIME_MIN} minutes (${UPTIME} ms)"

if [ "$UPTIME_MIN" -lt 5 ]; then
    echo "   ✅ RECENT DEPLOYMENT DETECTED!"
else
    echo "   ⏳ Waiting for deployment (uptime > 5min)"
fi

echo ""
echo "🗄️  Database Check:"
curl -s "${SUPABASE_URL}?select=slab_address,total_open_interest,insurance_balance,net_lp_pos&limit=1" \
    -H "apikey: ${ANON_KEY}" \
    -H "Authorization: Bearer ${ANON_KEY}" | python3 -m json.tool

echo ""
echo "================================"
