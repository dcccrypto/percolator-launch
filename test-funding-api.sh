#!/bin/bash
# Funding Rates API Test Script
# Tests all funding endpoints against localhost or production

set -e

# Default to localhost, or use first argument as base URL
BASE_URL="${1:-http://localhost:4000}"

echo "🧪 Testing Funding Rates API"
echo "📍 Base URL: $BASE_URL"
echo ""

# Test 1: Get all markets to find a valid slab address
echo "1️⃣ Fetching markets..."
MARKETS_RESPONSE=$(curl -s "$BASE_URL/markets/stats")
FIRST_SLAB=$(echo "$MARKETS_RESPONSE" | jq -r '.stats[0].slab_address // empty')

if [ -z "$FIRST_SLAB" ]; then
  echo "❌ No markets found in market_stats table"
  echo "Hint: Make sure StatsCollector has run at least once"
  exit 1
fi

echo "✅ Found market: $FIRST_SLAB"
echo ""

# Test 2: Get current funding rate for first market
echo "2️⃣ Testing GET /funding/:slab"
FUNDING_RESPONSE=$(curl -s "$BASE_URL/funding/$FIRST_SLAB")
echo "$FUNDING_RESPONSE" | jq '.'

# Extract current rate
CURRENT_RATE=$(echo "$FUNDING_RESPONSE" | jq -r '.currentRateBpsPerSlot // "null"')
if [ "$CURRENT_RATE" != "null" ]; then
  echo "✅ Current funding rate: $CURRENT_RATE bps/slot"
else
  echo "⚠️  Funding rate not yet available (market may not have been cranked)"
fi
echo ""

# Test 3: Get funding history
echo "3️⃣ Testing GET /funding/:slab/history"
HISTORY_RESPONSE=$(curl -s "$BASE_URL/funding/$FIRST_SLAB/history?limit=10")
echo "$HISTORY_RESPONSE" | jq '.'

HISTORY_COUNT=$(echo "$HISTORY_RESPONSE" | jq -r '.count // 0')
echo "✅ Found $HISTORY_COUNT historical data points"
echo ""

# Test 4: Get global funding rates
echo "4️⃣ Testing GET /funding/global"
GLOBAL_RESPONSE=$(curl -s "$BASE_URL/funding/global")
echo "$GLOBAL_RESPONSE" | jq '.'

MARKET_COUNT=$(echo "$GLOBAL_RESPONSE" | jq -r '.count // 0')
echo "✅ Found $MARKET_COUNT markets with funding data"
echo ""

# Test 5: Test with time range
echo "5️⃣ Testing GET /funding/:slab/history?since=..."
SINCE_TIME=$(date -u -d '1 hour ago' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ")
SINCE_RESPONSE=$(curl -s "$BASE_URL/funding/$FIRST_SLAB/history?since=$SINCE_TIME")
SINCE_COUNT=$(echo "$SINCE_RESPONSE" | jq -r '.count // 0')
echo "✅ Found $SINCE_COUNT data points since $SINCE_TIME"
echo ""

# Summary
echo "📊 Test Summary"
echo "==============="
echo "Market tested: $FIRST_SLAB"
echo "Current rate: $CURRENT_RATE bps/slot"
echo "Historical records: $HISTORY_COUNT"
echo "Total markets: $MARKET_COUNT"
echo ""

if [ "$CURRENT_RATE" != "null" ] && [ "$HISTORY_COUNT" -gt 0 ]; then
  echo "✅ All tests passed!"
  echo ""
  echo "🎯 Next steps:"
  echo "   1. Run migration: supabase/migrations/006_funding_rates.sql"
  echo "   2. Restart server to activate StatsCollector updates"
  echo "   3. Wait for first crank cycle (~30s)"
  echo "   4. Check funding_history table for accumulating data"
else
  echo "⚠️  Tests incomplete - funding data not yet available"
  echo ""
  echo "💡 Troubleshooting:"
  echo "   - Has the server been restarted after migration?"
  echo "   - Has StatsCollector run at least once? (check logs)"
  echo "   - Has a crank executed? (funding_history only updates on crank)"
  echo "   - Check market_stats table: SELECT funding_rate_bps_per_slot FROM market_stats;"
fi
