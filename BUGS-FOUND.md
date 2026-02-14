# Hidden Features - Bugs & Issues Tracker

**Last Updated:** 2026-02-14 17:11 UTC  
**QA Engineer:** Testing Subagent  
**Status:** 🟡 Testing In Progress

---

## 🔴 Critical (Deployment Blockers)

> Issues that prevent deployment or break core functionality

### CRIT-001: Hidden Features APIs Not Implemented
- **Component:** Backend API
- **Description:** None of the new API endpoints exist yet
  - `/api/warmup/:slab/:idx` - 404
  - `/api/insurance/:slab` - Returns old insurance LP data, not fund health
  - `/api/oi/:slab` - 404
  - `/api/oi/global` - 404
- **Impact:** All new features non-functional
- **Found:** 2026-02-14 during API testing
- **Status:** 🔴 BLOCKED - Waiting on backend sub-agent
- **Assignee:** Backend implementation sub-agent
- **Resolution:** Implement all endpoints per spec

### CRIT-002: Migration 007 Not Created
- **Component:** Database
- **Description:** Migration 007 hasn't been created yet
  - Missing columns in `market_stats`: `warmup_period_slots`, `total_open_interest`, `net_lp_pos`, `insurance_balance`
  - Missing tables: `insurance_history`, `oi_history`
- **Impact:** No database schema to test against
- **Found:** 2026-02-14 during schema validation
- **Status:** 🔴 BLOCKED - Waiting on backend sub-agent
- **Assignee:** Backend implementation sub-agent
- **Resolution:** Create and apply migration 007

### CRIT-003: UI Components Not Implemented
- **Component:** Frontend UI
- **Description:** No UI components exist for new features
  - No WarmupProgress component
  - No enhanced InsuranceDashboard (current one is basic)
  - No OpenInterestCard component
- **Impact:** Cannot perform UI/E2E testing
- **Found:** 2026-02-14 during component review
- **Status:** 🔴 BLOCKED - Waiting on UI sub-agent
- **Assignee:** UI implementation sub-agent
- **Resolution:** Implement all UI components per spec

---

## 🟠 High Priority

> Serious issues that should be fixed before deployment

*(None yet - APIs haven't been implemented to test)*

---

## 🟡 Medium Priority

> Issues that should be addressed but aren't blockers

*(None yet)*

---

## 🟢 Low Priority / Nice-to-Have

> Minor issues or improvements

*(None yet)*

---

## ✅ Resolved

> Fixed issues (for tracking)

*(None yet)*

---

## 🧪 Test Blockers

### Current Blockers Preventing Testing:
1. **Backend APIs** - No endpoints implemented → Cannot run API tests
2. **Database Schema** - Migration 007 not created → Cannot run DB tests
3. **UI Components** - Components not built → Cannot run component/E2E tests
4. **StatsCollector** - Not reading new fields → Cannot validate data collection

### What CAN Be Tested Now:
✅ Unit tests (calculations logic) - Created and ready  
✅ Test scripts - Created and ready to run once APIs exist  
✅ Test infrastructure - In place

### What CANNOT Be Tested Yet:
❌ API endpoints  
❌ Database queries  
❌ UI rendering  
❌ E2E workflows  
❌ Performance benchmarks  

---

## 📊 Bug Statistics

| Priority | Open | In Progress | Resolved |
|----------|------|-------------|----------|
| Critical | 3    | 0           | 0        |
| High     | 0    | 0           | 0        |
| Medium   | 0    | 0           | 0        |
| Low      | 0    | 0           | 0        |
| **Total**| **3**| **0**       | **0**    |

---

## 🎯 Next Steps

1. **Wait for Backend APIs** - Monitor backend sub-agent progress
2. **Wait for Migration 007** - Database schema must be ready
3. **Wait for UI Components** - Frontend implementation required
4. **Run Test Suite** - Once implementations complete:
   - Run `./test-hidden-apis.sh`
   - Run `psql < test-hidden-db.sql`
   - Run `pnpm test` (unit tests)
   - Run `./test-hidden-perf.sh`
   - Run E2E tests

---

## 📝 Bug Report Template

```markdown
### BUG-XXX: Short Title

- **Component:** Backend/Frontend/Database
- **Priority:** Critical/High/Medium/Low
- **Description:** What's wrong?
- **Steps to Reproduce:**
  1. Step 1
  2. Step 2
- **Expected Behavior:** What should happen
- **Actual Behavior:** What actually happens
- **Impact:** How bad is it?
- **Found:** Date and during what test
- **Status:** 🔴 Open / 🟡 In Progress / 🟢 Resolved
- **Assignee:** Who's fixing it
- **Resolution:** How it was/will be fixed
```

---

**Note:** This document will be updated continuously as testing progresses. All blockers must be resolved before deployment on Feb 18.
