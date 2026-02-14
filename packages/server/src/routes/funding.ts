/**
 * Funding Rate API Routes (Express)
 * 
 * GET /api/funding/:slab
 * - Returns current funding rate data and 24h history
 * 
 * GET /api/funding/:slab/history
 * - Returns historical funding rate data with optional time range
 * 
 * GET /api/funding/global
 * - Returns current funding rates for all markets
 */
import { Router, Request, Response } from 'express';
import { getSupabase } from '../db/client.js';

const router = Router();

/**
 * GET /api/funding/:slab
 * 
 * Returns current funding rate data and 24h history for a market.
 */
router.get('/:slab', async (req: Request, res: Response) => {
  try {
    const { slab } = req.params;

    if (!slab) {
      res.status(400).json({ error: 'Missing slab parameter' });
      return;
    }

    // Fetch current funding rate from market_stats
    const { data: statsData, error: statsError } = await getSupabase()
      .from('market_stats')
      .select('funding_rate_bps_per_slot, funding_index_qpb_e6, net_lp_position, last_funding_slot')
      .eq('slab_address', slab)
      .single();
    
    if (statsError && statsError.code !== 'PGRST116') {
      throw statsError;
    }
    
    if (!statsData) {
      res.status(404).json({
        error: 'Market stats not found',
        hint: 'Market may not have been cranked yet or does not exist'
      });
      return;
    }

    const currentRateBpsPerSlot = Number(statsData.funding_rate_bps_per_slot ?? 0);
    const fundingIndexQpbE6 = statsData.funding_index_qpb_e6 ?? '0';
    const netLpPosition = statsData.net_lp_position ?? '0';
    const lastUpdatedSlot = Number(statsData.last_funding_slot ?? 0);

    // Calculate rates
    // Solana slots: ~2.5 slots/second = 400ms per slot
    // Hourly: 3600s / 0.4s = 9000 slots
    // Daily: 24 * 9000 = 216,000 slots
    // Annual: 365 * 216,000 = 78,840,000 slots
    const SLOTS_PER_HOUR = 9000;
    const SLOTS_PER_DAY = 216000;
    const SLOTS_PER_YEAR = 78840000;

    const hourlyRatePercent = (currentRateBpsPerSlot / 10000.0) * SLOTS_PER_HOUR;
    const dailyRatePercent = (currentRateBpsPerSlot / 10000.0) * SLOTS_PER_DAY;
    const annualizedPercent = (currentRateBpsPerSlot / 10000.0) * SLOTS_PER_YEAR;

    // Fetch 24h funding history
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: history } = await getSupabase()
      .from('funding_history')
      .select('timestamp, slot, rate_bps_per_slot, net_lp_pos, price_e6, funding_index_qpb_e6')
      .eq('market_slab', slab)
      .gte('timestamp', since24h)
      .order('timestamp', { ascending: false });

    // Format history for response
    const last24hHistory = (history || []).map((h) => ({
      timestamp: h.timestamp,
      slot: Number(h.slot),
      rateBpsPerSlot: Number(h.rate_bps_per_slot),
      netLpPos: h.net_lp_pos,
      priceE6: Number(h.price_e6),
      fundingIndexQpbE6: h.funding_index_qpb_e6,
    }));

    res.json({
      slabAddress: slab,
      currentRateBpsPerSlot,
      hourlyRatePercent: Number(hourlyRatePercent.toFixed(6)),
      dailyRatePercent: Number(dailyRatePercent.toFixed(4)),
      annualizedPercent: Number(annualizedPercent.toFixed(2)),
      netLpPosition,
      fundingIndexQpbE6,
      lastUpdatedSlot,
      last24hHistory,
      metadata: {
        dataPoints24h: last24hHistory.length,
        explanation: {
          rateBpsPerSlot: 'Funding rate in basis points per slot (1 bps = 0.01%)',
          hourly: 'Rate * 9,000 slots/hour (assumes 400ms slots)',
          daily: 'Rate * 216,000 slots/day',
          annualized: 'Rate * 78,840,000 slots/year',
          sign: 'Positive = longs pay shorts | Negative = shorts pay longs',
          inventory: 'Driven by net LP position (LP inventory imbalance)',
        }
      }
    });

  } catch (error) {
    console.error('[Funding API] Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/funding/:slab/history
 * 
 * Returns historical funding rate data with optional time range.
 * Query params:
 * - limit: number of records (default 100, max 1000)
 * - since: ISO timestamp (default: 24h ago)
 */
router.get('/:slab/history', async (req: Request, res: Response) => {
  try {
    const { slab } = req.params;
    const limitParam = req.query.limit as string | undefined;
    const sinceParam = req.query.since as string | undefined;

    if (!slab) {
      res.status(400).json({ error: 'Missing slab parameter' });
      return;
    }

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 1000) : 100;
    const since = sinceParam || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: history } = await getSupabase()
      .from('funding_history')
      .select('timestamp, slot, rate_bps_per_slot, net_lp_pos, price_e6, funding_index_qpb_e6')
      .eq('market_slab', slab)
      .gte('timestamp', since)
      .order('timestamp', { ascending: false })
      .limit(limit);

    res.json({
      slabAddress: slab,
      count: (history || []).length,
      history: (history || []).map((h) => ({
        timestamp: h.timestamp,
        slot: Number(h.slot),
        rateBpsPerSlot: Number(h.rate_bps_per_slot),
        netLpPos: h.net_lp_pos,
        priceE6: Number(h.price_e6),
        fundingIndexQpbE6: h.funding_index_qpb_e6,
      })),
    });

  } catch (error) {
    console.error('[Funding API] Error fetching history:', error);
    res.status(500).json({
      error: 'Failed to fetch funding history',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * GET /api/funding/global
 * 
 * Returns current funding rates for all markets.
 */
router.get('/global', async (_req: Request, res: Response) => {
  try {
    const { data: allStats } = await getSupabase()
      .from('market_stats')
      .select('slab_address, funding_rate_bps_per_slot, net_lp_position, last_funding_slot');

    const SLOTS_PER_HOUR = 9000;
    const SLOTS_PER_DAY = 216000;

    const markets = (allStats || []).map((stats) => {
      const rateBps = Number(stats.funding_rate_bps_per_slot ?? 0);
      return {
        slabAddress: stats.slab_address,
        currentRateBpsPerSlot: rateBps,
        hourlyRatePercent: Number(((rateBps / 10000.0) * SLOTS_PER_HOUR).toFixed(6)),
        dailyRatePercent: Number(((rateBps / 10000.0) * SLOTS_PER_DAY).toFixed(4)),
        netLpPosition: stats.net_lp_position ?? '0',
        lastUpdatedSlot: Number(stats.last_funding_slot ?? 0),
      };
    });

    res.json({
      count: markets.length,
      markets,
    });

  } catch (error) {
    console.error('[Funding API] Error fetching global data:', error);
    res.status(500).json({
      error: 'Failed to fetch global funding data',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
