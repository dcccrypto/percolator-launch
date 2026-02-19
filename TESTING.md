# Testing Guide — Percolator Launch

## Quick Reference

```bash
# Run all tests (core + app)
pnpm test

# Run app tests only
pnpm test:app

# Run core package tests only
pnpm test:core

# Run hook tests only
pnpm test:hooks

# Watch mode (app tests)
pnpm test:app:watch

# Coverage
pnpm test:coverage

# E2E tests
pnpm test:e2e
```

---

## Test Structure

### App Tests (`app/__tests__/`)
**Environment**: jsdom (browser simulation)  
**Runner**: Vitest  
**Total**: 468 tests

```
app/__tests__/
├── hooks/                    # Business logic hooks
│   ├── useDeposit.test.ts    (18 tests)
│   ├── useWithdraw.test.ts   (25 tests)
│   ├── useTrade.test.ts      (14 tests)
│   ├── useWallet.test.ts     (16 tests)
│   └── useInsuranceLP.test.ts (18 tests)
├── components/               # React components
│   ├── Portfolio.test.tsx
│   ├── MarketCard.test.tsx
│   ├── WarmupProgress.test.tsx
│   └── ...
├── simulate/                 # Simulation feature
│   ├── components/
│   ├── services/
│   ├── api/
│   └── integration/
├── format.test.ts
└── health.test.ts
```

**Run from**:
```bash
cd app && npx vitest run
```

---

### Core Package Tests (`packages/core/test/`)
**Environment**: Node.js  
**Runner**: tsx (TypeScript execution)  
**Total**: 59 custom assertion tests

```
packages/core/test/
├── abi.test.ts          # ABI encoding/decoding
├── dex-oracle.test.ts   # DEX oracle detection
├── slab.test.ts         # Slab data structure
└── validation.test.ts   # Input validation
```

**Note**: Core tests use `tsx` with console.log assertions (not vitest).

**Run from**:
```bash
cd packages/core && pnpm test
# or
tsx test/abi.test.ts
tsx test/pda.test.ts
# etc.
```

---

## Common Issues

### ❌ "document is not defined"
**Cause**: Running app tests from wrong directory without jsdom environment.  
**Fix**: Always run from `app/` directory or use `pnpm test:app`.

```bash
# ❌ Wrong:
cd /percolator-launch && npx vitest run app/__tests__/hooks/useDeposit.test.ts

# ✅ Correct:
cd /percolator-launch && pnpm test:hooks
# or
cd /percolator-launch/app && npx vitest run __tests__/hooks/useDeposit.test.ts
```

### ⚠️ "bigint: Failed to load bindings"
**Status**: Non-blocking warning  
**Impact**: None (pure JS fallback works fine)  
**Action**: Ignore (native bindings are optional optimization)

### ⚠️ React act() warnings
**Status**: Non-blocking warnings  
**Impact**: Low (tests still pass)  
**Action**: Optional cleanup (wrap async updates in `act()`)

---

## CI/CD Configuration

### GitHub Actions Example
```yaml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with:
          version: 8
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Test Core Package
        run: cd packages/core && pnpm test
      
      - name: Test App
        run: cd app && pnpm test
      
      - name: E2E Tests
        run: pnpm test:e2e
```

---

## Coverage

```bash
# Run tests with coverage
pnpm test:coverage

# App coverage report location:
app/coverage/

# View HTML report:
open app/coverage/index.html
```

### Coverage Thresholds (app)
- Lines: 80%
- Functions: 80%
- Branches: 80%
- Statements: 80%

---

## Debugging Tests

### Run specific test file
```bash
cd app && npx vitest run __tests__/hooks/useDeposit.test.ts
```

### Run in watch mode
```bash
cd app && npx vitest watch __tests__/hooks/
```

### Verbose output
```bash
cd app && npx vitest run --reporter=verbose
```

### Filter by test name
```bash
cd app && npx vitest run -t "should execute deposit successfully"
```

### Debug with Node inspector
```bash
cd app && node --inspect-brk ./node_modules/.bin/vitest run __tests__/hooks/useDeposit.test.ts
```

---

## Test Patterns

### Hook Testing
```typescript
import { renderHook, act, waitFor } from "@testing-library/react";

it("should execute deposit successfully", async () => {
  const { result } = renderHook(() => useDeposit(mockSlabAddress));
  
  await act(async () => {
    await result.current.deposit(1000000000n);
  });
  
  await waitFor(() => {
    expect(result.current.state.isLoading).toBe(false);
  });
  
  expect(sendTx).toHaveBeenCalled();
});
```

### Component Testing
```typescript
import { render, screen } from "@testing-library/react";

it("should render portfolio balance", () => {
  render(<Portfolio balance={1000000000n} />);
  
  expect(screen.getByText("1.00 SOL")).toBeInTheDocument();
});
```

---

## Mocking

### Mock Wallet
```typescript
vi.mock("@solana/wallet-adapter-react", () => ({
  useWallet: vi.fn(() => ({
    publicKey: new PublicKey("..."),
    connected: true,
    signTransaction: vi.fn(),
  })),
}));
```

### Mock RPC Connection
```typescript
const mockConnection = {
  getAccountInfo: vi.fn(),
  sendTransaction: vi.fn(),
  confirmTransaction: vi.fn(),
};

(useConnection as any).mockReturnValue({ connection: mockConnection });
```

---

## Resources

- [Vitest Documentation](https://vitest.dev)
- [Testing Library - React](https://testing-library.com/docs/react-testing-library/intro/)
- [Testing Library - User Event](https://testing-library.com/docs/user-event/intro)
- [Testing Library - Jest DOM](https://github.com/testing-library/jest-dom)

---

**Last Updated**: 2026-02-19  
**Status**: ✅ All tests passing
