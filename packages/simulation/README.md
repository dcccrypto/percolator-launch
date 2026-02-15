# @percolator/simulation

Oracle price engine for Percolator simulation mode.

## Overview

This package provides a standalone price simulation engine that generates realistic market price movements for testing and simulation. It does **not** handle Solana transactions directly — it computes prices and emits updates via callback.

## Installation

```bash
cd packages/simulation
npm install
npm run build
```

## Usage

```typescript
import { PriceEngine } from '@percolator/simulation';

// Create engine
const engine = new PriceEngine(
  {
    slabAddress: 'YourMarketSlabAddress',
    startPriceE6: 5000000,  // $5.00
    model: 'random-walk',
    intervalMs: 2000,  // Update every 2 seconds
    params: {
      volatility: 0.01,  // 1% volatility
      minPrice: 100000,  // $0.10 minimum
      maxPrice: 10000000  // $10.00 maximum
    }
  },
  (update) => {
    console.log(`Price: $${update.priceE6 / 1e6}`);
    // Handle Solana PushOraclePrice transaction here
  }
);

// Start simulation
engine.start();

// Switch model on the fly
engine.setModel('trending', { driftPerStep: 10000 });  // $0.01 drift

// Trigger events
engine.triggerCrash(0.5, 10000);    // 50% crash over 10 seconds
engine.triggerSqueeze(1.0, 15000);  // 100% pump over 15 seconds

// Stop simulation
engine.stop();
```

## Price Models

### Random Walk
Gaussian random movements with configurable volatility.

```typescript
model: 'random-walk',
params: {
  volatility: 0.01  // 1% standard deviation
}
```

### Mean Revert
Price gravitates towards a mean with random noise.

```typescript
model: 'mean-revert',
params: {
  meanPrice: 5000000,  // $5.00 target
  revertSpeed: 0.1,    // 10% reversion per step
  volatility: 0.005    // 0.5% noise
}
```

### Trending
Consistent drift with volatility.

```typescript
model: 'trending',
params: {
  driftPerStep: 10000,  // $0.01 per step
  volatility: 0.01      // 1% noise
}
```

### Crash
Exponential price decay with optional recovery.

```typescript
model: 'crash',
params: {
  crashMagnitude: 0.5,     // 50% drop
  crashDurationMs: 10000,  // 10 seconds
  recoverySpeed: 0.1       // Slow recovery
}
```

### Squeeze
Exponential pump and dump.

```typescript
model: 'squeeze',
params: {
  squeezeMagnitude: 1.0,    // 100% pump
  squeezeDurationMs: 15000  // 15 seconds
}
```

## Architecture

- **types.ts** — TypeScript interfaces and types
- **models.ts** — Pure price movement functions
- **PriceEngine.ts** — Main service class with event loop
- **index.ts** — Public exports

## Integration

The engine is designed to integrate with your existing server:

```typescript
import { PriceEngine } from '@percolator/simulation';
import { sendOraclePriceUpdate } from './your-solana-client';

const engine = new PriceEngine(config, async (update) => {
  // Send actual Solana transaction
  await sendOraclePriceUpdate(update.slabAddress, update.priceE6);
});
```

## Notes

- All prices are in **E6 format** (1,000,000 = $1.00)
- Default price bounds: $0.001 to $1000
- Models use proper statistical distributions (Box-Muller transform for Gaussian)
- Event triggers (crash/squeeze) temporarily override the base model
- TypeScript strict mode enabled
