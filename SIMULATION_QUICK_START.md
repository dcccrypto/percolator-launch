# Simulation Mode Quick Start

## What Was Built

Complete backend API for Percolator Simulation Mode:
- ✅ 5 price models (random walk, mean revert, trending, crash, squeeze)
- ✅ 6 scenario presets (calm, bull, crash, squeeze, whale, blackswan)
- ✅ Solana PushOraclePrice integration
- ✅ 5 API routes (status, start, stop, price, scenario)
- ✅ Database schema for tracking sessions and price history
- ✅ TypeScript throughout with proper types

## Files Created (9 total)

```
app/lib/simulation/
  ├── solana.ts              # Solana PushOraclePrice integration
  ├── SimulationManager.ts   # Core state manager with price models
  └── scenarios.ts           # 6 predefined scenarios

app/app/api/simulation/
  ├── route.ts               # GET status
  ├── start/route.ts         # POST start
  ├── stop/route.ts          # POST stop
  ├── price/route.ts         # POST manual price
  └── scenario/route.ts      # POST/GET scenarios

supabase/migrations/
  └── 011_simulation_mode.sql  # DB schema
```

## Setup (Before First Use)

1. **Generate or get oracle keypair**:
   ```bash
   solana-keygen new --outfile oracle-keypair.json
   # Save the pubkey - this must be set as oracle_authority on your slab
   ```

2. **Add to .env.local**:
   ```bash
   SIMULATION_ORACLE_KEYPAIR='[1,2,3,...,64]'  # Paste the JSON array from oracle-keypair.json
   ```

3. **Deploy migration** (when approved):
   ```bash
   # Via Supabase dashboard or CLI
   supabase db push
   ```

## API Examples

### 1. Check Status
```bash
curl http://localhost:3000/api/simulation
```

### 2. Start Bull Scenario
```bash
curl -X POST http://localhost:3000/api/simulation/start \
  -H "Content-Type: application/json" \
  -d '{
    "slabAddress": "YOUR_SLAB_ADDRESS",
    "scenario": "bull",
    "startPriceE6": 100000000
  }'
```

### 3. Switch to Crash
```bash
curl -X POST http://localhost:3000/api/simulation/scenario \
  -H "Content-Type: application/json" \
  -d '{"scenario": "crash"}'
```

### 4. Manual Price Override
```bash
curl -X POST http://localhost:3000/api/simulation/price \
  -H "Content-Type: application/json" \
  -d '{
    "slabAddress": "YOUR_SLAB_ADDRESS",
    "priceE6": 95000000
  }'
```

### 5. Stop Simulation
```bash
curl -X POST http://localhost:3000/api/simulation/stop
```

## Scenarios

| Name | Model | Description | Duration |
|------|-------|-------------|----------|
| calm | mean-revert | Low vol, stable | 5 min |
| bull | trending | Upward drift | 5 min |
| crash | crash | 40% decline | 2 min |
| squeeze | squeeze | 50% spike → decay | 3 min |
| whale | random-walk | High volatility | 5 min |
| blackswan | crash | 70% crash | 1 min |

## Price Models

1. **random-walk**: `price × (1 + volatility × N(0,1))`
2. **mean-revert**: `price + revertSpeed × (mean - price) + noise`
3. **trending**: Random walk with positive drift
4. **crash**: Exponential decay over duration
5. **squeeze**: Exponential rise to 50%, then decay

## Error Handling

All routes return helpful errors:

```json
{
  "error": "Simulation oracle not configured",
  "details": "Set SIMULATION_ORACLE_KEYPAIR environment variable with base58-encoded keypair",
  "help": "This keypair must match the oracle_authority field in the slab account"
}
```

## Database Tables

- `simulation_sessions`: Tracks each run (status, prices, duration)
- `simulation_price_history`: Every price update (for charts/analysis)

## Important Notes

1. **Keypair format**: Use JSON array `[1,2,3,...,64]` from solana-keygen
2. **Oracle authority**: Keypair pubkey MUST match slab's oracle_authority
3. **Auto-stop**: Scenarios auto-stop after duration (prevents runaway)
4. **State**: In-memory (lost on restart), but DB tracks history
5. **Interval**: Default 5s between price updates (configurable)

## Testing Checklist

- [ ] Set SIMULATION_ORACLE_KEYPAIR env var
- [ ] Deploy migration
- [ ] Create test slab with oracle_authority = keypair pubkey
- [ ] Start simulation with bull scenario
- [ ] Verify price updates in Solana explorer
- [ ] Check DB records in simulation_sessions table
- [ ] Test scenario switching
- [ ] Test manual price override
- [ ] Verify auto-stop after scenario duration

## Next Steps for Frontend

- [ ] Add Simulation Mode UI panel to dashboard
- [ ] Real-time price chart (from simulation_price_history)
- [ ] Scenario selector dropdown
- [ ] Start/stop controls
- [ ] Live metrics (liquidations, funding rates, etc.)
- [ ] WebSocket for real-time updates
