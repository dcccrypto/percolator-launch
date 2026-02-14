#!/bin/bash

# Hidden Features Performance Testing Script
# Benchmarks API response times and database query performance

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Config
API_BASE="${API_BASE:-http://localhost:4000}"
TEST_SLAB="${TEST_SLAB:-ErVCYKHbVLV2zN6Ss5gvPPQx5SbhYKb5AzKdYqiJx4qe}"
ITERATIONS=${ITERATIONS:-10}
CONCURRENCY=${CONCURRENCY:-5}

# Performance thresholds (ms)
THRESHOLD_WARMUP=100
THRESHOLD_INSURANCE=50
THRESHOLD_OI=50
THRESHOLD_HISTORY=200

echo "========================================="
echo "  Hidden Features Performance Tests"
echo "========================================="
echo "API Base: $API_BASE"
echo "Test Slab: $TEST_SLAB"
echo "Iterations: $ITERATIONS"
echo "Concurrency: $CONCURRENCY"
echo ""

# Helper function to measure endpoint performance
benchmark_endpoint() {
    local name="$1"
    local url="$2"
    local threshold="$3"
    
    echo -e "\n${YELLOW}[BENCHMARK]${NC} $name"
    
    local total_time=0
    local min_time=999999
    local max_time=0
    local failed=0
    
    for i in $(seq 1 $ITERATIONS); do
        start=$(date +%s%N)
        if curl -sf --max-time 5 "$url" > /dev/null 2>&1; then
            end=$(date +%s%N)
            elapsed=$(( (end - start) / 1000000 ))
            
            total_time=$((total_time + elapsed))
            
            if [[ $elapsed -lt $min_time ]]; then
                min_time=$elapsed
            fi
            
            if [[ $elapsed -gt $max_time ]]; then
                max_time=$elapsed
            fi
            
            printf "."
        else
            printf "F"
            failed=$((failed + 1))
        fi
    done
    
    echo ""
    
    local avg_time=$((total_time / ITERATIONS))
    
    echo "  Min: ${min_time}ms"
    echo "  Max: ${max_time}ms"
    echo "  Avg: ${avg_time}ms"
    echo "  Failed: $failed/$ITERATIONS"
    
    if [[ $avg_time -lt $threshold ]]; then
        echo -e "  ${GREEN}✓ PASS${NC} (threshold: ${threshold}ms)"
    else
        echo -e "  ${RED}✗ FAIL${NC} (threshold: ${threshold}ms, got: ${avg_time}ms)"
    fi
}

# Test concurrent requests
benchmark_concurrent() {
    local name="$1"
    local url="$2"
    
    echo -e "\n${YELLOW}[CONCURRENT]${NC} $name (${CONCURRENCY} parallel requests)"
    
    start=$(date +%s%N)
    
    for i in $(seq 1 $CONCURRENCY); do
        curl -sf --max-time 5 "$url" > /dev/null 2>&1 &
    done
    
    wait
    
    end=$(date +%s%N)
    elapsed=$(( (end - start) / 1000000 ))
    
    echo "  Total time for $CONCURRENCY requests: ${elapsed}ms"
    echo "  Avg per request: $((elapsed / CONCURRENCY))ms"
}

# ============================================
# 1. Warmup API Performance
# ============================================

echo -e "\n${BLUE}=== Warmup API Performance ===${NC}"
benchmark_endpoint "GET /api/warmup/:slab/:idx" "$API_BASE/api/warmup/$TEST_SLAB/0" $THRESHOLD_WARMUP
benchmark_concurrent "Warmup API Concurrency" "$API_BASE/api/warmup/$TEST_SLAB/0"

# ============================================
# 2. Insurance API Performance
# ============================================

echo -e "\n${BLUE}=== Insurance API Performance ===${NC}"
benchmark_endpoint "GET /api/insurance/:slab" "$API_BASE/api/insurance/$TEST_SLAB" $THRESHOLD_INSURANCE
benchmark_concurrent "Insurance API Concurrency" "$API_BASE/api/insurance/$TEST_SLAB"

# ============================================
# 3. Insurance History Performance
# ============================================

echo -e "\n${BLUE}=== Insurance History Performance ===${NC}"
benchmark_endpoint "GET /api/insurance/:slab/history" "$API_BASE/api/insurance/$TEST_SLAB/history" $THRESHOLD_HISTORY
benchmark_endpoint "GET /api/insurance/:slab/history?limit=100" "$API_BASE/api/insurance/$TEST_SLAB/history?limit=100" $THRESHOLD_HISTORY

# ============================================
# 4. Open Interest API Performance
# ============================================

echo -e "\n${BLUE}=== Open Interest API Performance ===${NC}"
benchmark_endpoint "GET /api/oi/:slab" "$API_BASE/api/oi/$TEST_SLAB" $THRESHOLD_OI
benchmark_endpoint "GET /api/oi/global" "$API_BASE/api/oi/global" $THRESHOLD_OI
benchmark_concurrent "OI API Concurrency" "$API_BASE/api/oi/$TEST_SLAB"

# ============================================
# 5. Load Test
# ============================================

echo -e "\n${BLUE}=== Load Test (Mixed Endpoints) ===${NC}"

start=$(date +%s%N)

# Fire off requests in parallel
for i in $(seq 1 5); do
    curl -sf "$API_BASE/api/warmup/$TEST_SLAB/0" > /dev/null 2>&1 &
    curl -sf "$API_BASE/api/insurance/$TEST_SLAB" > /dev/null 2>&1 &
    curl -sf "$API_BASE/api/oi/$TEST_SLAB" > /dev/null 2>&1 &
done

wait

end=$(date +%s%N)
elapsed=$(( (end - start) / 1000000 ))

echo "  15 mixed requests completed in ${elapsed}ms"
echo "  Avg: $((elapsed / 15))ms per request"

# ============================================
# 6. Memory/Resource Usage
# ============================================

echo -e "\n${BLUE}=== Resource Usage ===${NC}"

# Check if we can access process stats
if command -v ps > /dev/null 2>&1; then
    # Find Node.js processes (likely our server)
    echo "Node.js processes:"
    ps aux | grep -E "node|tsx" | grep -v grep | awk '{printf "  PID: %s | CPU: %s%% | MEM: %s%% | CMD: %s\n", $2, $3, $4, $11}'
fi

# ============================================
# 7. Database Query Performance
# ============================================

echo -e "\n${BLUE}=== Database Query Performance ===${NC}"

if [[ -n "$DATABASE_URL" ]]; then
    echo "Testing direct database queries..."
    
    # Test insurance_history query
    echo -e "\nInsurance history query (last 100 records):"
    psql "$DATABASE_URL" -c "EXPLAIN ANALYZE SELECT * FROM insurance_history WHERE slab_address = '$TEST_SLAB' ORDER BY timestamp DESC LIMIT 100;" 2>&1 | grep "Execution Time" || echo "  (Query plan unavailable)"
    
    # Test oi_history query
    echo -e "\nOI history query (last 100 records):"
    psql "$DATABASE_URL" -c "EXPLAIN ANALYZE SELECT * FROM oi_history WHERE slab_address = '$TEST_SLAB' ORDER BY timestamp DESC LIMIT 100;" 2>&1 | grep "Execution Time" || echo "  (Query plan unavailable)"
    
    # Test market_stats update
    echo -e "\nMarket stats query:"
    psql "$DATABASE_URL" -c "EXPLAIN ANALYZE SELECT warmup_period_slots, total_open_interest, insurance_balance FROM market_stats WHERE slab_address = '$TEST_SLAB';" 2>&1 | grep "Execution Time" || echo "  (Query plan unavailable)"
else
    echo "  DATABASE_URL not set - skipping database queries"
fi

# ============================================
# Summary
# ============================================

echo ""
echo "========================================="
echo "  Performance Test Complete"
echo "========================================="
echo ""
echo "Thresholds:"
echo "  Warmup API: < ${THRESHOLD_WARMUP}ms"
echo "  Insurance API: < ${THRESHOLD_INSURANCE}ms"
echo "  OI API: < ${THRESHOLD_OI}ms"
echo "  History API: < ${THRESHOLD_HISTORY}ms"
echo ""
echo "Run with custom settings:"
echo "  ITERATIONS=20 CONCURRENCY=10 ./test-hidden-perf.sh"
echo ""
