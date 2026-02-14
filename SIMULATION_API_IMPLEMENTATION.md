# Simulation API Implementation Complete

## Summary

Successfully implemented the complete Simulation Mode API layer for Percolator, including:
- Solana integration for PushOraclePrice instructions
- Simulation state manager with 5 price models
- 6 predefined market scenarios
- 5 Next.js API routes
- Database schema for session and price tracking

## Files Created

### 1. Core Library Files

#### `app/lib/simulation/solana.ts`
- Encodes and sends `PushOraclePrice` instructions to Solana
- Loads oracle authority keypair from env var `SIMULATION_ORACLE_KEYPAIR`
- Supports JSON array format: `[1,2,3,...,64]`
- Key function: `pushOraclePrice(connection, keypair, slabAddress, priceE6)`

#### `app/lib/simulation/SimulationManager.ts`
- Singleton pattern for managing simulation state
- Implements 5 price models:
  - **Random Walk**: `price * (1 + volatility * gaussianRandom())`
  - **Mean Revert**: `price + revertSpeed * (meanPrice - price) + noise`
  - **Trending**: Random walk with positive drift
  - **Crash**: Exponential decay to target
  - **Squeeze**: Exponential rise then decay
- Box-Muller transform for Gaussian random numbers
- Automatic price updates at configurable intervals (default 5s)
- Database integration for session and price history tracking

#### `app/lib/simulation/scenarios.ts`
- 6 predefined scenarios:
  - **calm**: Mean revert, low volatility (5 min)
  - **bull**: Trending upward (5 min)
  - **crash**: Rapid 40% decline (2 min)
  - **squeeze**: 50% spike then decay (3 min)
  - **whale**: High volatility random walk (5 min)
  - **blackswan**: Extreme 70% crash (1 min)
- Each scenario auto-stops after duration

### 2. API Routes

All routes in `app/app/api/simulation/`:

#### `GET /api/simulation`
Returns current simulation status:
```json
{
  "running": true,
  "slabAddress": "...",
  "price": 102500000,
  "priceUSDC": 102.5,
  "model": "random-walk",
  "scenario": "bull",
  "params": { "volatility": 0.005 },
  "uptime": 45000,
  "updatesCount": 9,
  "sessionId": 123
}
```

#### `POST /api/simulation/start`
Start a new simulation:
```json
{
  "slabAddress": "ABC123...",
  "startPriceE6": 100000000,
  "scenario": "bull",
  "intervalMs": 5000
}
```

Returns helpful error if `SIMULATION_ORACLE_KEYPAIR` not set.

#### `POST /api/simulation/stop`
Stop the running simulation. Records final state to database.

#### `POST /api/simulation/price`
Manually set oracle price (works independently of simulation):
```json
{
  "slabAddress": "ABC123...",
  "priceE6": 105000000
}
```

Returns transaction signature and explorer link.

#### `POST /api/simulation/scenario`
Switch to different scenario while running:
```json
{
  "scenario": "crash"
}
```

#### `GET /api/simulation/scenario`
List all available scenarios with descriptions.

### 3. Database Migration

`supabase/migrations/011_simulation_mode.sql`

#### Tables:
- **simulation_sessions**: Tracks each simulation run
  - Fields: slab_address, scenario, model, status, prices, timestamps, config
  - Status: running | paused | completed
  
- **simulation_price_history**: Records every price update
  - Fields: session_id, slab_address, price_e6, model, timestamp
  - Cascades on session deletion

#### Indexes:
- Session queries by slab and status
- Price history by session and slab
- All optimized for time-series queries (DESC timestamp)

## Environment Setup Required

Add to `.env.local`:

```bash
# Simulation oracle keypair (JSON array format from solana-keygen)
SIMULATION_ORACLE_KEYPAIR=[1,2,3,...,64]
```

**Important**: This keypair's public key must match the `oracle_authority` field in the slab account you want to simulate.

## Usage Flow

1. **Deploy migration** (when ready):
   ```bash
   # Apply via Supabase CLI or dashboard
   psql -f supabase/migrations/011_simulation_mode.sql
   ```

2. **Set environment variable**:
   ```bash
   export SIMULATION_ORACLE_KEYPAIR='[...]'
   ```

3. **Start simulation**:
   ```bash
   curl -X POST http://localhost:3000/api/simulation/start \
     -H "Content-Type: application/json" \
     -d '{
       "slabAddress": "YOUR_SLAB_ADDRESS",
       "scenario": "bull",
       "startPriceE6": 100000000
     }'
   ```

4. **Monitor status**:
   ```bash
   curl http://localhost:3000/api/simulation
   ```

5. **Switch scenario** (optional):
   ```bash
   curl -X POST http://localhost:3000/api/simulation/scenario \
     -H "Content-Type: application/json" \
     -d '{"scenario": "crash"}'
   ```

6. **Stop simulation**:
   ```bash
   curl -X POST http://localhost:3000/api/simulation/stop
   ```

## Key Design Decisions

1. **In-memory state**: SimulationManager uses singleton pattern for simplicity. State is lost on server restart, but sessions are tracked in DB.

2. **JSON keypair format**: Avoids adding `bs58` dependency. Standard Solana CLI format works directly.

3. **Graceful errors**: All routes return helpful errors when oracle keypair is missing.

4. **Independent price endpoint**: `/api/simulation/price` can be used for manual testing without starting a full simulation.

5. **Scenario auto-stop**: Each scenario has a duration and stops automatically to prevent runaway simulations.

6. **TypeScript types**: Proper types for all configs, requests, and state objects.

## Testing Checklist

- [ ] Verify `SIMULATION_ORACLE_KEYPAIR` env var loading
- [ ] Test each scenario (calm, bull, crash, squeeze, whale, blackswan)
- [ ] Verify PushOraclePrice transactions appear on Solana explorer
- [ ] Check database records in simulation_sessions and simulation_price_history
- [ ] Test manual price override during simulation
- [ ] Test scenario switching mid-simulation
- [ ] Verify simulation auto-stops after scenario duration
- [ ] Test error handling when oracle keypair is wrong/missing
- [ ] Monitor memory usage during long simulations

## Notes

- **DO NOT deploy migration yet** - waiting for approval
- **DO NOT commit/push** - pending review
- All routes use `export const dynamic = 'force-dynamic'` to prevent caching
- Price models use genuine statistical methods (Box-Muller, exponential decay)
- Database integration is optional - simulation works without it, just won't persist history

## Next Steps

1. Review implementation
2. Test locally with devnet slab
3. Deploy migration when approved
4. Add frontend UI components for simulation control
5. Consider adding:
   - WebSocket for real-time price updates
   - Chart visualization of price history
   - Bot integration for automated trading during simulation
   - Metrics dashboard (liquidations triggered, funding rates, etc.)
