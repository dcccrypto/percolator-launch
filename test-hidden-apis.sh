#!/bin/bash

# Hidden Features API Test Suite
# Tests all new endpoints for warmup, insurance, and OI features

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Config
API_BASE="${API_BASE:-http://localhost:4000}"
TEST_SLAB="${TEST_SLAB:-ErVCYKHbVLV2zN6Ss5gvPPQx5SbhYKb5AzKdYqiJx4qe}"  # Default test slab
TIMEOUT=5

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
test_start() {
    echo -e "\n${YELLOW}[TEST]${NC} $1"
    TESTS_RUN=$((TESTS_RUN + 1))
}

test_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

test_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

# Check if server is running
echo "Checking API server at $API_BASE..."
if ! curl -sf "$API_BASE/health" > /dev/null 2>&1; then
    echo -e "${RED}ERROR:${NC} API server not responding at $API_BASE"
    echo "Please start the server: cd packages/server && pnpm dev"
    exit 1
fi
echo -e "${GREEN}✓${NC} Server is running"

echo ""
echo "========================================="
echo "  Hidden Features API Test Suite"
echo "========================================="
echo "API Base: $API_BASE"
echo "Test Slab: $TEST_SLAB"
echo ""

# ============================================
# 1. PNL Warmup API Tests
# ============================================

echo -e "\n${YELLOW}=== PNL Warmup API Tests ===${NC}"

test_start "GET /api/warmup/:slab/:idx - Valid request"
RESPONSE=$(curl -sf --max-time $TIMEOUT "$API_BASE/api/warmup/$TEST_SLAB/0" 2>/dev/null || echo "ERROR")
if [[ "$RESPONSE" == "ERROR" ]]; then
    test_fail "Endpoint not responding or not implemented"
elif echo "$RESPONSE" | jq -e '.warmupActive' > /dev/null 2>&1; then
    test_pass "Endpoint returns valid JSON with warmupActive field"
    
    # Verify all required fields
    if echo "$RESPONSE" | jq -e '.warmupActive, .slotsRemaining, .percentComplete, .lockedAmount' > /dev/null 2>&1; then
        test_pass "All required warmup fields present"
    else
        test_fail "Missing required fields in response: $(echo $RESPONSE | jq -c 'keys')"
    fi
else
    test_fail "Invalid response format: $RESPONSE"
fi

test_start "GET /api/warmup/:slab/:idx - Invalid slab address"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time $TIMEOUT "$API_BASE/api/warmup/INVALID_SLAB/0" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "404" || "$HTTP_CODE" == "400" ]]; then
    test_pass "Returns 404/400 for invalid slab"
else
    test_fail "Expected 404/400, got $HTTP_CODE"
fi

test_start "GET /api/warmup/:slab/:idx - Out of range account index"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time $TIMEOUT "$API_BASE/api/warmup/$TEST_SLAB/9999" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "404" || "$HTTP_CODE" == "400" ]]; then
    test_pass "Returns 404/400 for out of range index"
else
    test_fail "Expected 404/400, got $HTTP_CODE"
fi

# ============================================
# 2. Insurance Fund API Tests
# ============================================

echo -e "\n${YELLOW}=== Insurance Fund API Tests ===${NC}"

test_start "GET /api/insurance/:slab - Valid request"
RESPONSE=$(curl -sf --max-time $TIMEOUT "$API_BASE/api/insurance/$TEST_SLAB" 2>/dev/null || echo "ERROR")
if [[ "$RESPONSE" == "ERROR" ]]; then
    test_fail "Endpoint not responding or not implemented"
elif echo "$RESPONSE" | jq -e '.balance' > /dev/null 2>&1; then
    test_pass "Endpoint returns valid JSON with balance field"
    
    # Verify all required fields
    if echo "$RESPONSE" | jq -e '.balance, .feeRevenue, .healthRatio, .accumulationRate' > /dev/null 2>&1; then
        test_pass "All required insurance fields present"
    else
        test_fail "Missing required fields in response: $(echo $RESPONSE | jq -c 'keys')"
    fi
    
    # Verify balance is a valid number string
    BALANCE=$(echo "$RESPONSE" | jq -r '.balance')
    if [[ "$BALANCE" =~ ^[0-9]+$ ]]; then
        test_pass "Balance is valid numeric string: $BALANCE"
    else
        test_fail "Balance is not a valid number: $BALANCE"
    fi
else
    test_fail "Invalid response format: $RESPONSE"
fi

test_start "GET /api/insurance/:slab/history - Historical data"
RESPONSE=$(curl -sf --max-time $TIMEOUT "$API_BASE/api/insurance/$TEST_SLAB/history" 2>/dev/null || echo "ERROR")
if [[ "$RESPONSE" == "ERROR" ]]; then
    test_fail "History endpoint not responding or not implemented"
elif echo "$RESPONSE" | jq -e '.history | type == "array"' > /dev/null 2>&1; then
    test_pass "History endpoint returns array"
    
    # Check array length
    HISTORY_LEN=$(echo "$RESPONSE" | jq '.history | length')
    echo "  └─ History entries: $HISTORY_LEN"
else
    test_fail "Invalid response format: $RESPONSE"
fi

test_start "GET /api/insurance/:slab - Invalid slab address"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time $TIMEOUT "$API_BASE/api/insurance/INVALID_SLAB" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "404" || "$HTTP_CODE" == "400" ]]; then
    test_pass "Returns 404/400 for invalid slab"
else
    test_fail "Expected 404/400, got $HTTP_CODE"
fi

# ============================================
# 3. Open Interest API Tests
# ============================================

echo -e "\n${YELLOW}=== Open Interest API Tests ===${NC}"

test_start "GET /api/oi/:slab - Valid request"
RESPONSE=$(curl -sf --max-time $TIMEOUT "$API_BASE/api/oi/$TEST_SLAB" 2>/dev/null || echo "ERROR")
if [[ "$RESPONSE" == "ERROR" ]]; then
    test_fail "Endpoint not responding or not implemented"
elif echo "$RESPONSE" | jq -e '.totalOI' > /dev/null 2>&1; then
    test_pass "Endpoint returns valid JSON with totalOI field"
    
    # Verify all required fields
    if echo "$RESPONSE" | jq -e '.totalOI, .longOI, .shortOI, .netLpPosition, .imbalancePercent' > /dev/null 2>&1; then
        test_pass "All required OI fields present"
        
        # Verify math: longOI + shortOI should equal totalOI (approximately, accounting for rounding)
        TOTAL=$(echo "$RESPONSE" | jq -r '.totalOI')
        LONG=$(echo "$RESPONSE" | jq -r '.longOI')
        SHORT=$(echo "$RESPONSE" | jq -r '.shortOI')
        SUM=$((LONG + SHORT))
        
        if [[ "$SUM" == "$TOTAL" ]]; then
            test_pass "OI math checks out: long($LONG) + short($SHORT) = total($TOTAL)"
        else
            test_fail "OI math error: long($LONG) + short($SHORT) = $SUM ≠ total($TOTAL)"
        fi
    else
        test_fail "Missing required fields in response: $(echo $RESPONSE | jq -c 'keys')"
    fi
else
    test_fail "Invalid response format: $RESPONSE"
fi

test_start "GET /api/oi/global - Global OI aggregate"
RESPONSE=$(curl -sf --max-time $TIMEOUT "$API_BASE/api/oi/global" 2>/dev/null || echo "ERROR")
if [[ "$RESPONSE" == "ERROR" ]]; then
    test_fail "Global OI endpoint not responding or not implemented"
elif echo "$RESPONSE" | jq -e '.totalOI, .marketCount' > /dev/null 2>&1; then
    test_pass "Global OI endpoint returns valid data"
    
    MARKET_COUNT=$(echo "$RESPONSE" | jq -r '.marketCount')
    TOTAL_OI=$(echo "$RESPONSE" | jq -r '.totalOI')
    echo "  └─ Markets: $MARKET_COUNT, Total OI: $TOTAL_OI"
else
    test_fail "Invalid response format: $RESPONSE"
fi

test_start "GET /api/oi/:slab - Invalid slab address"
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time $TIMEOUT "$API_BASE/api/oi/INVALID_SLAB" 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "404" || "$HTTP_CODE" == "400" ]]; then
    test_pass "Returns 404/400 for invalid slab"
else
    test_fail "Expected 404/400, got $HTTP_CODE"
fi

# ============================================
# 4. Performance Tests
# ============================================

echo -e "\n${YELLOW}=== Performance Tests ===${NC}"

test_start "Warmup API response time < 100ms"
START=$(date +%s%N)
curl -sf --max-time $TIMEOUT "$API_BASE/api/warmup/$TEST_SLAB/0" > /dev/null 2>&1
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
if [[ $ELAPSED_MS -lt 100 ]]; then
    test_pass "Response time: ${ELAPSED_MS}ms"
else
    test_fail "Response time too slow: ${ELAPSED_MS}ms (target: <100ms)"
fi

test_start "Insurance API response time < 50ms"
START=$(date +%s%N)
curl -sf --max-time $TIMEOUT "$API_BASE/api/insurance/$TEST_SLAB" > /dev/null 2>&1
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
if [[ $ELAPSED_MS -lt 50 ]]; then
    test_pass "Response time: ${ELAPSED_MS}ms"
else
    test_fail "Response time too slow: ${ELAPSED_MS}ms (target: <50ms)"
fi

test_start "OI API response time < 50ms"
START=$(date +%s%N)
curl -sf --max-time $TIMEOUT "$API_BASE/api/oi/$TEST_SLAB" > /dev/null 2>&1
END=$(date +%s%N)
ELAPSED_MS=$(( (END - START) / 1000000 ))
if [[ $ELAPSED_MS -lt 50 ]]; then
    test_pass "Response time: ${ELAPSED_MS}ms"
else
    test_fail "Response time too slow: ${ELAPSED_MS}ms (target: <50ms)"
fi

# ============================================
# Summary
# ============================================

echo ""
echo "========================================="
echo "  Test Results Summary"
echo "========================================="
echo "Total Tests:  $TESTS_RUN"
echo -e "${GREEN}Passed:${NC}       $TESTS_PASSED"
echo -e "${RED}Failed:${NC}       $TESTS_FAILED"
echo "========================================="

if [[ $TESTS_FAILED -eq 0 ]]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi
