# Hidden Features Testing - Quick Start Guide

**For:** Developers running the test suite  
**Created:** 2026-02-14 by QA Testing Subagent  
**Status:** Ready to execute

---

## 🚀 Quick Start

### Prerequisites
```bash
# 1. Backend server running
cd packages/server && pnpm dev

# 2. Frontend app running (for E2E tests)
cd app && pnpm dev

# 3. Database accessible
echo $DATABASE_URL  # Should be set

# 4. Dependencies installed
pnpm install
```

---

## ✅ Unit Tests (Ready Now)

**Run all hidden features unit tests:**
```bash
cd packages/server
pnpm test tests/unit/warmup.test.ts tests/unit/insurance.test.ts tests/unit/oi.test.ts
```

**Expected output:**
```
✓ tests/unit/insurance.test.ts (27 tests)
✓ tests/unit/oi.test.ts (27 tests)
✓ tests/unit/warmup.test.ts (15 tests)

Test Files  3 passed (3)
Tests      69 passed (69)
```

**Run specific test suite:**
```bash
pnpm test tests/unit/warmup.test.ts       # Warmup calculations only
pnpm test tests/unit/insurance.test.ts    # Insurance health only
pnpm test tests/unit/oi.test.ts           # Open Interest only
```

---

## 🌐 API Endpoint Tests (When APIs Implemented)

**Run API test script:**
```bash
# From project root
./test-hidden-apis.sh

# With custom test slab
TEST_SLAB=<your_slab_address> ./test-hidden-apis.sh

# With custom API base
API_BASE=http://localhost:3000 ./test-hidden-apis.sh
```

**What it tests:**
- ✅ All 5 new API endpoints
- ✅ Valid requests return correct data
- ✅ Invalid requests return 404/400
- ✅ Response format validation
- ✅ Field validation
- ✅ Performance (response times)

**Expected output:**
```
========================================
  Hidden Features API Test Suite
========================================

[TEST] GET /api/warmup/:slab/:idx - Valid request
[PASS] Endpoint returns valid JSON with warmupActive field
[PASS] All required warmup fields present

...

Total Tests:  20
Passed:       20
Failed:       0
✓ All tests passed!
```

---

## 🗄️ Database Tests (When Migration 007 Applied)

**Run database validation:**
```bash
psql $DATABASE_URL < test-hidden-db.sql
```

**What it tests:**
- ✅ Migration 007 applied correctly
- ✅ New columns exist in `market_stats`
- ✅ New tables created (`insurance_history`, `oi_history`)
- ✅ Indexes created for performance
- ✅ Data integrity (no NULLs, math consistency)
- ✅ Foreign key constraints
- ✅ Query performance

---

## ⚡ Performance Tests (When APIs Implemented)

**Run performance benchmarks:**
```bash
# Default: 10 iterations, 5 concurrent
./test-hidden-perf.sh

# Custom: 20 iterations, 10 concurrent
ITERATIONS=20 CONCURRENCY=10 ./test-hidden-perf.sh
```

**Performance Targets:**
- Warmup API: < 100ms
- Insurance API: < 50ms
- OI API: < 50ms
- History API: < 200ms

---

## 🧪 Integration Tests (To Be Written)

**Location:** `packages/server/tests/integration/hidden-features.test.ts`

**Run when created:**
```bash
cd packages/server
pnpm test tests/integration/hidden-features.test.ts
```

---

## 🎨 UI Component Tests (To Be Written)

**Location:** 
- `app/__tests__/WarmupProgress.test.tsx`
- `app/__tests__/InsuranceDashboard.test.tsx`
- `app/__tests__/OpenInterestCard.test.tsx`

**Run when created:**
```bash
cd app
pnpm test
```

---

## 🌊 E2E Tests (To Be Written)

**Location:** `app/__tests__/e2e/hidden-features.spec.ts`

**Run when created:**
```bash
cd app
pnpm test:e2e
```

---

## 🐛 Bug Tracking

**Found a bug?**
1. Document it in `BUGS-FOUND.md`
2. Use the bug template provided
3. Assign priority (Critical/High/Medium/Low)
4. Notify the team

**Check bug status:**
```bash
cat BUGS-FOUND.md
```

---

## 📊 Test Reports

**View test plan:**
```bash
cat TESTING-PLAN.md
```

**View test report:**
```bash
cat TESTING-REPORT.md
```

**View test summary:**
```bash
cat TESTING-SUMMARY.md
```

---

## 🔧 Troubleshooting

### "Cannot find module" errors
```bash
# Reinstall dependencies
pnpm install
```

### "Server not responding" in API tests
```bash
# Check server is running
curl http://localhost:4000/health

# Start server if not running
cd packages/server && pnpm dev
```

### "Database connection failed" in DB tests
```bash
# Check DATABASE_URL is set
echo $DATABASE_URL

# Test connection
psql $DATABASE_URL -c "SELECT 1"
```

### Tests timing out
```bash
# Increase timeout (default: 5s)
# Edit test script and change TIMEOUT=10
```

---

## 📝 Writing New Tests

### Unit Test Template
```typescript
import { describe, test, expect } from 'vitest';

describe('Feature Name', () => {
  describe('Scenario Category', () => {
    test('specific behavior', () => {
      const result = functionUnderTest(input);
      expect(result).toBe(expectedValue);
    });
  });
});
```

### API Test Template (bash)
```bash
test_start "GET /api/endpoint - description"
RESPONSE=$(curl -sf "$API_BASE/api/endpoint" || echo "ERROR")
if [[ "$RESPONSE" != "ERROR" ]]; then
    test_pass "Description of success"
else
    test_fail "Description of failure"
fi
```

---

## 🎯 Test Coverage Goals

| Category | Target | Current |
|----------|--------|---------|
| Unit Tests | 90%+ | 100% (69/69) |
| Integration Tests | 80%+ | 0% (pending) |
| E2E Tests | Critical paths | 0% (pending) |
| API Coverage | 100% endpoints | 0% (APIs missing) |

---

## 🚦 CI/CD Integration

**GitHub Actions (when set up):**
```yaml
# .github/workflows/test-hidden-features.yml
- name: Run Hidden Features Tests
  run: |
    cd packages/server
    pnpm test tests/unit/warmup.test.ts tests/unit/insurance.test.ts tests/unit/oi.test.ts
    
- name: Run API Tests
  run: ./test-hidden-apis.sh
  
- name: Run DB Tests
  run: psql $DATABASE_URL < test-hidden-db.sql
```

---

## 📞 Support

**Questions?** Check:
1. `TESTING-PLAN.md` - Master plan
2. `TESTING-REPORT.md` - Detailed results
3. `BUGS-FOUND.md` - Known issues
4. Test file comments - Inline documentation

**Issues?** Report in:
- `BUGS-FOUND.md` for bugs
- Git issues for infrastructure problems

---

## 📚 Test File Reference

| File | Purpose | Status |
|------|---------|--------|
| `test-hidden-apis.sh` | API endpoint testing | ✅ Ready |
| `test-hidden-db.sql` | Database validation | ✅ Ready |
| `test-hidden-perf.sh` | Performance benchmarks | ✅ Ready |
| `tests/unit/warmup.test.ts` | Warmup calculations | ✅ 15 tests passing |
| `tests/unit/insurance.test.ts` | Insurance health | ✅ 27 tests passing |
| `tests/unit/oi.test.ts` | Open Interest | ✅ 27 tests passing |
| `tests/integration/hidden-features.test.ts` | API flows | ⏸️ Pending |
| `app/__tests__/WarmupProgress.test.tsx` | Warmup UI | ⏸️ Pending |
| `app/__tests__/InsuranceDashboard.test.tsx` | Insurance UI | ⏸️ Pending |
| `app/__tests__/OpenInterestCard.test.tsx` | OI UI | ⏸️ Pending |
| `app/__tests__/e2e/hidden-features.spec.ts` | User flows | ⏸️ Pending |

---

**Happy Testing! 🧪**

*Created by QA Testing Subagent - 2026-02-14*
