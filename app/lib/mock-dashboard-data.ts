/**
 * Mock dashboard data for local design testing and devnet mode.
 * Provides PnL history, trade history, watchlist, and funding rate data.
 */

export interface PnlDataPoint {
  timestamp: number; // unix ms
  cumulativePnl: number; // USD
  tradeEvent?: string; // optional label for trade markers
}

export interface TradeRecord {
  id: string;
  timestamp: number;
  market: string;
  side: "long" | "short";
  size: number; // base token amount
  sizeUsd: number;
  entryPrice: number;
  exitPrice: number | null; // null if position still open
  pnl: number;
  fees: number;
  type: "open" | "close" | "liquidation" | "partial-close";
  txHash: string;
}

export interface WatchlistItem {
  market: string;
  symbol: string;
  price: number;
  change24h: number; // percentage
  volume24h: number;
  openInterest: number;
  sparkline: number[]; // 24 data points for mini chart
}

export interface FundingRate {
  market: string;
  symbol: string;
  rate: number; // percentage (e.g., 0.018 = 0.018%)
  nextSettlement: number; // unix ms
  estimatedPayment: number; // USD, positive = you pay, negative = you receive
}

export interface DashboardStats {
  totalPnl: number;
  todayPnl: number;
  winRate: number;
  wins: number;
  losses: number;
  feeTier: { maker: number; taker: number; tier: number; maxTier: number };
}

// Generate PnL history for a given time range
function generatePnlHistory(days: number, points: number): PnlDataPoint[] {
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const step = (now - start) / points;
  const data: PnlDataPoint[] = [];
  let cumPnl = 0;

  for (let i = 0; i <= points; i++) {
    const t = start + step * i;
    // Random walk with slight upward bias
    const delta = (Math.random() - 0.45) * 120;
    cumPnl += delta;
    const tradeEvent = Math.random() < 0.08 ? (delta > 0 ? "Win" : "Loss") : undefined;
    data.push({
      timestamp: Math.round(t),
      cumulativePnl: Math.round(cumPnl * 100) / 100,
      tradeEvent,
    });
  }
  return data;
}

export function getMockPnlHistory(range: "24h" | "7d" | "30d" | "all"): PnlDataPoint[] {
  switch (range) {
    case "24h": return generatePnlHistory(1, 48);
    case "7d": return generatePnlHistory(7, 84);
    case "30d": return generatePnlHistory(30, 120);
    case "all": return generatePnlHistory(180, 180);
  }
}

export function getMockTradeHistory(): TradeRecord[] {
  const markets = ["SOL-PERP", "BTC-PERP", "ETH-PERP", "WIF-PERP", "JUP-PERP"];
  const trades: TradeRecord[] = [];
  const now = Date.now();

  for (let i = 0; i < 50; i++) {
    const market = markets[Math.floor(Math.random() * markets.length)];
    const side = Math.random() > 0.5 ? "long" : "short" as const;
    const basePrice = market === "BTC-PERP" ? 95000 : market === "ETH-PERP" ? 3200 : market === "SOL-PERP" ? 225 : market === "WIF-PERP" ? 0.85 : 0.62;
    const entryPrice = basePrice * (1 + (Math.random() - 0.5) * 0.05);
    const exitPrice = i < 5 ? null : basePrice * (1 + (Math.random() - 0.5) * 0.08);
    const size = market === "BTC-PERP" ? +(Math.random() * 0.5).toFixed(4) : market === "ETH-PERP" ? +(Math.random() * 5).toFixed(3) : +(Math.random() * 50).toFixed(2);
    const sizeUsd = size * entryPrice;
    const pnl = exitPrice ? (side === "long" ? (exitPrice - entryPrice) : (entryPrice - exitPrice)) * size : (Math.random() - 0.45) * sizeUsd * 0.05;
    const fees = sizeUsd * 0.0006;
    const isLiq = exitPrice && Math.random() < 0.05;

    trades.push({
      id: `trade-${i}`,
      timestamp: now - i * 3600_000 * (1 + Math.random() * 3),
      market,
      side,
      size,
      sizeUsd: Math.round(sizeUsd * 100) / 100,
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitPrice: exitPrice ? Math.round(exitPrice * 100) / 100 : null,
      pnl: Math.round(pnl * 100) / 100,
      fees: Math.round(fees * 100) / 100,
      type: i < 5 ? "open" : isLiq ? "liquidation" : Math.random() < 0.1 ? "partial-close" : "close",
      txHash: `${Math.random().toString(36).slice(2, 10)}...${Math.random().toString(36).slice(2, 6)}`,
    });
  }

  return trades.sort((a, b) => b.timestamp - a.timestamp);
}

export function getMockWatchlist(): WatchlistItem[] {
  return [
    {
      market: "SOL-PERP", symbol: "SOL", price: 225.90, change24h: 3.2,
      volume24h: 42_100_000, openInterest: 8_400_000,
      sparkline: Array.from({ length: 24 }, (_, i) => 218 + Math.sin(i / 3) * 8 + Math.random() * 4),
    },
    {
      market: "BTC-PERP", symbol: "BTC", price: 95_420, change24h: -1.1,
      volume24h: 128_000_000, openInterest: 42_000_000,
      sparkline: Array.from({ length: 24 }, (_, i) => 96000 - Math.sin(i / 4) * 800 + Math.random() * 200),
    },
    {
      market: "ETH-PERP", symbol: "ETH", price: 3_241.88, change24h: 2.8,
      volume24h: 68_000_000, openInterest: 18_000_000,
      sparkline: Array.from({ length: 24 }, (_, i) => 3150 + Math.sin(i / 2.5) * 80 + Math.random() * 30),
    },
    {
      market: "WIF-PERP", symbol: "WIF", price: 0.847, change24h: -5.2,
      volume24h: 12_000_000, openInterest: 3_200_000,
      sparkline: Array.from({ length: 24 }, (_, i) => 0.89 - i * 0.002 + Math.random() * 0.01),
    },
    {
      market: "JUP-PERP", symbol: "JUP", price: 0.624, change24h: 1.4,
      volume24h: 8_000_000, openInterest: 2_100_000,
      sparkline: Array.from({ length: 24 }, (_, i) => 0.61 + Math.sin(i / 5) * 0.02 + Math.random() * 0.005),
    },
  ];
}

export function getMockFundingRates(): FundingRate[] {
  const nextSettlement = Date.now() + 2 * 3600_000 + 14 * 60_000; // 2h 14m from now
  return [
    { market: "SOL-PERP", symbol: "SOL", rate: 0.018, nextSettlement, estimatedPayment: 4.20 },
    { market: "BTC-PERP", symbol: "BTC", rate: -0.004, nextSettlement, estimatedPayment: -0.88 },
    { market: "ETH-PERP", symbol: "ETH", rate: 0.012, nextSettlement, estimatedPayment: 2.10 },
    { market: "WIF-PERP", symbol: "WIF", rate: 0.032, nextSettlement, estimatedPayment: 1.44 },
    { market: "JUP-PERP", symbol: "JUP", rate: -0.008, nextSettlement, estimatedPayment: -0.32 },
  ];
}

export function getMockDashboardStats(): DashboardStats {
  return {
    totalPnl: 4830.22,
    todayPnl: 120.88,
    winRate: 68.4,
    wins: 142,
    losses: 66,
    feeTier: { maker: 0.02, taker: 0.06, tier: 2, maxTier: 4 },
  };
}
