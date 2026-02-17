# @percolator/simulation

Oracle price engine and bot fleet for Percolator simulation mode. Used for testing market mechanics without real users.

---

## Overview

Two components:

1. **Oracle (price engine)** — Generates realistic price movements using configurable models
2. **Bot fleet** — Simulated traders that open/close positions based on different strategies

---

## Quick Start

```bash
cd packages/simulation
pnpm install
pnpm build
```

---

## Oracle (Price Engine)

Generates synthetic price updates and emits them via callback. Does not send Solana transactions directly — the caller is responsible for calling `PushOraclePrice`.

```typescript
import { PriceEngine } from '@percolator/simulation';

const engine = new PriceEngine(
  {
    slabAddress: 'YourMarketSlabAddress',
    startPriceE6: 5_000_000,  // $5.00
    model: 'random-walk',
    intervalMs: 2000,
    params: {
      volatility: 0.01,  // 1% per step
      minPrice: 100_000,
      maxPrice: 10_000_000,
    },
  },
  async (update) => {
    // Push to chain here
    await pushOraclePrice(update.slabAddress, update.priceE6);
  }
);

engine.start();
engine.stop();
```

### Price Models

| Model | Description |
|-------|-------------|
| `random-walk` | Gaussian movements with configurable volatility |
| `mean-revert` | Price gravitates toward a target with random noise |
| `trending` | Consistent drift with volatility |
| `crash` | Exponential decay with optional recovery |
| `squeeze` | Pump and dump |

Models can be switched at runtime:
```typescript
engine.setModel('trending', { driftPerStep: 10_000 });
engine.triggerCrash(0.5, 10_000);    // 50% crash over 10s
engine.triggerSqueeze(1.0, 15_000);  // 100% pump over 15s
```

All prices are in E6 format (1,000,000 = $1.00). Box-Muller transform for Gaussian distributions.

---

## Bot Fleet

Simulated traders that interact with Percolator markets using different strategies.

```typescript
import { BotFleet, MarketMakerBot, TrendFollowerBot, DegenBot, LPBot } from '@percolator/simulation';

const fleet = new BotFleet({ slabAddress: 'YOUR_SLAB', connection, keypairs });
fleet.start();
```

### Bot Types

| Bot | Strategy |
|-----|---------|
| `MarketMakerBot` | Provides liquidity by placing both sides near the oracle price |
| `TrendFollowerBot` | Opens positions in the direction of recent price movement |
| `DegenBot` | High-leverage random trades — stress tests liquidation paths |
| `LPBot` | Deposits and withdraws from the insurance LP on a cycle |

---

## Architecture

```
packages/simulation/src/
├── oracle/
│   ├── PriceEngine.ts   # Main engine class with event loop
│   ├── models.ts        # Pure price movement functions per model
│   └── types.ts         # PriceEngineConfig, PriceUpdate interfaces
├── bots/
│   ├── BotFleet.ts      # Orchestrates multiple bots
│   ├── BaseBot.ts       # Shared bot lifecycle
│   ├── MarketMakerBot.ts
│   ├── TrendFollowerBot.ts
│   ├── DegenBot.ts
│   ├── LPBot.ts
│   └── types.ts         # Bot config interfaces
└── index.ts             # Public exports
```

---

## Usage in Tests

The simulation package is used in integration tests to drive market activity without human traders:

```typescript
import { PriceEngine, BotFleet } from '@percolator/simulation';

// In test setup:
const oracle = new PriceEngine(config, (update) => pushPrice(update));
const fleet = new BotFleet({ ... });

oracle.start();
fleet.start();

// Run test...

fleet.stop();
oracle.stop();
```

---

## Notes

- TypeScript strict mode
- No direct Solana transaction sending — integrates via callbacks
- Price bounds enforced: default $0.001 to $1000 (configurable)
- Models can be composed: start with random-walk, then trigger a crash
