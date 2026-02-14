/**
 * Pyth Network Price Feed Integration
 * 
 * Fetches real-time crypto prices from Pyth Hermes API
 * Used as base prices for Pyth-correlated simulation scenarios
 */

const HERMES_BASE_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

/**
 * Pyth feed IDs for major crypto assets
 */
export const PYTH_FEEDS = {
  'SOL/USD': '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
} as const;

export type PythFeedName = keyof typeof PYTH_FEEDS;

interface PythPriceData {
  price: number;
  expo: number;
  conf: number;
  publishTime: number;
}

interface PythPriceCache {
  price: number; // Normalized to decimal (e.g., 100.5 for $100.50)
  timestamp: number;
  feedId: string;
}

interface PythAPIResponse {
  parsed?: Array<{
    id: string;
    price: {
      price: string;
      conf: string;
      expo: number;
      publish_time: number;
    };
  }>;
}

/**
 * Singleton manager for Pyth price feeds
 * Handles polling, caching, and graceful fallback
 */
export class PythPriceManager {
  private static instance: PythPriceManager;
  
  private cache: Map<string, PythPriceCache> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private isPolling = false;
  private pollIntervalMs = 3000; // 3 seconds default
  
  private constructor() {}
  
  static getInstance(): PythPriceManager {
    if (!PythPriceManager.instance) {
      PythPriceManager.instance = new PythPriceManager();
    }
    return PythPriceManager.instance;
  }
  
  /**
   * Start polling Pyth prices for specified feeds
   * @param feedNames Array of feed names to poll (e.g., ['SOL/USD', 'BTC/USD'])
   * @param intervalMs Polling interval in milliseconds (default 3000)
   */
  startPolling(feedNames: PythFeedName[], intervalMs = 3000): void {
    if (this.isPolling) {
      console.log('Pyth polling already active');
      return;
    }
    
    this.pollIntervalMs = intervalMs;
    this.isPolling = true;
    
    console.log(`Starting Pyth polling for: ${feedNames.join(', ')} (every ${intervalMs}ms)`);
    
    // Initial fetch
    this.fetchPrices(feedNames).catch(console.error);
    
    // Set up interval
    this.pollingInterval = setInterval(() => {
      this.fetchPrices(feedNames).catch(console.error);
    }, intervalMs);
  }
  
  /**
   * Stop polling Pyth prices
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isPolling = false;
    console.log('Pyth polling stopped');
  }
  
  /**
   * Fetch latest prices from Pyth Hermes API
   */
  private async fetchPrices(feedNames: PythFeedName[]): Promise<void> {
    const feedIds = feedNames.map(name => PYTH_FEEDS[name]);
    
    // Build URL with multiple feed IDs
    const params = new URLSearchParams();
    feedIds.forEach(id => params.append('ids[]', id));
    
    const url = `${HERMES_BASE_URL}?${params.toString()}`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });
      
      if (!response.ok) {
        console.error(`Pyth API error: ${response.status} ${response.statusText}`);
        return;
      }
      
      const data: PythAPIResponse = await response.json();
      
      if (!data.parsed || data.parsed.length === 0) {
        console.error('Pyth API returned no price data');
        return;
      }
      
      // Process each price update
      for (const item of data.parsed) {
        const price = parseFloat(item.price.price);
        const expo = item.price.expo;
        const normalizedPrice = price * Math.pow(10, expo);
        
        this.cache.set(item.id, {
          price: normalizedPrice,
          timestamp: item.price.publish_time * 1000, // Convert to ms
          feedId: item.id,
        });
        
        // Log successful update
        const feedName = Object.entries(PYTH_FEEDS).find(([_, id]) => id === item.id)?.[0];
        console.log(`Pyth price updated: ${feedName} = $${normalizedPrice.toFixed(2)}`);
      }
      
    } catch (error) {
      console.error('Failed to fetch Pyth prices:', error);
      // Cache remains valid, will use last known prices
    }
  }
  
  /**
   * Get the latest price for a feed
   * @param feedName Feed name (e.g., 'SOL/USD')
   * @returns Price in USD, or null if not available
   */
  getLatestPrice(feedName: PythFeedName): number | null {
    const feedId = PYTH_FEEDS[feedName];
    const cached = this.cache.get(feedId);
    
    if (!cached) {
      console.warn(`No cached price for ${feedName}`);
      return null;
    }
    
    // Check if price is stale (> 30 seconds old)
    const age = Date.now() - cached.timestamp;
    if (age > 30000) {
      console.warn(`Pyth price for ${feedName} is stale (${(age / 1000).toFixed(0)}s old)`);
    }
    
    return cached.price;
  }
  
  /**
   * Get price by feed ID (for direct access)
   */
  getLatestPriceById(feedId: string): number | null {
    const cached = this.cache.get(feedId);
    return cached ? cached.price : null;
  }
  
  /**
   * Get all cached prices
   */
  getAllPrices(): Map<string, PythPriceCache> {
    return new Map(this.cache);
  }
  
  /**
   * Check if a feed is available
   */
  hasFeed(feedName: PythFeedName): boolean {
    const feedId = PYTH_FEEDS[feedName];
    return this.cache.has(feedId);
  }
  
  /**
   * Manually fetch a single price (one-time, not polling)
   * Useful for initial setup or ad-hoc queries
   */
  async fetchSinglePrice(feedName: PythFeedName): Promise<number | null> {
    const feedId = PYTH_FEEDS[feedName];
    const url = `${HERMES_BASE_URL}?ids[]=${feedId}`;
    
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        console.error(`Pyth API error for ${feedName}: ${response.status}`);
        return null;
      }
      
      const data: PythAPIResponse = await response.json();
      
      if (!data.parsed || data.parsed.length === 0) {
        return null;
      }
      
      const item = data.parsed[0];
      const price = parseFloat(item.price.price);
      const expo = item.price.expo;
      const normalizedPrice = price * Math.pow(10, expo);
      
      // Update cache
      this.cache.set(feedId, {
        price: normalizedPrice,
        timestamp: item.price.publish_time * 1000,
        feedId,
      });
      
      return normalizedPrice;
      
    } catch (error) {
      console.error(`Failed to fetch ${feedName} price:`, error);
      return null;
    }
  }
  
  /**
   * Clear all cached prices
   */
  clearCache(): void {
    this.cache.clear();
  }
  
  /**
   * Get status of the price manager
   */
  getStatus(): {
    isPolling: boolean;
    pollIntervalMs: number;
    cachedFeeds: number;
    feeds: Array<{ name: string; price: number; age: number }>;
  } {
    const feeds: Array<{ name: string; price: number; age: number }> = [];
    
    for (const [name, feedId] of Object.entries(PYTH_FEEDS)) {
      const cached = this.cache.get(feedId);
      if (cached) {
        feeds.push({
          name,
          price: cached.price,
          age: Date.now() - cached.timestamp,
        });
      }
    }
    
    return {
      isPolling: this.isPolling,
      pollIntervalMs: this.pollIntervalMs,
      cachedFeeds: this.cache.size,
      feeds,
    };
  }
}

/**
 * Convenience function to get the global Pyth price manager
 */
export function getPythPriceManager(): PythPriceManager {
  return PythPriceManager.getInstance();
}
