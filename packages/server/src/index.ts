/**
 * Percolator Launch - Backend Server
 * 
 * Exposes hidden on-chain features via REST API
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initStatsCollector } from './services/StatsCollector.js';
import warmupRouter, { initWarmupRouter } from './routes/warmup.js';
import insuranceRouter from './routes/insurance.js';
import oiRouter from './routes/oi.js';
import fundingRouter from './routes/funding.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const MARKET_SLAB_ADDRESS = process.env.MARKET_SLAB_ADDRESS;
const STATS_INTERVAL = parseInt(process.env.STATS_COLLECTION_INTERVAL || '30000', 10);

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    rpc: SOLANA_RPC_URL,
    marketSlab: MARKET_SLAB_ADDRESS || 'not configured',
  });
});

// Mount API routes
app.use('/api/warmup', initWarmupRouter(SOLANA_RPC_URL));
app.use('/api/insurance', insuranceRouter);
app.use('/api/oi', oiRouter);
app.use('/api/funding', fundingRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Server] RPC: ${SOLANA_RPC_URL}`);

  // Initialize StatsCollector if market slab is configured
  if (MARKET_SLAB_ADDRESS) {
    const collector = initStatsCollector(SOLANA_RPC_URL, MARKET_SLAB_ADDRESS, STATS_INTERVAL);
    collector.start();
    console.log(`[Server] StatsCollector started for ${MARKET_SLAB_ADDRESS}`);
  } else {
    console.warn('[Server] MARKET_SLAB_ADDRESS not configured - StatsCollector not started');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('[Server] Server closed');
    process.exit(0);
  });
});

export default app;
