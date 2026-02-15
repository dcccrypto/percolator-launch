import type { PriceModelParams } from './types.js';

/** Default minimum price: $0.001 */
const DEFAULT_MIN_PRICE = 1000;

/** Default maximum price: $1000 */
const DEFAULT_MAX_PRICE = 1000000000;

/**
 * Generate a random number from a standard normal distribution (mean=0, stddev=1)
 * Uses Box-Muller transform for Gaussian distribution
 * @returns A random number from N(0,1)
 */
export function gaussianRandom(): number {
  let u1 = 0, u2 = 0;
  // Ensure we don't get 0 which would cause log(0) = -Infinity
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  
  // Box-Muller transform
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return z0;
}

/**
 * Clamp a price value between min and max bounds
 * @param value - Price to clamp (E6 format)
 * @param params - Parameters containing minPrice and maxPrice
 * @returns Clamped price
 */
function clampPrice(value: number, params: PriceModelParams): number {
  const min = params.minPrice ?? DEFAULT_MIN_PRICE;
  const max = params.maxPrice ?? DEFAULT_MAX_PRICE;
  
  // Handle NaN or Infinity
  if (!Number.isFinite(value)) {
    return min;
  }
  
  // Clamp between min and max
  return Math.max(min, Math.min(max, value));
}

/**
 * Random walk price model
 * Formula: price * (1 + volatility * gaussianRandom())
 * 
 * @param currentE6 - Current price in E6 format
 * @param params - Model parameters
 * @returns New price in E6 format
 * 
 * @example
 * // 1% volatility random walk
 * const newPrice = randomWalk(5000000, { volatility: 0.01 });
 */
export function randomWalk(currentE6: number, params: PriceModelParams): number {
  const volatility = params.volatility ?? 0.01; // Default 1% volatility
  
  const change = volatility * gaussianRandom();
  const newPrice = currentE6 * (1 + change);
  
  return clampPrice(newPrice, params);
}

/**
 * Mean-reverting price model
 * Formula: price + revertSpeed * (meanPrice - price) + volatility * gaussianRandom() * price
 * 
 * @param currentE6 - Current price in E6 format
 * @param params - Model parameters (requires meanPrice)
 * @returns New price in E6 format
 * 
 * @example
 * // Revert to $5 with 10% speed and 0.5% volatility
 * const newPrice = meanRevert(6000000, { 
 *   meanPrice: 5000000, 
 *   revertSpeed: 0.1, 
 *   volatility: 0.005 
 * });
 */
export function meanRevert(currentE6: number, params: PriceModelParams): number {
  const meanPrice = params.meanPrice ?? currentE6; // Default to current price
  const revertSpeed = params.revertSpeed ?? 0.1;   // Default slow reversion
  const volatility = params.volatility ?? 0.005;   // Default 0.5% volatility
  
  // Mean reversion component
  const reversion = revertSpeed * (meanPrice - currentE6);
  
  // Random noise component
  const noise = volatility * gaussianRandom() * currentE6;
  
  const newPrice = currentE6 + reversion + noise;
  
  return clampPrice(newPrice, params);
}

/**
 * Trending price model with drift
 * Formula: price + driftPerStep + volatility * gaussianRandom() * price
 * 
 * @param currentE6 - Current price in E6 format
 * @param params - Model parameters (requires driftPerStep)
 * @returns New price in E6 format
 * 
 * @example
 * // Upward trend of $0.01 per step with 1% volatility
 * const newPrice = trending(5000000, { 
 *   driftPerStep: 10000,  // $0.01 in E6 
 *   volatility: 0.01 
 * });
 */
export function trending(currentE6: number, params: PriceModelParams): number {
  const driftPerStep = params.driftPerStep ?? 0;   // Default no drift
  const volatility = params.volatility ?? 0.01;    // Default 1% volatility
  
  // Deterministic drift
  const drift = driftPerStep;
  
  // Random noise component
  const noise = volatility * gaussianRandom() * currentE6;
  
  const newPrice = currentE6 + drift + noise;
  
  return clampPrice(newPrice, params);
}

/**
 * Crash price model with exponential decay and optional recovery
 * Formula: Exponential decay from current to price * (1 - crashMagnitude) over duration
 * 
 * @param currentE6 - Current price in E6 format
 * @param params - Model parameters (requires crashMagnitude, crashDurationMs)
 * @param elapsed - Milliseconds elapsed since crash started
 * @param duration - Total crash duration in milliseconds
 * @returns New price in E6 format
 * 
 * @example
 * // 50% crash over 10 seconds, 2 seconds elapsed
 * const newPrice = crash(5000000, { 
 *   crashMagnitude: 0.5, 
 *   crashDurationMs: 10000 
 * }, 2000, 10000);
 */
export function crash(
  currentE6: number, 
  params: PriceModelParams, 
  elapsed: number, 
  duration: number
): number {
  const crashMagnitude = params.crashMagnitude ?? 0.3; // Default 30% crash
  const recoverySpeed = params.recoverySpeed ?? 0;     // Default no recovery
  
  // Calculate progress through crash (0 to 1)
  const progress = Math.min(1, elapsed / duration);
  
  // Target price after crash
  const crashedPrice = currentE6 * (1 - crashMagnitude);
  
  if (progress < 1) {
    // During crash: exponential decay
    // Use exponential easing for realistic crash dynamics
    const decayFactor = 1 - Math.pow(1 - progress, 3);
    const newPrice = currentE6 - (currentE6 - crashedPrice) * decayFactor;
    return clampPrice(newPrice, params);
  } else {
    // After crash: optional recovery
    if (recoverySpeed > 0) {
      const recoveryProgress = Math.min(1, (elapsed - duration) / duration);
      const recoveryAmount = (currentE6 - crashedPrice) * recoverySpeed * recoveryProgress;
      const newPrice = crashedPrice + recoveryAmount;
      return clampPrice(newPrice, params);
    }
    return clampPrice(crashedPrice, params);
  }
}

/**
 * Squeeze (pump) price model with exponential rise and decay
 * Formula: Exponential rise then decay
 * 
 * @param currentE6 - Current price in E6 format
 * @param params - Model parameters (requires squeezeMagnitude, squeezeDurationMs)
 * @param elapsed - Milliseconds elapsed since squeeze started
 * @param duration - Total squeeze duration in milliseconds
 * @returns New price in E6 format
 * 
 * @example
 * // 100% pump over 10 seconds, 5 seconds elapsed
 * const newPrice = squeeze(5000000, { 
 *   squeezeMagnitude: 1.0, 
 *   squeezeDurationMs: 10000 
 * }, 5000, 10000);
 */
export function squeeze(
  currentE6: number, 
  params: PriceModelParams, 
  elapsed: number, 
  duration: number
): number {
  const squeezeMagnitude = params.squeezeMagnitude ?? 0.5; // Default 50% pump
  
  // Calculate progress through squeeze (0 to 1)
  const progress = Math.min(1, elapsed / duration);
  
  // Target price at peak
  const peakPrice = currentE6 * (1 + squeezeMagnitude);
  
  if (progress < 0.5) {
    // First half: exponential rise to peak
    const riseProgress = progress * 2; // 0 to 1 over first half
    const riseFactor = Math.pow(riseProgress, 2); // Quadratic acceleration
    const newPrice = currentE6 + (peakPrice - currentE6) * riseFactor;
    return clampPrice(newPrice, params);
  } else {
    // Second half: decay back down
    const decayProgress = (progress - 0.5) * 2; // 0 to 1 over second half
    const decayFactor = 1 - Math.pow(1 - decayProgress, 2); // Quadratic deceleration
    const newPrice = peakPrice - (peakPrice - currentE6) * decayFactor;
    return clampPrice(newPrice, params);
  }
}
