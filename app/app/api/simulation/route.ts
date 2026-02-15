import { NextResponse } from 'next/server';
import { SimulationManager } from '@/lib/simulation/SimulationManager';

export const dynamic = 'force-dynamic';

/**
 * GET /api/simulation
 * Returns current simulation state (running, price, model, scenario)
 */
export async function GET() {
  try {
    const manager = SimulationManager.getInstance();
    const state = manager.getState();
    
    const uptime = state.running ? Date.now() - state.startedAt : 0;
    
    return NextResponse.json({
      running: state.running,
      slabAddress: state.slabAddress,
      price: state.currentPriceE6,
      priceUSDC: state.currentPriceE6 / 1e6,
      model: state.model,
      scenario: state.scenario,
      params: state.params,
      uptime,
      updatesCount: state.updatesCount,
      sessionId: state.sessionId,
    });
  } catch (error) {
    console.error('Simulation status error:', error);
    return NextResponse.json(
      {
        error: 'Failed to get simulation status',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
