import { NextRequest, NextResponse } from 'next/server';
import { SimulationManager } from '@/lib/simulation/SimulationManager';
import { ScenarioName } from '@/lib/simulation/scenarios';
import { loadOracleKeypair } from '@/lib/simulation/solana';

export const dynamic = 'force-dynamic';

interface StartSimulationRequest {
  slabAddress: string;
  startPriceE6?: number;
  scenario?: ScenarioName;
  model?: string;
  intervalMs?: number;
  params?: Record<string, number>;
}

/**
 * POST /api/simulation/start
 * Body: { slabAddress, startPriceE6?, scenario?, model?, intervalMs?, params? }
 * 
 * Starts a new simulation session with the specified configuration.
 */
export async function POST(request: NextRequest) {
  try {
    // Check if oracle keypair is configured
    const keypair = loadOracleKeypair();
    if (!keypair) {
      return NextResponse.json(
        {
          error: 'Simulation oracle not configured',
          details: 'Set SIMULATION_ORACLE_KEYPAIR environment variable with base58-encoded keypair',
          help: 'This keypair must match the oracle_authority field in the slab account',
        },
        { status: 503 }
      );
    }
    
    const body: StartSimulationRequest = await request.json();
    
    // Validate required fields
    if (!body.slabAddress) {
      return NextResponse.json(
        { error: 'slabAddress is required' },
        { status: 400 }
      );
    }
    
    // Default starting price: 100 USDC
    const startPriceE6 = body.startPriceE6 || 100_000000;
    
    const manager = SimulationManager.getInstance();
    
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
