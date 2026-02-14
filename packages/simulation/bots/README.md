# Trading Bot Fleet

Real trading bots that execute on-chain trades via Percolator on Solana devnet.

## Overview

The bot fleet creates realistic market activity by running multiple bot types simultaneously, each with different trading strategies. All bots execute **real transactions** through the Percolator program.

## Bot Types

### 1. MarketMakerBot
**Purpose:** Provide liquidity and maintain tight spreads

**Strategy:**
- Places opposing long/short positions around current price
- Maintains spread (configurable 0.5-2%)
- Stays delta-neutral (net position ~0)
- Adjusts size based on volatility
- Takes profit at tight margins

**Params:**
- `spreadBps` (default 50): Target spread in basis points
- `rebalanceThreshold` (default 0.3): Position ratio to trigger rebalance
- `profitTargetBps` (default 100): PnL target to close position

**Use cases:** Normal markets, high-frequency trading demos

---

### 2. TrendFollowerBot
**Purpose:** Momentum-based directional trading

**Strategy:**
- Tracks moving average (MA) to detect trends
- Goes long when price crosses above MA
- Goes short when price crosses below MA
- Uses trailing stop (closes when trend reverses)
- Stop loss and take profit levels

**Params:**
- `maPeriod` (default 20): Moving average period
- `stopLossBps` (default 200): Stop loss trigger (2%)
- `takeProfitBps` (default 500): Take profit trigger (5%)
- `trendThresholdBps` (default 100): Min price move to confirm trend

**Use cases:** Trending markets, swing trading demos

---

### 3. LiquidationBot
**Purpose:** Trigger liquidations for demo scenarios

**Strategy:**
- Opens HIGH leverage positions (10-15x)
- Deliberately positions near liquidation threshold
- Gets liquidated during crash/squeeze scenarios
- Tests insurance fund and liquidation system

**Params:**
- `targetLeverage` (default 15): Target leverage multiplier
- `triggerOnCrash` (default true): Only activate during price crashes
- `holdDurationMs` (default 60000): How long to hold risky position

**Use cases:** Crash scenarios, liquidation system demos, stress tests

---

### 4. WhaleBot
**Purpose:** Massive positions to test capital limits

**Strategy:**
- Opens HUGE positions (max size allowed)
- Can manipulate market price via large trades
- Tests insurance fund and system capital limits
- Manual trigger only (activated per scenario)

**Params:**
- `onlyOnTrigger` (default true): Only trade when manually triggered
- `manipulationMode` (default false): Intentionally move market
- `targetPriceMoveBps` (default 1000): Target price impact (10%)

**Use cases:** Whale attack scenarios, stress tests, capital limit testing

---

## Usage

### Basic Setup

```typescript
import { BotManager } from './BotManager';

const manager = new BotManager({
  slabAddress: "YOUR_SLAB_ADDRESS",
  programId: "FxfD37s1AZTeWfFQps9Zpebi2dNQ9QSSDtfMKdbsfKrD",
  rpcUrl: "https://api.devnet.solana.com",
  scenario: BotManager.SCENARIOS.NORMAL,
});

// Initialize bots (creates keypairs, requests airdrops, creates accounts)
await manager.initializeBots();

// Start trading
manager.start();

// Update price (called by oracle/price engine)
manager.updatePrice(50_000_000n); // 50 USDC (e6 format)

// Stop all bots
manager.stop();
```

### Predefined Scenarios

```typescript
// Normal market - market maker + trend follower
BotManager.SCENARIOS.NORMAL

// Volatile market - adds liquidation bot
BotManager.SCENARIOS.VOLATILE

// Market crash - high aggression, all bots active
BotManager.SCENARIOS.CRASH

// Whale attack - market maker + whale bot
BotManager.SCENARIOS.WHALE_ATTACK

// Stress test - all bots, max aggression
BotManager.SCENARIOS.STRESS_TEST
```

### Custom Scenario

```typescript
const customScenario = {
  name: "Custom Demo",
  enabledBots: ["market-maker", "trend-follower"],
  aggressiveness: 0.7, // 0-1 scale
  duration: 300_000,   // 5 minutes
};

const manager = new BotManager({
  slabAddress: "...",
  programId: "...",
  rpcUrl: "...",
  scenario: customScenario,
});
```

### Manual Whale Trigger

```typescript
const whaleBot = manager.bots.find(b => b.type === "whale");
whaleBot.trigger("manipulate"); // Start accumulate → dump cycle
```

## Architecture

```
BotManager
├── Creates and funds bot keypairs (via devnet faucet)
├── Initializes on-chain accounts (InitUser + DepositCollateral)
├── Distributes price updates to all bots
└── Manages bot lifecycle (start/stop)

BaseBot (abstract)
├── Solana integration (createAccount, deposit, trade, closePosition)
├── Position tracking
└── Logging for event feed

MarketMakerBot extends BaseBot
TrendFollowerBot extends BaseBot
LiquidationBot extends BaseBot
WhaleBot extends BaseBot
```

## Bot Lifecycle

1. **Initialization**
   - Generate Solana keypair
   - Request devnet SOL airdrop (2 SOL)
   - Create user account in slab (InitUser)
   - Deposit initial collateral (DepositCollateral)

2. **Trading Loop**
   - Receive price updates from PriceOracle
   - Execute `decide()` strategy logic
   - Send trade transactions (TradeNoCpi)
   - Update local position tracking

3. **Shutdown**
   - Stop trading loop
   - (Optional) Close positions
   - (Optional) Withdraw collateral

## Integration Points

### Price Oracle
```typescript
// PriceEngine calls this when price changes
botManager.updatePrice(newPriceE6);
```

### Event Feed
```typescript
// Get recent bot activity for UI
const logs = botManager.getLogs(100);
```

### Bot State
```typescript
// Get current state of all bots
const states = botManager.getBotStates();
// Returns: [{ name, type, running, positionSize, capital, tradesExecuted, ... }]
```

## Configuration

Each bot can be configured via the `params` object:

```typescript
{
  type: "market-maker",
  name: "MM-Alpha",
  slabAddress: "...",
  programId: "...",
  initialCapital: 500_000_000n, // 0.5 SOL
  maxPositionSize: 1_000_000n,  // 1M units
  tradeIntervalMs: 5000,         // Check every 5s
  params: {
    spreadBps: 50,
    rebalanceThreshold: 0.3,
    profitTargetBps: 100,
  }
}
```

## Error Handling

All bots handle transaction failures gracefully:
- Devnet is flaky → retry with backoff
- Failed trades are logged but don't crash the bot
- Position tracking continues even if tx fails
- Each bot logs all actions for debugging

## Testing

```bash
# Run bot fleet in simulation mode
cd packages/simulation
npm test

# Test individual bot
npm run test:bot -- --bot=market-maker

# Stress test
npm run test:stress
```

## Devnet Faucet Limits

- Max 2 SOL per airdrop
- Rate limited to ~5 airdrops per minute
- BotManager handles airdrop requests sequentially
- Each bot gets 2 SOL (enough for 100+ trades)

## Known Issues

1. **Account index parsing**: Currently uses placeholder logic. Need to parse account index from transaction logs or query slab state after InitUser.

2. **Instruction account list**: Trade instructions need complete account list (LP account, clock, oracle). Currently stubbed.

3. **Devnet instability**: Devnet can be slow/unreliable. Bots include retry logic but may still fail during outages.

## Future Enhancements

- [ ] Parse account index from InitUser transaction
- [ ] Complete account list for trade instructions
- [ ] Adaptive aggression based on market conditions
- [ ] Bot performance metrics and analytics
- [ ] Coordinated multi-bot strategies
- [ ] Machine learning-based decision making
