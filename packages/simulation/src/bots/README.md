# Bot Fleet - Usage Guide

## Overview

The Bot Fleet creates realistic trading activity for Percolator Simulation Mode. Bots emit `TradeIntent` objects which are executed by the integration layer.

## Architecture

```
PriceEngine (oracle) 
    ↓ price updates
BotFleet
    ↓ distributes to
Individual Bots (MarketMaker, TrendFollower, Degen, LP)
    ↓ emit
TradeIntents
    ↓ executed by
Integration Layer (Solana program calls)
```

## Quick Start

```typescript
import { BotFleet } from '@percolator/simulation';
import type { BotFleetConfig, TradeIntent } from '@percolator/simulation';

// 1. Define fleet configuration
const fleetConfig: BotFleetConfig = {
  slabAddress: 'YOUR_SLAB_ADDRESS',
  enabled: true,
  bots: [
    {
      type: 'market-maker',
      name: 'MM-1',
      slabAddress: 'YOUR_SLAB_ADDRESS',
      tradeIntervalMs: 5000,      // Trade every 5 seconds
      maxPositionSize: 1000000,    // 1M base units
      capitalAllocation: 10000000, // 10M lamports
      params: {
        spreadBps: 50,             // 0.5% spread
        rebalanceThreshold: 0.3,   // Rebalance at 30% of max
      },
    },
    {
      type: 'trend-follower',
      name: 'Trend-1',
      slabAddress: 'YOUR_SLAB_ADDRESS',
      tradeIntervalMs: 10000,      // Trade every 10 seconds
      maxPositionSize: 5000000,    // 5M base units
      capitalAllocation: 50000000, // 50M lamports
      params: {
        maPeriod: 20,              // 20-period MA
        stopLossBps: 200,          // 2% stop loss
        takeProfitBps: 500,        // 5% take profit
      },
    },
    {
      type: 'degen',
      name: 'Degen-1',
      slabAddress: 'YOUR_SLAB_ADDRESS',
      tradeIntervalMs: 8000,
      maxPositionSize: 2000000,
      capitalAllocation: 20000000,
      params: {
        maxLeverage: 10,
        liquidationChance: 0.3,
        doubleDownChance: 0.2,
      },
    },
    {
      type: 'lp-provider',
      name: 'LP-1',
      slabAddress: 'YOUR_SLAB_ADDRESS',
      tradeIntervalMs: 15000,
      maxPositionSize: 0,          // Not used for LP
      capitalAllocation: 100000000,
      params: {
        depositSize: 10000000,     // 10M per deposit
        withdrawThreshold: 0.1,    // Withdraw at 10% utilization
        targetLpSize: 100000000,   // Target 100M total LP
      },
    },
  ],
};

// 2. Create trade handler
const handleTrade = async (intent: TradeIntent): Promise<boolean> => {
  console.log(`Trade Intent from ${intent.botName}:`, {
    slabAddress: intent.slabAddress,
    lpIdx: intent.lpIdx,
    userIdx: intent.userIdx,
    size: intent.size.toString(),
  });
  
  // TODO: Execute actual on-chain transaction
  // For now, just log
  return true;
};

// 3. Initialize fleet
const fleet = new BotFleet(fleetConfig, handleTrade);

// 4. Start bots
fleet.start();

// 5. Feed price updates (from PriceEngine)
setInterval(() => {
  const priceE6 = 50000000 + Math.random() * 1000000; // Mock price
  fleet.updatePrice(priceE6);
}, 1000);

// 6. Monitor state
setInterval(() => {
  const state = fleet.getState();
  console.log('Fleet State:', {
    running: state.running,
    totalTrades: state.totalTradesExecuted,
    bots: state.bots.map(b => ({
      name: b.name,
      type: b.type,
      positionSize: b.positionSize,
      pnl: b.pnl,
      trades: b.tradesExecuted,
    })),
  });
}, 10000);
```

## Integration with PriceEngine

```typescript
import { PriceEngine, BotFleet } from '@percolator/simulation';

const priceEngine = new PriceEngine({
  model: 'gbm',
  initialPriceE6: 50000000,
  params: { mu: 0.1, sigma: 0.3 },
});

const fleet = new BotFleet(fleetConfig, handleTrade);

// Connect price engine to bot fleet
priceEngine.subscribe((priceE6) => {
  fleet.updatePrice(priceE6);
});

priceEngine.start();
fleet.start();
```

## Bot Types

### 1. MarketMakerBot
- **Strategy**: Provides liquidity with tight spreads
- **Params**:
  - `spreadBps` (default 50): Target spread in basis points
  - `rebalanceThreshold` (default 0.3): Position ratio to trigger rebalance
- **Behavior**: Alternates long/short, stays delta-neutral, takes profit quickly

### 2. TrendFollowerBot
- **Strategy**: Follows price momentum using moving averages
- **Params**:
  - `maPeriod` (default 20): Moving average period
  - `stopLossBps` (default 200): Stop loss threshold (2%)
  - `takeProfitBps` (default 500): Take profit threshold (5%)
- **Behavior**: Long above MA, short below MA, uses risk management

### 3. DegenBot
- **Strategy**: High-risk gambler, designed to get liquidated
- **Params**:
  - `maxLeverage` (default 10): Maximum leverage multiplier
  - `liquidationChance` (default 0.3): Probability of risky behavior
  - `doubleDownChance` (default 0.2): Probability of doubling losing positions
- **Behavior**: Random entries, high leverage, sometimes doubles down on losses

### 4. LPBot
- **Strategy**: Manages LP capital deposits/withdrawals
- **Params**:
  - `depositSize` (default 1000000000): Amount per deposit
  - `withdrawThreshold` (default 0.1): Utilization ratio to withdraw
  - `targetLpSize` (default 10000000000): Target total LP size
- **Behavior**: Maintains LP liquidity, adjusts based on market conditions
- **Note**: Uses different mechanism than traders (Deposit instruction, not TradeNoCpi)

## Dynamic Bot Management

```typescript
// Add a new bot at runtime
fleet.addBot({
  type: 'market-maker',
  name: 'MM-2',
  slabAddress: 'YOUR_SLAB_ADDRESS',
  tradeIntervalMs: 3000,
  maxPositionSize: 500000,
  capitalAllocation: 5000000,
  params: { spreadBps: 30 },
});

// Remove a bot
fleet.removeBot('MM-1');

// Get specific bot
const bot = fleet.getBot('Trend-1');
if (bot) {
  console.log(bot.getState());
}

// Get all bots of a type
const marketMakers = fleet.getBotsByType('market-maker');
```

## Testing

Bots use **seeded RNG** for deterministic behavior:

```typescript
// Same config = same trading pattern
const bot1 = new MarketMakerBot(config, 2);
const bot2 = new MarketMakerBot(config, 2);

// Feed same prices → get same trades
// Perfect for testing and replay
```

## Edge Cases Handled

- ✅ Price at 0 or negative (skipped)
- ✅ Insufficient capital (max position enforced)
- ✅ Rapid price changes (PnL updated each tick)
- ✅ Position flips (entry price recalculated)
- ✅ Graceful start/stop (no dangling intervals)
- ✅ Bot added/removed at runtime
- ✅ Empty price history (bots wait for data)

## Next Steps

1. **Integration Layer**: Implement `handleTrade` to execute actual Solana transactions
2. **Account Management**: Create/fund bot accounts in the slab
3. **State Persistence**: Save/load bot states for recovery
4. **Monitoring**: Build dashboard to visualize bot activity
5. **Risk Management**: Add circuit breakers for extreme conditions

## Performance Notes

- Each bot runs on its own interval (independently)
- Price updates are O(n) where n = number of bots
- History limited to 100 prices (prevents memory growth)
- No blockchain dependencies (pure TypeScript)
- Deterministic (perfect for simulation/testing)

---

**Status**: ✅ Complete - Ready for integration
