/**
 * Simulation Scenario Presets
 * 
 * Each scenario defines a price model and parameters for automated testing
 * of different market conditions.
 */

export type ScenarioName = 
  | 'calm' 
  | 'bull' 
  | 'crash' 
  | 'squeeze' 
  | 'whale' 
  | 'blackswan'
  | 'pyth-calm'
  | 'pyth-crash'
  | 'pyth-squeeze'
  | 'pyth-blackswan'
  | 'pyth-volatile';

export interface ScenarioConfig {
  model: string;
  params: Record<string, number>;
  description: string;
  durationMs: number;
}

export const SCENARIOS: Record<ScenarioName, ScenarioConfig> = {
  calm: {
    model: 'mean-revert',
    params: { volatility: 0.002, revertSpeed: 0.1 },
    description: 'Low volatility, stable market',
    durationMs: 300000, // 5 min
  },
  bull: {
    model: 'trending',
    params: { volatility: 0.005, driftPerStep: 0.001 },
    description: 'Trending upward with moderate volatility',
    durationMs: 300000, // 5 min
  },
  crash: {
    model: 'crash',
    params: { crashMagnitude: 0.4, volatility: 0.02 },
    description: 'Rapid price decline triggering liquidations',
    durationMs: 120000, // 2 min
  },
  squeeze: {
    model: 'squeeze',
    params: { squeezeMagnitude: 0.5, volatility: 0.01 },
    description: 'Short squeeze with extreme funding rates',
    durationMs: 180000, // 3 min
  },
  whale: {
    model: 'random-walk',
    params: { volatility: 0.01 },
    description: 'Large position impacts market dynamics',
    durationMs: 300000, // 5 min
  },
  blackswan: {
    model: 'crash',
    params: { crashMagnitude: 0.7, volatility: 0.05 },
    description: 'Extreme volatility stress test',
    durationMs: 60000, // 1 min
  },
  'pyth-calm': {
    model: 'pyth-calm',
    params: { volatility: 0.001 },
    description: 'Real Pyth price + small random noise',
    durationMs: 300000, // 5 min
  },
  'pyth-crash': {
    model: 'pyth-crash',
    params: { crashMagnitude: 0.4, volatility: 0.02 },
    description: 'Real Pyth price with crash overlay (-40% ramp)',
    durationMs: 120000, // 2 min
  },
  'pyth-squeeze': {
    model: 'pyth-squeeze',
    params: { squeezeMagnitude: 0.5, volatility: 0.01 },
    description: 'Real Pyth price with squeeze overlay (+50% spike)',
    durationMs: 180000, // 3 min
  },
  'pyth-blackswan': {
    model: 'pyth-blackswan',
    params: { crashMagnitude: 0.4, volatility: 0.05 },
    description: 'Real Pyth price with sudden -40% drop',
    durationMs: 90000, // 1.5 min
  },
  'pyth-volatile': {
    model: 'pyth-volatile',
    params: { volatilityAmplification: 2.5, volatility: 0.01 },
    description: 'Real Pyth price with 2.5x amplified moves',
    durationMs: 300000, // 5 min
  },
};

/**
 * Get scenario configuration by name
 */
export function getScenario(name: ScenarioName): ScenarioConfig {
  return SCENARIOS[name];
}

/**
 * List all available scenarios
 */
export function listScenarios(): Array<{ name: ScenarioName; config: ScenarioConfig }> {
  return Object.entries(SCENARIOS).map(([name, config]) => ({
    name: name as ScenarioName,
    config,
  }));
}
