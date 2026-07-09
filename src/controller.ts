import type { SimState } from './engine-api.js';
// Coupling-aware v13: spread zone A more evenly to offload the expensive fan0.
export function control(state: SimState, context: Record<string, any>): number[] {
  const emaAlpha = 0.4375;
  const prev = context.prev ?? state.zones.map(z => z.temp);
  const ema = context.ema ?? state.zones.map(() => 0);
  const slope = state.zones.map((z, i) => emaAlpha * ema[i] + (1 - emaAlpha) * (z.temp - prev[i]));

  const t0 = state.zones[0].temp;
  const spA = slope[0] > 0 ? 69 : 72;
  const uA = 280 * (t0 - spA) + 1700 * slope[0];

  const t1 = state.zones[1].temp;
  const spB = slope[1] > 0 ? 55 : 60;
  const uB = 120 * (t1 - spB) + 700 * slope[1];

  const wA = [1.0, 0.80, 0.52, 0.44];
  const wB = [0.0, 0.88, 0.97, 1.0];
  const cap = 4250;
  const rpm = [0, 1, 2, 3].map(i =>
    Math.max(0, Math.min(cap, Math.max(wA[i] * uA, wB[i] * uB))));

  context.prev = state.zones.map(z => z.temp);
  context.ema = slope;
  return rpm;
}
