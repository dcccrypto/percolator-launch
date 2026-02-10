# Security Notes

## Known Issues

### R2-S1: Helius API Key Exposed in Client Bundle (CRITICAL — pre-mainnet)

`NEXT_PUBLIC_HELIUS_API_KEY` is included in the client-side JavaScript bundle due to the `NEXT_PUBLIC_` prefix. This is by-design for development but **must be fixed before mainnet**.

**Recommended fix:** Create a server-side RPC proxy at `app/app/api/rpc/route.ts` that:
1. Accepts JSON-RPC requests from the client
2. Forwards them to Helius with the API key injected server-side (using a non-public env var)
3. Client code uses `/api/rpc` as the RPC endpoint instead of the direct Helius URL

This prevents the API key from appearing in the browser and allows rate-limiting/filtering at the proxy layer.
