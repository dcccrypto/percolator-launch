# Test Infrastructure

This document describes the test infrastructure setup for the Percolator Launch project.

## Overview

The test infrastructure consists of:
- **Unit Tests** (Vitest) - Fast, isolated tests for individual functions/components
- **Integration Tests** (Vitest) - Tests for API endpoints + DB + RPC interactions
- **E2E Tests** (Playwright) - Browser-based tests for complete user flows
- **Mocking** (MSW) - Mock external APIs (DexScreener, Jupiter)
- **CI/CD** (GitHub Actions) - Automated testing on every PR

## Quick Start

```bash
# Install dependencies
pnpm install

# Run all tests
pnpm test

# Run specific test suites
pnpm test:unit          # Unit tests only
pnpm test:integration   # Integration tests only
pnpm test:e2e          # E2E tests only
pnpm test:coverage     # Tests with coverage report

# Watch mode for development
cd packages/server && pnpm test:watch
cd app && pnpm test:watch
```

## Test Structure

```
percolator-launch/
├── packages/
│   ├── server/
│   │   ├── vitest.config.ts       # Server test config
│   │   └── tests/
│   │       ├── setup.ts            # Test setup (MSW, env)
│   │       ├── unit/               # Unit tests
│   │       ├── integration/        # Integration tests
│   │       ├── security/           # Security tests
│   │       └── fixtures/           # Test data
│   ├── core/
│   │   └── test/                   # Core library tests
│   └── app/
│       ├── vitest.config.ts        # App test config
│       └── __tests__/
│           ├── setup.ts            # Test setup (React Testing Library)
│           ├── components/         # Component tests
│           ├── hooks/              # Hook tests
│           └── pages/              # Page tests
├── e2e/
│   └── *.spec.ts                   # E2E test specs
├── mocks/
│   ├── handlers.ts                 # MSW request handlers
│   ├── server.ts                   # MSW server (Node.js)
│   └── browser.ts                  # MSW worker (Browser)
├── playwright.config.ts            # E2E test config
└── .github/workflows/test.yml      # CI pipeline
```

## Configuration Files

### Vitest (packages/server/vitest.config.ts)

```typescript
- Coverage threshold: 90% (lines, functions, branches, statements)
- Test timeout: 15s
- Retry on CI: 3 attempts
- Environment: Node.js
```

### Vitest (app/vitest.config.ts)

```typescript
- Coverage threshold: 80% (lower for frontend due to UI complexity)
- Test timeout: 10s
- Retry on CI: 3 attempts
- Environment: jsdom (browser simulation)
```

### Playwright (playwright.config.ts)

```typescript
- Workers: 1 (serial execution due to devnet state)
- Timeout: 60s (blockchain interactions are slow)
- Retry on CI: 3 attempts
- Browsers: Chromium (default), Firefox/Safari (optional)
- Screenshots/videos on failure
```

## Mocking Strategy

### External APIs (Mocked via MSW)
- ✅ **DexScreener API** - Token prices, market data
- ✅ **Jupiter API** - Swap quotes, token list

### Real Dependencies
- ✅ **Solana RPC** - Real devnet calls (critical path)
- ✅ **Database** - Real test database (data integrity)
- ✅ **WebSocket** - Real connections in E2E (real-time behavior)

### Mock Handlers

See `mocks/handlers.ts` for full implementation. Example:

```typescript
// Mock DexScreener token price
http.get('https://api.dexscreener.com/latest/dex/tokens/:address', ({ params }) => {
  return HttpResponse.json({
    pairs: [{ priceUsd: '0.123456', ... }]
  });
});
```

To simulate errors:
```typescript
import { errorHandlers } from '../mocks/handlers';
server.use(...errorHandlers);
```

## CI Pipeline

The GitHub Actions workflow (`.github/workflows/test.yml`) runs on every PR and push to main:

### Jobs

1. **unit-tests** (15 min)
   - Runs all unit tests
   - Uploads coverage to Codecov
   - Fails if coverage < threshold

2. **integration-tests** (20 min)
   - Runs integration tests against test DB
   - Uploads coverage to Codecov
   - Requires devnet RPC access

3. **e2e-tests** (30 min)
   - Builds the app
   - Runs Playwright tests
   - Uploads screenshots/videos on failure

4. **security-tests** (10 min)
   - Runs `pnpm audit`
   - Runs security-specific tests

5. **type-check** (10 min)
   - Type checks with `tsc`
   - Ensures build succeeds

6. **coverage-check** (gate)
   - Enforces coverage thresholds
   - Blocks merge if coverage < 90%

7. **merge-gate** (gate)
   - All previous jobs must pass
   - Blocks PR merge on failure

### Required Secrets

Configure these in GitHub repo settings → Secrets:

- `DEVNET_RPC_URL` - Helius devnet RPC endpoint
- `TEST_DATABASE_URL` - Supabase test DB connection string
- `TEST_WALLET_PRIVATE_KEY` - Test wallet for E2E (devnet only, no real funds!)
- `CODECOV_TOKEN` - Codecov upload token (optional)

## Coverage Requirements

| Package | Threshold | Critical Paths |
|---------|-----------|----------------|
| `server` | 90% | 100% |
| `app` | 80% | 100% |
| `core` | 95% | 100% |

Critical paths (must be 100% covered):
- Trade execution (open/close position)
- Liquidation flow
- Oracle price updates
- Crank operations
- Wallet connection

## Writing Tests

### Unit Test Example

```typescript
// packages/server/tests/unit/oracle.test.ts
import { describe, it, expect } from 'vitest';
import { validatePrice } from '@/services/oracle';

describe('Oracle Service', () => {
  describe('validatePrice', () => {
    it('rejects negative prices', () => {
      expect(() => validatePrice(-100)).toThrow('Price must be positive');
    });

    it('rejects zero prices', () => {
      expect(() => validatePrice(0)).toThrow('Price must be positive');
    });

    it('accepts valid prices', () => {
      expect(validatePrice(123.456)).toBe(123.456);
    });
  });
});
```

### Component Test Example

```typescript
// app/__tests__/components/TradeForm.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TradeForm } from '@/components/TradeForm';

describe('TradeForm', () => {
  it('shows validation error for invalid amount', async () => {
    render(<TradeForm />);
    
    const input = screen.getByLabelText('Amount');
    fireEvent.change(input, { target: { value: 'abc' } });
    
    expect(screen.getByText('Invalid amount')).toBeInTheDocument();
  });
});
```

### E2E Test Example

```typescript
// e2e/trade.spec.ts
import { test, expect } from '@playwright/test';

test('complete trade lifecycle', async ({ page }) => {
  await page.goto('/');
  
  // Connect wallet
  await page.click('text=Connect Wallet');
  await page.click('text=Phantom');
  
  // Open position
  await page.fill('[name="amount"]', '1.0');
  await page.click('text=Long');
  await page.click('text=Open Position');
  
  // Confirm transaction
  await expect(page.locator('text=Position opened')).toBeVisible({ timeout: 30000 });
  
  // Close position
  await page.click('text=Close Position');
  await expect(page.locator('text=Position closed')).toBeVisible({ timeout: 30000 });
});
```

## Debugging Tests

### Vitest

```bash
# Run tests in watch mode
pnpm test:watch

# Run specific test file
pnpm test packages/server/tests/unit/oracle.test.ts

# Debug with breakpoints
node --inspect-brk ./node_modules/vitest/vitest.mjs run
```

### Playwright

```bash
# Run in headed mode (see browser)
pnpm test:e2e --headed

# Debug specific test
pnpm test:e2e --debug e2e/trade.spec.ts

# View test report
npx playwright show-report
```

## Best Practices

1. **Test Isolation**: Each test should be independent
2. **Clear Names**: Test names should describe what they test
3. **AAA Pattern**: Arrange, Act, Assert
4. **Mock External APIs**: Use MSW to avoid flakiness
5. **Avoid Sleep**: Use `waitFor` instead of arbitrary delays
6. **Cleanup**: Reset state after each test
7. **Coverage != Quality**: 100% coverage doesn't mean bug-free

## Common Issues

### Tests fail locally but pass in CI
- Check environment variables (`.env.test`)
- Ensure dependencies are installed (`pnpm install`)
- Clear test cache (`pnpm test --clearCache`)

### Tests are flaky
- Increase timeouts for slow operations
- Add explicit waits (`waitFor`, `toBeVisible`)
- Check for race conditions (concurrent requests)

### Coverage below threshold
- Add tests for uncovered lines
- Check coverage report: `open coverage/index.html`
- Critical paths must have 100% coverage

## Next Steps

1. **Write Critical Tests** - Start with TEST_PLAN.md critical paths
2. **Add Integration Tests** - Test API + DB + RPC interactions
3. **Add E2E Tests** - Test complete user flows
4. **Enable Coverage Gates** - Enforce 90% coverage in CI
5. **Add Performance Tests** - Benchmark API latency

## References

- [TEST_PLAN.md](./TEST_PLAN.md) - Comprehensive test cases
- [Vitest Docs](https://vitest.dev/)
- [Playwright Docs](https://playwright.dev/)
- [MSW Docs](https://mswjs.io/)
- [Testing Library Docs](https://testing-library.com/)

---

**Last Updated**: 2026-02-12  
**Owner**: Cobra (@dcccrypto)
