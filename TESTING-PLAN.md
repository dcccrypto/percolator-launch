# Hidden Features Testing Plan

**QA Engineer:** Subagent Testing Team  
**Date:** 2026-02-14  
**Target Deployment:** 2026-02-18  
**Status:** 🟡 In Progress

---

## Testing Scope

### Features Under Test
1. **PNL Warmup Period** - Profit vesting mechanism
2. **Insurance Fund Health** - Safety metrics & history
3. **Open Interest Metrics** - Long/short breakdown & aggregates

### Test Categories
- ✅ **Backend API Tests** - Endpoint validation
- ✅ **Database Tests** - Schema & data integrity
- ✅ **Unit Tests** - Business logic
- ✅ **Integration Tests** - End-to-end API flows
- ✅ **Component Tests** - UI rendering & interaction
- ✅ **E2E Tests** - User workflows (Playwright)
- ✅ **Performance Tests** - Response times
- ✅ **Security Tests** - Injection & auth
- ✅ **Regression Tests** - Existing functionality

---

## Test Deliverables

### 1. Test Scripts
- [x] `test-hidden-apis.sh` - API endpoint testing
- [x] `test-hidden-db.sql` - Database validation
- [x] `test-hidden-perf.sh` - Performance benchmarks

### 2. Backend Tests
- [ ] `tests/unit/warmup.test.ts` - Warmup calculations
- [ ] `tests/unit/insurance.test.ts` - Insurance health metrics
- [ ] `tests/unit/oi.test.ts` - OI calculations
- [ ] `tests/integration/hidden-features.test.ts` - API integration

### 3. Frontend Tests
- [ ] `app/__tests__/WarmupProgress.test.tsx` - Warmup UI
- [ ] `app/__tests__/InsuranceDashboard.test.tsx` - Insurance UI
- [ ] `app/__tests__/OpenInterestCard.test.tsx` - OI display
- [ ] `app/__tests__/e2e/hidden-features.spec.ts` - E2E flows

### 4. Documentation
- [x] `TESTING-PLAN.md` - This file
- [ ] `TESTING-REPORT.md` - Results summary
- [ ] `BUGS-FOUND.md` - Issue tracking
- [ ] Coverage reports

---

## Test Environment Setup

### Prerequisites
```bash
# Backend server running
cd packages/server && pnpm dev

# Frontend app running
cd app && pnpm dev

# Database accessible
psql $DATABASE_URL -c "SELECT 1"

# Test dependencies installed
pnpm install
```

### Environment Variables
```bash
DATABASE_URL=postgresql://...
RPC_URL=https://api.devnet.solana.com
TEST_SLAB_ADDRESS=<valid_test_slab>
```

---

## Success Criteria

### Must Pass (Deployment Blockers)
- [ ] All unit tests passing
- [ ] All integration tests passing
- [ ] No critical security vulnerabilities
- [ ] No regression in existing features
- [ ] API response times < 200ms
- [ ] Database queries optimized

### Nice to Have (Post-Launch)
- [ ] E2E tests passing (may be flaky)
- [ ] Component tests 90%+ coverage
- [ ] Performance benchmarks documented

---

## Test Execution Timeline

**Day 1 (Feb 14):**
- [x] Create test infrastructure
- [ ] Write unit tests
- [ ] Write API test scripts
- [ ] Initial test run & bug documentation

**Day 2 (Feb 15):**
- [ ] Fix critical bugs
- [ ] Write integration tests
- [ ] Performance testing
- [ ] Security testing

**Day 3 (Feb 16):**
- [ ] E2E tests
- [ ] Regression testing
- [ ] Documentation
- [ ] Final test report

**Day 4 (Feb 17):**
- [ ] Bug fixes verification
- [ ] Final approval
- [ ] Pre-deployment checks

---

## Known Risks

1. **Implementation Dependencies**
   - Backend sub-agent must complete APIs first
   - UI sub-agent must complete components
   - Migration 007 must be applied to test DB

2. **Data Availability**
   - Need real/mock on-chain data for testing
   - Insurance history may be empty on fresh DBs
   - Warmup testing requires specific slot timing

3. **Environment Stability**
   - Devnet RPC may be unreliable
   - Local test DB setup required
   - Crank service must be running

---

## Next Steps

1. **Immediate:**
   - Create API test scripts
   - Set up test database with migration 007
   - Write unit tests for calculations

2. **Waiting On:**
   - Backend API implementation completion
   - UI component implementation completion
   - Migration 007 creation

3. **Blockers:**
   - None yet - proceeding with test infrastructure

---

**Updated:** 2026-02-14 17:11 UTC
