import { NextRequest, NextResponse } from 'next/server';
import { Keypair } from '@solana/web3.js';
import { SimulationManager } from '@/lib/simulation/SimulationManager';
import { requireAuth, UNAUTHORIZED } from '@/lib/api-auth';
import { ScenarioName } from '@/lib/simulation/scenarios';

export const dynamic = 'force-dynamic';

interface StartSimulationRequest {
  slabAddress: string;
  oracleSecret?: string;
  startPriceE6?: number;
  scenario?: ScenarioName;
  model?: string;
  intervalMs?: number;
  params?: Record<string, number>;
}

/**
 * POST /api/simulation/start
 * Body: { slabAddress, oracleSecret, startPriceE6?, scenario?, model?, intervalMs?, params? }
 */
export async function POST(request: NextRequest) {
  if (!requireAuth(request)) return UNAUTHORIZED;
  try {
    const body: StartSimulationRequest = await request.json();
    
    // Validate required fields
    if (!body.slabAddress) {
      return NextResponse.json(
        { error: 'slabAddress is required' },
        { status: 400 }
      );
    }
    
    // Default starting price: $1.00 (simulation token)
    const startPriceE6 = body.startPriceE6 || 1_000000;
    
    const manager = SimulationManager.getInstance();

    // Inject oracle keypair from client (Vercel serverless = no shared memory between requests)
    if (body.oracleSecret) {
      const oracleKeypair = Keypair.fromSecretKey(Buffer.from(body.oracleSecret, 'base64'));
      manager.storeSelfServiceSession({
        oracleKeypair,
        mintKeypair: Keypair.generate(), // placeholder, not needed for price pushing
        slabAddress: body.slabAddress,
        tokenName: '',
        tokenSymbol: '',
        payerPublicKey: '',
        createdAt: Date.now(),
      });
    }
    
    await manager.start({
      slabAddress: body.slabAddress,
      startPriceE6,
      scenario: body.scenario,
      model: body.model || 'random-walk',
      intervalMs: body.intervalMs || 5000,
      params: body.params,
    });
    
    const state = manager.getState();
    
    return NextResponse.json({
      success: true,
      message: 'Simulation started',
      state: {
        slabAddress: state.slabAddress,
        startPriceE6,
        model: state.model,
        scenario: state.scenario,
        params: state.params,
        sessionId: state.sessionId,
      },
    });
  } catch (error) {
    console.error('Simulation start error:', error);
    return NextResponse.json(
      {
        error: 'Failed to start simulation',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
