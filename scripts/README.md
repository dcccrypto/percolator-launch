# Scripts

Operational scripts for Percolator Launch — market management, keeper ops, E2E testing, and oracle tooling.

## Categories

### Market Operations
| Script | Purpose |
|--------|---------|
| `market-bootstrap.ts` | Bootstrap market metadata to Supabase |
| `new-sol-market.ts` | Create SOL-specific market with defaults |
| `discover-markets.ts` | Discover on-chain markets and sync to DB |
| `devnet-reinit-market.ts` | Reinitialize devnet markets (dev only) |
| `seed-ohlcv.ts` | Seed OHLCV candlestick data |

### Keeper & Crank
| Script | Purpose |
|--------|---------|
| `keeper-bot.ts` | Run the keeper/crank bot |
| `crank-generic.ts` | Generic crank execution |
| `fund-keeper.ts` | Fund keeper wallet with SOL |
| `generate-keeper-wallets.ts` | Generate new keeper keypairs |
| `setup-keeper-accounts.ts` | Initialize keeper accounts on-chain |

### Oracle
| Script | Purpose |
|--------|---------|
| `oracle-bridge.ts` | Bridge oracle prices (Pyth → on-chain) |
| `oracle-keeper.ts` | Keep oracle prices fresh |
| `oracle-pusher.ts` | Push oracle price updates |
| `check-oracle-authority.ts` | Verify oracle authority config |
| `set-oracle-authority-batch.ts` | Batch update oracle authorities |

### Market Making
| Script | Purpose |
|--------|---------|
| `mm-profiles.ts` | MM configuration profiles |
| `deploy-devnet-mm.ts` | Deploy devnet market makers |
| `fund-mm-bots.ts` | Fund MM bot wallets |

### E2E Testing
| Script | Purpose |
|--------|---------|
| `e2e-open-close-position.ts` | **Phase 1 E2E**: open + close position flow |
| `e2e-devnet-test.ts` | Full devnet E2E test suite |
| `e2e-perc328-small.ts` | Small-slab E2E variant |

### Admin / Utility
| Script | Purpose |
|--------|---------|
| `airdrop-admin.ts` | Airdrop SOL to admin wallet |
| `check-admin.ts` | Verify admin keypair/authority |
| `check-wallets.ts` | Check wallet balances |
| `transfer-usdc-mint-authority.ts` | Transfer USDC mint authority |

## Archived Scripts

One-off diagnostic scripts from devnet debugging are in `scripts/archive/`. These were used during development and are preserved for reference but not part of active operations.

## Running

```bash
# All scripts use tsx
pnpm tsx scripts/<script>.ts [args]
```
