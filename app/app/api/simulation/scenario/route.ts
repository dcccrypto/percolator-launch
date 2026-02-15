import { NextRequest, NextResponse } from 'next/server';
import { SimulationManager } from '@/lib/simulation/SimulationManager';
import { requireAuth, UNAUTHORIZED } from '@/lib/api-auth';
import { ScenarioName, SCENARIOS } from '@/lib/simulation/scenarios';

export const dynamic = 'force-dynamic';

interface SwitchScenarioRequest {
  scenario: ScenarioName;
}

/**
 * POST /api/simulation/scenario
 * Body: { scenario: 'calm' | 'bull' | 'crash' | 'squeeze' | 'whale' | 'blackswan' }
 * 
 * Switches the running simulation to a different scenario.
 * Only works if a simulation is currently running.
 */
export async function POST(request: NextRequest) {
  if (!requireAuth(request)) return UNAUTHORIZED;
  try {
    const body: SwitchScenarioRequest = await request.json();
    
    if (!body.scenario) {
      return NextResponse.json(
        { error: 'scenario is required' },
        { status: 400 }
      );
    }
    
    const validScenarios: ScenarioName[] = ['calm', 'bull', 'crash', 'squeeze', 'whale', 'blackswan'];
    if (!validScenarios.includes(body.scenario)) {
      return NextResponse.json(
        {
          error: 'Invalid scenario',
          validScenarios,
        },
        { status: 400 }
      );
    }
    
    const manager = SimulationManager.getInstance();
    const state = manager.getState();
    
    if (!state.running) {
      return NextResponse.json(
        { error: 'No simulation is running. Start a simulation first.' },
        { status: 400 }
      );
    }
    
    manager.triggerScenario(body.scenario);
    
    const scenarioConfig = SCENARIOS[body.scenario];
    
    return NextResponse.json({
      success: true,
      message: `Switched to ${body.scenario} scenario`,
      scenario: {
        name: body.scenario,
        description: scenarioConfig.description,
        model: scenarioConfig.model,
        params: scenarioConfig.params,
        durationMs: scenarioConfig.durationMs,
      },
      currentPrice: state.currentPriceE6 / 1e6,
    });
  } catch (error) {
    console.error('Switch scenario error:', error);
    return NextResponse.json(
      {
        error: 'Failed to switch scenario',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/simulation/scenario
 * 
 * Lists all available scenarios.
 */
export async function GET() {
  try {
    const scenarios = Object.entries(SCENARIOS).map(([name, config]) => ({
      name,
      description: config.description,
      model: config.model,
      params: config.params,
      durationMs: config.durationMs,
    }));
    
    return NextResponse.json({
      scenarios,
    });
  } catch (error) {
    console.error('List scenarios error:', error);
    return NextResponse.json(
      {
        error: 'Failed to list scenarios',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
