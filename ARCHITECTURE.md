# Percolator Launch - Architecture Guide

## Overview

**Percolator** is a Solana-based decentralized prediction market and trading platform that combines on-chain trading logic with off-chain indexing, pricing, and orchestration services.

## Technology Stack

- **Frontend**: Next.js 16 + React 18 (TypeScript)
- **Backend**: Hono web framework on Node.js
- **On-Chain**: Solana Rust program + core trading library
- **Database**: Supabase (PostgreSQL)
- **Deployment**: Docker + Railway.app
- **Package Manager**: pnpm (monorepo workspace)

---

## Project Structure

```
percolator-launch/
├── app/                      # Next.js frontend application
│   ├── app/                  # App router pages and API routes
│   ├── components/           # React components
│   ├── hooks/                # Custom React hooks
│   └── lib/                  # Utility libraries
│
├── packages/
│   ├── core/                 # Shared SDK (@percolator/core)
│   │   └── src/              # Slab parsing, trade encoding
│   ├── server/               # Backend API (@percolator/server)
│   │   ├── src/
│   │   │   ├── routes/       # API route handlers
│   │   │   ├── services/     # Business logic services
│   │   │   ├── db/           # Database queries
│   │   │   └── index.ts      # Main server entry point
│   └── simulation/           # Simulation engine
│
├── services/
│   ├── keeper/               # Liquidation/crank keeper
│   └── oracle/               # Price oracle service
│
├── program/                  # Solana on-chain program (Rust)
│   └── src/
│       └── percolator.rs     # Instruction handler
│
├── percolator/               # Core trading library (Rust)
│   └── src/
│       ├── slab/             # Order book implementation
│       └── lib.rs            # Trading primitives
│
├── supabase/                 # Database migrations & schemas
│   └── migrations/
│
└── .github/workflows/        # CI/CD pipelines
```

---

## Core Architecture Patterns

### 1. Monorepo Structure

The project uses **pnpm workspaces** to manage multiple packages:
- `@percolator/app` - Frontend application
- `@percolator/server` - Backend API server
- `@percolator/core` - Shared SDK used by both

### 2. Service-Oriented Backend

The backend follows a **service-based architecture** where each major feature is implemented as a service class:

**Key Services:**
- `OracleService` - Fetches prices from DexScreener/Jupiter
- `CrankService` - Manages market state updates on-chain
- `TradeIndexerPolling` - Indexes trades from Solana
- `HeliusWebhookManager` - Real-time webhook integration
- `SimulationService` - Testing/demo environment
- `PriceEngine` - Price calculation and distribution
- `LiquidationService` - Monitors and executes liquidations
- `InsuranceLPService` - Insurance fund management

**Service Lifecycle:**
1. Services instantiated in `index.ts`
2. Crank discovery (finds all market slabs)
3. Services started sequentially
4. Event bus for inter-service communication

### 3. API Route Organization

Routes are modular and dependency-injected:

**Route Modules** (`packages/server/src/routes/`):
- `markets.ts` - Market data and discovery
- `trades.ts` - Trade history and volume
- `prices.ts` - Real-time pricing (WebSocket + HTTP)
- `crank.ts` - Crank management
- `webhook.ts` - Helius webhook ingest
- `health.ts` - System health checks

**Middleware Stack:**
- `requireApiKey()` - API authentication
- `validateSlab` - Address validation
- `readRateLimit()` / `writeRateLimit()` - Rate limiting
- CORS with origin whitelist

### 4. Frontend Architecture

**Page Structure** (`app/app/`):
- App Router with dynamic routes
- Server-side API routes in `api/`
- Client components with React hooks

**Component Organization** (`app/components/`):
- Feature-based modules (e.g., `trade/`, `deposit/`, `positions/`)
- Shared UI components (`ui/`)
- Context providers (`providers/`)

**Data Fetching:**
- Custom hooks (`useMyFeature`)
- Solana wallet integration (`@solana/wallet-adapter-react`)
- Real-time WebSocket connections

### 5. Database Pattern

**Supabase Integration:**
- Centralized queries in `packages/server/src/db/queries.ts`
- Type-safe interfaces for all tables
- Migration files in `supabase/migrations/`

**Key Tables:**
- `trades` - Historical trade data
- `markets` - Market configurations
- `stats` - Aggregated statistics
- `funding_rates` - Funding rate history

### 6. Event-Driven Communication

**Event Bus** (`packages/server/src/services/events.ts`):
```typescript
// Services emit events
eventBus.emit("crank.success", { slabAddress: "..." });

// Other services subscribe
eventBus.on("crank.success", (payload) => {
  // Handle event
});
```

**Common Events:**
- `crank.success` - Market state updated
- `trade.indexed` - New trade indexed
- `price.updated` - Price feed updated

---

## Key Entry Points

| Component | File | Purpose |
|-----------|------|---------|
| **Backend Server** | `packages/server/src/index.ts` | Hono server initialization |
| **Frontend App** | `app/page.tsx` | Next.js homepage |
| **Solana Program** | `program/src/percolator.rs` | On-chain instruction handler |
| **Core SDK** | `packages/core/src/index.ts` | Shared trading utilities |

---

## Configuration Management

**Environment Variables:**
- `.env.example` - Template for all required variables
- `packages/server/src/config.ts` - Centralized config object
- Railway.app environment for production

**Key Configurations:**
- RPC endpoints (Solana)
- Supabase credentials
- Crank keypair (for on-chain operations)
- Program IDs (multiple environments supported)
- API keys and rate limits

---

## Build & Deployment

### Local Development

```bash
# Install dependencies
pnpm install

# Run frontend (Next.js)
pnpm dev

# Run backend (Hono)
pnpm --filter @percolator/server dev

# Build all packages
pnpm build

# Run tests
pnpm test
```

### Docker Deployment

**Multi-stage builds:**
- `Dockerfile` - Frontend (Next.js)
- `Dockerfile.server` - Backend (Node.js)

**Railway.app:**
- Automatic deployment from GitHub
- Environment variables managed in Railway dashboard
- `railway.json` specifies build and restart policies

### CI/CD Pipelines

**GitHub Actions** (`.github/workflows/`):
- Unit tests on PR
- Integration tests
- Verified Solana program builds
- Deployment automation

---

## Adding New Features

### Quick Start Checklist

To add a new feature to Percolator Launch:

#### 1. Backend Service (if needed)

Create service class:
```typescript
// packages/server/src/services/MyFeatureService.ts
export class MyFeatureService {
  start(): void { /* initialization */ }
  stop(): void { /* cleanup */ }
  getStatus(): any { /* expose state */ }
}
```

Register in `packages/server/src/index.ts`:
```typescript
const myFeatureService = new MyFeatureService();
// After crank discovery:
myFeatureService.start();
```

#### 2. Backend Routes

Create route module:
```typescript
// packages/server/src/routes/my-feature.ts
import { Hono } from "hono";

interface MyFeatureDeps {
  myService: MyFeatureService;
}

export function myFeatureRoutes(deps: MyFeatureDeps): Hono {
  const app = new Hono();
  
  app.get("/my-feature/:slab", validateSlab, (c) => {
    const data = deps.myService.getData(c.req.param("slab"));
    return c.json({ data });
  });
  
  return app;
}
```

Mount in `packages/server/src/index.ts`:
```typescript
app.route("/", myFeatureRoutes({ myService: myFeatureService }));
```

#### 3. Database Layer (if needed)

Add queries to `packages/server/src/db/queries.ts`:
```typescript
export interface MyDataRow {
  id: string;
  slab_address: string;
  value: number;
  created_at: string;
}

export async function getMyData(slabAddress: string): Promise<MyDataRow[]> {
  const { data, error } = await getSupabase()
    .from("my_data_table")
    .select("*")
    .eq("slab_address", slabAddress);
  
  if (error) throw error;
  return data ?? [];
}
```

Create migration in `supabase/migrations/`:
```sql
-- supabase/migrations/YYYYMMDD_my_feature.sql
CREATE TABLE my_data_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slab_address TEXT NOT NULL,
  value NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_my_data_slab ON my_data_table(slab_address);
```

#### 4. Frontend API Route

Create Next.js API route:
```typescript
// app/app/api/my-feature/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("my_feature")
    .select("*");
  
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  
  return NextResponse.json({ data });
}
```

For parameterized routes:
```typescript
// app/app/api/my-feature/[slab]/route.ts
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slab: string }> }
) {
  const { slab } = await params;
  // Query logic...
}
```

#### 5. Frontend Hook

Create custom hook:
```typescript
// app/hooks/useMyFeature.ts
"use client";

import { useCallback, useState } from "react";

export function useMyFeature(slabAddress: string) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/my-feature/${slabAddress}`);
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [slabAddress]);

  return { data, loading, error, fetch };
}
```

#### 6. Frontend Components

Create feature component:
```typescript
// app/components/my-feature/MyFeaturePanel.tsx
"use client";

import { useMyFeature } from "@/hooks/useMyFeature";
import { useSlabState } from "@/components/providers/SlabProvider";

export function MyFeaturePanel() {
  const { config: mktConfig } = useSlabState();
  const { data, loading } = useMyFeature(mktConfig?.slabAddress);
  
  if (loading) return <div>Loading...</div>;
  
  return (
    <div className="glass-card">
      {/* Component JSX */}
    </div>
  );
}
```

#### 7. Add to Page (optional)

Create dedicated page:
```typescript
// app/app/my-feature/page.tsx
import { MyFeaturePanel } from "@/components/my-feature/MyFeaturePanel";

export default function MyFeaturePage() {
  return (
    <main className="container mx-auto p-4">
      <h1>My Feature</h1>
      <MyFeaturePanel />
    </main>
  );
}
```

Or add to existing page:
```typescript
// app/app/page.tsx or other page
import { MyFeaturePanel } from "@/components/my-feature/MyFeaturePanel";

// Add <MyFeaturePanel /> to JSX
```

---

## Extension Points Reference

### Backend Extension Points

| Location | Purpose | Pattern |
|----------|---------|---------|
| `packages/server/src/services/` | Business logic | Service class with `start()`, `stop()` |
| `packages/server/src/routes/` | API endpoints | Hono router with dependency injection |
| `packages/server/src/db/queries.ts` | Database access | Async functions returning typed data |
| `packages/server/src/config.ts` | Configuration | Add environment variables |

### Frontend Extension Points

| Location | Purpose | Pattern |
|----------|---------|---------|
| `app/app/api/` | Next.js API routes | `route.ts` with GET/POST handlers |
| `app/hooks/` | Data fetching | Custom hooks with state management |
| `app/components/` | UI components | Feature-based modules |
| `app/app/` | Pages | App Router pages |

### Event System

| Location | Purpose | Example |
|----------|---------|---------|
| `packages/server/src/services/events.ts` | Inter-service communication | `eventBus.on()`, `eventBus.emit()` |

**Common Event Patterns:**
```typescript
// Emit event from service
eventBus.emit("my-feature.updated", { slabAddress, data });

// Subscribe in another service
eventBus.on("my-feature.updated", (payload) => {
  console.log("Feature updated:", payload);
});
```

---

## Testing Patterns

### Backend Tests

Located in `packages/server/src/__tests__/`

**Test Structure:**
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("MyFeatureService", () => {
  beforeAll(async () => {
    // Setup
  });

  it("should do something", async () => {
    // Test
    expect(result).toBe(expected);
  });

  afterAll(async () => {
    // Cleanup
  });
});
```

### Frontend Tests

Located in `app/__tests__/` and `e2e/`

**Component Tests:**
```typescript
import { render, screen } from "@testing-library/react";
import { MyFeaturePanel } from "@/components/my-feature/MyFeaturePanel";

describe("MyFeaturePanel", () => {
  it("renders correctly", () => {
    render(<MyFeaturePanel />);
    expect(screen.getByText("My Feature")).toBeInTheDocument();
  });
});
```

### E2E Tests

Located in `e2e/`

**Playwright Tests:**
```typescript
import { test, expect } from "@playwright/test";

test("my feature workflow", async ({ page }) => {
  await page.goto("/my-feature");
  await expect(page.getByText("My Feature")).toBeVisible();
});
```

---

## Security Considerations

1. **API Authentication**: Use `requireApiKey()` middleware for sensitive endpoints
2. **Rate Limiting**: Apply appropriate limits (read vs. write)
3. **Input Validation**: Always validate slab addresses and user inputs
4. **CORS**: Only allow whitelisted origins
5. **Environment Variables**: Never commit secrets to repository
6. **SQL Injection**: Use parameterized queries via Supabase client
7. **XSS Prevention**: Sanitize user-generated content

---

## Common Patterns & Best Practices

### Dependency Injection

Services receive dependencies via constructor or function parameters:
```typescript
// Good: Explicit dependencies
export function myRoutes(deps: { service: MyService }): Hono {
  // Use deps.service
}

// Avoid: Global state or singletons
```

### Error Handling

**Backend:**
```typescript
try {
  const data = await riskyOperation();
  return c.json({ data });
} catch (error) {
  console.error("Operation failed:", error);
  return c.json({ error: "Internal server error" }, { status: 500 });
}
```

**Frontend:**
```typescript
const [error, setError] = useState<string | null>(null);

try {
  await operation();
} catch (err) {
  setError(err instanceof Error ? err.message : "Unknown error");
}
```

### Type Safety

All code uses TypeScript with strict mode:
```typescript
// Define interfaces for data structures
interface MyData {
  id: string;
  value: number;
}

// Use typed responses
async function getData(): Promise<MyData[]> {
  // Implementation
}
```

### Async Operations

Use async/await consistently:
```typescript
// Good
const result = await fetchData();
const processed = await processData(result);

// Avoid nested callbacks
```

---

## Troubleshooting

### Common Issues

1. **Service not starting**: Check `index.ts` service instantiation order
2. **Route not found**: Verify route mounting in `index.ts`
3. **Database query fails**: Check Supabase credentials and table schemas
4. **Frontend build fails**: Run `pnpm build` and check TypeScript errors
5. **WebSocket connection fails**: Verify CORS settings and origin whitelist

### Debugging Tools

- **Backend logs**: Console output in `packages/server/src/`
- **Frontend DevTools**: React DevTools, Network tab
- **Database**: Supabase dashboard for query debugging
- **Solana**: Solana Explorer for transaction inspection

---

## Resources

- [Next.js Documentation](https://nextjs.org/docs)
- [Hono Documentation](https://hono.dev/)
- [Solana Documentation](https://docs.solana.com/)
- [Supabase Documentation](https://supabase.com/docs)
- [pnpm Documentation](https://pnpm.io/)

---

## Getting Help

1. Check existing documentation in repository
2. Review similar features in the codebase
3. Check CI/CD logs for deployment issues
4. Review migration files for database schema
5. Consult team members for architecture questions

---

*Last Updated: 2026-02-15*
