# Pyth-Correlated Oracle - Usage Guide

## Quick Start

### 1. Basic Pyth-Correlated Simulation

```typescript
import { SimulationManager } from '@/lib/simulation/SimulationManager';

const manager = SimulationManager.getInstance();

// Start simulation with Pyth-correlated crash scenario
await manager.start({
  slabAddress: 'YOUR_SLAB_PUBLIC_KEY',
  startPriceE6: 100_000_000, // Initial price (Pyth overrides this)
  scenario: 'pyth-crash',
  pythFeed: 'SOL/USD', // Optional, defaults to SOL/USD
  intervalMs: 5000, // Update every 5 seconds
});

// Simulation runs for scenario duration (2 min for crash)
// Automatically stops Pyth polling when done
```

### 2. Manual Pyth Price Fetching

```typescript
import { getPythPriceManager } from '@/lib/simulation/pyth';

const pythManager = getPythPriceManager();

// One-time fetch
const solPrice = await pythManager.fetchSinglePrice('SOL/USD');
console.log(`SOL/USD: $${solPrice}`);

// Start continuous polling
pythManager.startPolling(['SOL/USD', 'BTC/USD', 'ETH/USD'], 3000);

// Get cached price
const cachedPrice = pythManager.getLatestPrice('SOL/USD');

// Stop polling
pythManager.stopPolling();
```

### 3. Custom Pyth Model with Parameters

```typescript
await manager.start({
  slabAddress: slabAddress,
  startPriceE6: 180_000_000,
  model: 'pyth-volatile', // Use model directly (not scenario)
  pythFeed: 'SOL/USD',
  intervalMs: 2000,
  params: {
    volatilityAmplification: 3.0, // Amplify real moves by 3x
    volatility: 0.015, // Add 1.5% noise
  },
});
```

### 4. Switching Scenarios Mid-Simulation

```typescript
const manager = SimulationManager.getInstance();

// Start with calm tracking
await manager.start({
  slabAddress: slabAddress,
  startPriceE6: 100_000_000,
  scenario: 'pyth-calm',
  pythFeed: 'SOL/USD',
});

// 2 minutes later, trigger a crash
setTimeout(() => {
  manager.triggerScenario('pyth-crash');
}, 120000);

// Crash runs for 2 min, then simulation auto-stops
```

## API Reference

### PythPriceManager

#### `startPolling(feedNames: PythFeedName[], intervalMs?: number)`
Start polling Pyth prices for specified feeds.

```typescript
pythManager.startPolling(['SOL/USD', 'BTC/USD'], 3000);
```

#### `stopPolling()`
Stop all polling.

```typescript
pythManager.stopPolling();
```

#### `getLatestPrice(feedName: PythFeedName): number | null`
Get cached price for a feed. Returns `null` if not available.

```typescript
const price = pythManager.getLatestPrice('SOL/USD');
if (price) {
  console.log(`SOL: $${price.toFixed(2)}`);
}
```

#### `fetchSinglePrice(feedName: PythFeedName): Promise<number | null>`
Fetch a single price immediately (one-time, not polling).

```typescript
const btcPrice = await pythManager.fetchSinglePrice('BTC/USD');
```

#### `getStatus()`
Get current status of the price manager.

```typescript
const status = pythManager.getStatus();
console.log(status);
// {
//   isPolling: true,
//   pollIntervalMs: 3000,
//   cachedFeeds: 2,
//   feeds: [
//     { name: 'SOL/USD', price: 178.45, age: 2500 },
//     { name: 'BTC/USD', price: 95234.12, age: 2500 }
//   ]
// }
```

---

### SimulationManager (Pyth Extensions)

#### Config Parameters

```typescript
interface SimulationConfig {
  slabAddress: string;
  startPriceE6: number; // Not used in Pyth modes (Pyth price takes over)
  model?: string; // 'pyth-calm', 'pyth-crash', etc.
  scenario?: ScenarioName; // Or use scenario preset
  intervalMs?: number; // Update frequency (default 5000ms)
  params?: Record<string, number>; // Model-specific params
  pythFeed?: PythFeedName; // 'SOL/USD', 'BTC/USD', 'ETH/USD'
}
```

#### State

```typescript
interface SimulationState {
  running: boolean;
  slabAddress: string | null;
  currentPriceE6: number; // Current simulation price
  model: string;
  scenario: ScenarioName | null;
  startedAt: number;
  updatesCount: number;
  sessionId: number | null;
  params: Record<string, number>;
  pythFeed: PythFeedName | null; // Active Pyth feed
  pythBasePrice: number | null; // Last known Pyth price (USD)
}
```

---

## Scenario Comparison

| Scenario | Base Price | Overlay | Duration | Use Case |
|----------|-----------|---------|----------|----------|
| `pyth-calm` | Real Pyth | +0.1% noise | 5 min | Normal market tracking |
| `pyth-crash` | Real Pyth | -40% ramp | 2 min | Liquidation cascade test |
| `pyth-squeeze` | Real Pyth | +50% spike | 3 min | Short squeeze simulation |
| `pyth-blackswan` | Real Pyth | -40% flash drop | 1.5 min | Extreme event stress test |
| `pyth-volatile` | Real Pyth | 2.5x amplified | 5 min | High volatility testing |

---

## Common Patterns

### Pattern 1: Track Real Market with Minimal Deviation

```typescript
// Use for testing with real market conditions
await manager.start({
  slabAddress: slabAddress,
  scenario: 'pyth-calm',
  pythFeed: 'SOL/USD',
  intervalMs: 3000,
});
```

### Pattern 2: Simulate Crash During Bull Market

```typescript
// Even if real market is pumping, simulate a crash
await manager.start({
  slabAddress: slabAddress,
  scenario: 'pyth-crash',
  pythFeed: 'BTC/USD',
  intervalMs: 2000,
  params: {
    crashMagnitude: 0.6, // -60% crash (more severe)
    volatility: 0.03, // 3% noise
  },
});
```

### Pattern 3: Test Extreme Volatility on Stablecoins

```typescript
// Stress test with amplified BTC volatility
await manager.start({
  slabAddress: slabAddress,
  model: 'pyth-volatile',
  pythFeed: 'BTC/USD',
  intervalMs: 1000, // 1 second updates
  params: {
    volatilityAmplification: 5.0, // 5x real moves
    volatility: 0.02,
  },
});
```

---

## Error Handling

### Pyth API Down

If Pyth API is unreachable, the simulation:
1. Logs the error to console
2. Falls back to last known cached price
3. Continues running (doesn't crash)
4. Warns if price is stale (>30s old)

```typescript
// Example console output:
// "Failed to fetch Pyth prices: TypeError: fetch failed"
// "Using cached Pyth price: $178.45"
// "Pyth price for SOL/USD is stale (45s old)"
```

### No Cached Price Available

If Pyth has never successfully fetched a price:
- Simulation throws error during `start()`: `"Failed to fetch initial Pyth price for SOL/USD"`
- Use `fetchSinglePrice()` before starting simulation to pre-warm cache

```typescript
// Pre-warm cache
const pythManager = getPythPriceManager();
await pythManager.fetchSinglePrice('SOL/USD');

// Now safe to start
await manager.start({
  scenario: 'pyth-calm',
  pythFeed: 'SOL/USD',
  // ...
});
```

---

## Performance Considerations

### Polling Interval
- **Too fast (<1s):** May hit Pyth rate limits, wastes API calls
- **Too slow (>10s):** Price may be stale, less responsive to market
- **Recommended:** 2-5 seconds for most use cases

### Multiple Simulations
- Each simulation using Pyth shares the same `PythPriceManager` singleton
- Only one polling loop runs (efficient)
- If running multiple simulations, use the same `pythFeed` to share polling

### Database Load
- Each price update writes to `simulation_price_history`
- For long-running sims, consider increasing `intervalMs` to reduce DB writes

---

## Debugging

### Check Pyth Status

```typescript
const pythManager = getPythPriceManager();
const status = pythManager.getStatus();

console.log('Pyth Status:', status);
// {
//   isPolling: true,
//   pollIntervalMs: 3000,
//   cachedFeeds: 1,
//   feeds: [
//     { name: 'SOL/USD', price: 178.45, age: 2500 }
//   ]
// }
```

### Check Simulation State

```typescript
const manager = SimulationManager.getInstance();
const state = manager.getState();

console.log('Simulation State:', state);
// {
//   running: true,
//   model: 'pyth-crash',
//   pythFeed: 'SOL/USD',
//   pythBasePrice: 178.45,
//   currentPriceE6: 125000000, // $125 (crash applied)
//   // ...
// }
```

### Manual Price Override

```typescript
// Force a specific price (bypasses Pyth and model)
await manager.setPrice(100_000_000); // Set to $100
```

---

## Example: Full Simulation Workflow

```typescript
import { SimulationManager } from '@/lib/simulation/SimulationManager';
import { getPythPriceManager } from '@/lib/simulation/pyth';

async function runSimulation() {
  const manager = SimulationManager.getInstance();
  const pythManager = getPythPriceManager();
  
  // 1. Pre-check Pyth connectivity
  console.log('Checking Pyth connectivity...');
  const initialPrice = await pythManager.fetchSinglePrice('SOL/USD');
  if (!initialPrice) {
    throw new Error('Pyth API unreachable');
  }
  console.log(`Pyth connected: SOL/USD = $${initialPrice.toFixed(2)}`);
  
  // 2. Start simulation
  console.log('Starting simulation...');
  await manager.start({
    slabAddress: 'YOUR_SLAB_ADDRESS',
    startPriceE6: Math.round(initialPrice * 1e6),
    scenario: 'pyth-crash',
    pythFeed: 'SOL/USD',
    intervalMs: 3000,
  });
  
  console.log('Simulation running...');
  
  // 3. Monitor state every 10 seconds
  const monitorInterval = setInterval(() => {
    const state = manager.getState();
    const pythStatus = pythManager.getStatus();
    
    console.log({
      running: state.running,
      currentPrice: (state.currentPriceE6 / 1e6).toFixed(2),
      pythBasePrice: state.pythBasePrice?.toFixed(2),
      updates: state.updatesCount,
      pythAge: pythStatus.feeds[0]?.age,
    });
    
    if (!state.running) {
      clearInterval(monitorInterval);
      console.log('Simulation completed');
    }
  }, 10000);
}

runSimulation().catch(console.error);
```

---

## Next Steps

1. **Test in Development:**
   ```bash
   npm run dev
   # Navigate to simulation API endpoint
   # POST /api/simulation/start with Pyth scenario
   ```

2. **Monitor Logs:**
   - Watch for Pyth fetch logs
   - Check for stale price warnings
   - Verify price updates to Solana

3. **Frontend Integration:**
   - Display Pyth base price vs simulation price
   - Show delta/overlay applied by scenario
   - Real-time chart of both prices

4. **Production Deployment:**
   - Ensure Pyth API is whitelisted in firewall
   - Monitor Pyth API latency/uptime
   - Set up alerts for stale prices (>30s)
