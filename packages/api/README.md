# @percolator/api

REST API and WebSocket server for the Percolator platform. Read-only, stateless — no keypair, no writes to chain.

**Framework:** Hono | **Port:** 3001 | **Deployed on:** Railway

## Quick Start

```bash
# Install deps (from repo root)
pnpm install

# Development
pnpm --filter=@percolator/api dev

# Production build
pnpm --filter=@percolator/api build
pnpm --filter=@percolator/api start
```

API available at `http://localhost:3001`. Interactive docs at `http://localhost:3001/docs`.

## Environment Variables

Copy `.env.example` from the repo root. All shared config (`RPC_URL`, `SUPABASE_URL`, etc.) comes from `@percolator/shared`.

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3001` | Listen port |
| `NODE_ENV` | `development` | Set to `production` on Railway |
| `RPC_URL` | Helius devnet | Solana RPC endpoint |
| `HELIUS_API_KEY` | — | Helius API key |
| `SUPABASE_URL` | — | Supabase project URL |
| `SUPABASE_KEY` | — | Supabase service role key |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins (**required in production**) |
| `API_AUTH_KEY` | — | API key for protected write endpoints |
| `WS_AUTH_SECRET` | — | HMAC secret for WebSocket token auth |
| `WS_AUTH_REQUIRED` | `false` | Enable WebSocket auth |
| `MAX_WS_CONNECTIONS` | `1000` | Global WebSocket connection limit |
| `ALL_PROGRAM_IDS` | devnet 3 tiers | Comma-separated program IDs to monitor |

## API Endpoints

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health, DB/RPC connectivity |

### Markets

| Method | Path | Cache | Description |
|--------|------|-------|-------------|
| GET | `/markets` | 30s | All markets with stats |
| GET | `/markets/stats` | 30s | Stats for all markets |
| GET | `/markets/:slab` | 10s | On-chain market details |
| GET | `/markets/:slab/stats` | 10s | Stats for a specific market |
| GET | `/markets/:slab/prices` | — | Price history for charting (default 24h) |
| GET | `/markets/:slab/trades` | — | Recent trades (max 200) |
| GET | `/markets/:slab/volume` | — | 24h volume and trade count |

### Prices

| Method | Path | Cache | Description |
|--------|------|-------|-------------|
| GET | `/prices/markets` | 30s | Current prices for all markets |
| GET | `/prices/:slab` | — | Price history (last 100 updates) |

### Trades

| Method | Path | Description |
|--------|------|-------------|
| GET | `/trades/recent` | Recent trades across all markets |

### Funding

| Method | Path | Cache | Description |
|--------|------|-------|-------------|
| GET | `/funding/global` | 60s | Current funding rates for all markets |
| GET | `/funding/:slab` | 30s | Current rate + 24h history |
| GET | `/funding/:slab/history` | 30s | Historical funding data (configurable range) |

### Open Interest

| Method | Path | Cache | Description |
|--------|------|-------|-------------|
| GET | `/open-interest/:slab` | 15s | Current OI + history |

### Insurance

| Method | Path | Description |
|--------|------|-------------|
| GET | `/insurance/:slab` | Insurance fund balance + history |

### Oracle

| Method | Path | Cache | Description |
|--------|------|-------|-------------|
| GET | `/oracle/resolve/:mint` | 5 min | Resolve best price source for a token mint |

### Crank

| Method | Path | Description |
|--------|------|-------------|
| GET | `/crank/status` | Last crank slot for all markets |

### Stats

| Method | Path | Cache | Description |
|--------|------|-------|-------------|
| GET | `/stats` | 60s | Platform-wide aggregated statistics |

### WebSocket

Connect to `/ws`. Subscribe/unsubscribe by slab address:

```json
// Subscribe
{ "type": "subscribe", "slab": "SLAB_ADDRESS" }

// Unsubscribe
{ "type": "unsubscribe", "slab": "SLAB_ADDRESS" }

// Price update (server → client)
{ "type": "price", "slab": "SLAB_ADDRESS", "priceE6": 1500000, "timestamp": 1234567890 }
```

Limits: 500 global connections, 5 per IP, 50 market subscriptions per client.

Optional auth: `?token=slabAddress:timestamp:hmac-sha256` (enable with `WS_AUTH_REQUIRED=true`).

### Error Responses

```json
{ "error": "Not found", "details": "Market does not exist" }
```

HTTP status codes: `200` success, `400` bad request, `404` not found, `429` rate limited, `500` internal error, `503` service unavailable.

## Middleware

Applied globally (in order):

1. **CORS** — allowlist via `CORS_ORIGINS`. Rejects unknown origins in production.
2. **Compression** — gzip/brotli for JSON responses.
3. **Security headers** — X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, HSTS.
4. **Rate limiting** — per-IP token bucket. Separate limits for read (GET) and write (POST/DELETE) endpoints.
5. **Cache** — in-memory TTL cache, per-route TTLs (see table above).

Rate limit response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

## Project Structure

```
packages/api/src/
├── index.ts              # Server entry — CORS, middleware, route registration, graceful shutdown
├── routes/
│   ├── health.ts
│   ├── markets.ts
│   ├── trades.ts
│   ├── prices.ts
│   ├── funding.ts
│   ├── open-interest.ts
│   ├── insurance.ts
│   ├── crank.ts
│   ├── oracle-router.ts
│   ├── stats.ts
│   ├── ws.ts             # WebSocket handler
│   └── docs.ts           # Swagger UI
└── middleware/
    ├── rate-limit.ts
    ├── cache.ts
    └── validateSlab.ts   # Slab address validation middleware
```

## Testing

```bash
pnpm --filter=@percolator/api test
pnpm --filter=@percolator/api test:coverage
```

## Deployment

```bash
# Docker
docker build -f Dockerfile.api -t percolator-api .
docker run -p 3001:3001 --env-file .env percolator-api
```

### Production Checklist

- [ ] `NODE_ENV=production`
- [ ] `CORS_ORIGINS` set to production domains
- [ ] `API_AUTH_KEY` set for write endpoint protection
- [ ] Helius API key configured
- [ ] Supabase credentials set
- [ ] `WS_AUTH_REQUIRED=true` if streaming sensitive data
- [ ] Railway health check pointed at `/health`
