import { http, HttpResponse } from 'msw';

/**
 * MSW Request Handlers
 * 
 * Mocks external API calls to:
 * - DexScreener (token prices)
 * - Jupiter (swap quotes)
 * 
 * Real Solana RPC calls are NOT mocked (we test against devnet)
 */

// Mock DexScreener API responses
const dexScreenerHandlers = [
  // Get token price
  http.get('https://api.dexscreener.com/latest/dex/tokens/:address', ({ params }) => {
    const { address } = params;
    
    // Return mock price data
    return HttpResponse.json({
      pairs: [
        {
          chainId: 'solana',
          dexId: 'raydium',
          url: `https://dexscreener.com/solana/${address}`,
          pairAddress: 'mock-pair-address',
          baseToken: {
            address: address as string,
            name: 'Mock Token',
            symbol: 'MOCK',
          },
          quoteToken: {
            address: 'So11111111111111111111111111111111111111112',
            name: 'Wrapped SOL',
            symbol: 'SOL',
          },
          priceNative: '0.001234',
          priceUsd: '0.123456',
          volume: {
            h24: 1234567.89,
          },
          liquidity: {
            usd: 987654.32,
          },
          priceChange: {
            h24: 5.67,
          },
        },
      ],
    });
  }),
  
  // Search tokens
  http.get('https://api.dexscreener.com/latest/dex/search', ({ request }) => {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    
    return HttpResponse.json({
      pairs: [
        {
          chainId: 'solana',
          pairAddress: 'mock-search-result',
          baseToken: {
            symbol: query?.toUpperCase() || 'TOKEN',
            name: `Mock ${query || 'Token'}`,
          },
          priceUsd: '1.234',
        },
      ],
    });
  }),
];

// Mock Jupiter API responses
const jupiterHandlers = [
  // Get quote for swap
  http.get('https://quote-api.jup.ag/v6/quote', ({ request }) => {
    const url = new URL(request.url);
    const inputMint = url.searchParams.get('inputMint');
    const outputMint = url.searchParams.get('outputMint');
    const amount = url.searchParams.get('amount');
    
    return HttpResponse.json({
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount: String(Number(amount) * 1.01), // Mock 1% gain
      otherAmountThreshold: String(Number(amount) * 0.99), // 1% slippage
      swapMode: 'ExactIn',
      priceImpactPct: '0.1',
      routePlan: [
        {
          swapInfo: {
            ammKey: 'mock-amm-key',
            label: 'Raydium',
            inputMint,
            outputMint,
            inAmount: amount,
            outAmount: String(Number(amount) * 1.01),
            feeAmount: '5000',
            feeMint: inputMint,
          },
        },
      ],
    });
  }),
  
  // Get token list
  http.get('https://token.jup.ag/all', () => {
    return HttpResponse.json([
      {
        address: 'So11111111111111111111111111111111111111112',
        chainId: 101,
        decimals: 9,
        name: 'Wrapped SOL',
        symbol: 'SOL',
        logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
      },
      {
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        chainId: 101,
        decimals: 6,
        name: 'USD Coin',
        symbol: 'USDC',
        logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
      },
    ]);
  }),
];

// Error simulation handlers (for testing error handling)
export const errorHandlers = [
  // DexScreener API timeout
  http.get('https://api.dexscreener.com/latest/dex/tokens/:address', async () => {
    await new Promise((resolve) => setTimeout(resolve, 15000)); // Timeout after 15s
    return HttpResponse.json({ error: 'Timeout' }, { status: 504 });
  }),
  
  // Jupiter API error
  http.get('https://quote-api.jup.ag/v6/quote', () => {
    return HttpResponse.json(
      { error: 'No route found' },
      { status: 400 }
    );
  }),
];

// Export all handlers
export const handlers = [
  ...dexScreenerHandlers,
  ...jupiterHandlers,
];
