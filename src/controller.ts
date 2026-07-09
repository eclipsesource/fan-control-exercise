import type { SimState } from './engine-api.js';
// FINAL: coupling-aware, load-spreading, predictive controller.
//  - Coupling matrix (fan0 strong on A; fans1-3 on B, fan1/2,3 weakly help A) exploited directly.
//  - No self-heating; airflow cliff peaks ~4250 rpm => cap there.
//  - Predictive gate: cool when (temp + lead*slope) would breach setpoint -> catch fast rises before
//    the ~10s-lagged zone gets there, but stay idle on harmless low-temp ramps (power saving).
//  - Load-spreading: split each zone's cooling across coupled fans (sqrt-coupling base weights);
//    cubic power makes many-slow far cheaper than few-fast -> big win on the long plateau & Scenario 1.
//  - Temperature-gated boost: recruit all fans to full ONLY when Zone A is predicted near its 80
//    threshold (the brief 0.9/0.95 bursts, which exceed the cooling ceiling), keeping the plateau cheap.
export function control(state: SimState, context: Record<string, any>): number[] {
  const target = [68.0, 68.5];   // ride Zone A low enough to absorb burst overshoot; Zone B near its limit
  const kp = [1100, 1200];
  const ki = [45, 20];
  const lead = [16, 12];
  const cap = 4250;
  const alpha = 0.5;

  const temps = state.zones.map(z => z.temp);
  const prev: number[] = context.prev ?? temps;
  const integ: number[] = context.integ ?? [0, 0];
  const emaSlope: number[] = context.emaSlope ?? [0, 0];

  const dT = temps.map((t, i) => t - prev[i]);
  const slope = dT.map((d, i) => (1 - alpha) * emaSlope[i] + alpha * d);
  const predicted = temps.map((t, i) => t + lead[i] * slope[i]);
  const err = predicted.map((p, i) => p - target[i]);
  const newInteg = integ.map((s, i) => Math.max(0, Math.min(150, s + (temps[i] - target[i]))));
  const demand = err.map((e, i) => kp[i] * e + ki[i] * newInteg[i]);
  const u = demand.map(d => Math.max(0, Math.min(cap, d)));

  context.prev = temps;
  context.integ = newInteg;
  context.emaSlope = slope;

  const uA = u[0], uB = u[1];
  const boost = Math.max(0, Math.min(1, (predicted[0] - 78) / 3));   // burst-only, temperature-gated
  const wBase = [1.0, 0.58, 0.41, 0.33];   // sqrt-coupling spread (plateau: cheap)
  const wFull = [1.0, 1.00, 1.00, 1.00];   // burst: all fans to full capacity
  const wA = [0, 1, 2, 3].map((i) => wBase[i] + boost * (wFull[i] - wBase[i]));
  const wB = [0.0, 0.88, 0.97, 1.0];       // Zone B spread over fans 1,2,3
  const rpm = [0, 1, 2, 3].map((i) => Math.max(wA[i] * uA, wB[i] * uB));
  return rpm.map((r) => Math.max(0, Math.min(cap, r)));
}
