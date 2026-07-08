// Workload trace definitions: deterministic time series of workload intensity.
// Each trace is a list of segments interpolated linearly.

import type { TraceSegment } from '../engine-api.js';

export interface Trace {
  name: string;
  totalTicks: number;
  segments: TraceSegment[];
}

/** Get workload intensity at a given tick by interpolating segments. */
export function getIntensityAtTick(trace: Trace, tick: number): number {
  if (tick < 0 || tick >= trace.totalTicks) return 0;
  for (const seg of trace.segments) {
    if (tick >= seg.startTick && tick < seg.endTick) {
      const frac = (tick - seg.startTick) / (seg.endTick - seg.startTick);
      return seg.startIntensity + frac * (seg.endIntensity - seg.startIntensity);
    }
  }
  return 0;
}

/**
 * Scenario 1 trace — the practice scenario participants iterate against.
 *
 * Shape: ramp -> burst -> gap -> burst -> sustained plateau -> cool-down.
 * Kept below 0.7 throughout so the secondary heat source never triggers — this
 * is the "learn the coupling and basic control" trace. But the load is heavy
 * enough (0.68 bursts, 0.65 plateau) that the naive starter controller creeps
 * over Zone A's threshold: it wastes Fan 1 on Zone A and has proportional-only
 * steady-state error. A coupling-aware controller with an integral term nearly
 * eliminates the thermal penalty, so there is real room to improve here.
 * Scenario 2 is where the secondary heat source additionally bites.
 * 60s simulated = 600 ticks at dt=0.1
 */
export const SCENARIO_1_TRACE: Trace = {
  name: 'scenario1',
  totalTicks: 600,
  segments: [
    // Ramp: 0s-5s (ticks 0-50), 0.0 -> 0.45
    { startTick: 0, endTick: 50, startIntensity: 0.0, endIntensity: 0.45 },
    // Steady low: 5s-8s (ticks 50-80), 0.45
    { startTick: 50, endTick: 80, startIntensity: 0.45, endIntensity: 0.45 },
    // Burst 1: 8s-13s (ticks 80-130), ramp to 0.68 (stays below 0.7)
    { startTick: 80, endTick: 88, startIntensity: 0.45, endIntensity: 0.68 },
    { startTick: 88, endTick: 130, startIntensity: 0.68, endIntensity: 0.68 },
    // Recovery: 13s-15.5s (ticks 130-155), drop to 0.35
    { startTick: 130, endTick: 155, startIntensity: 0.68, endIntensity: 0.35 },
    // Gap: 15.5s-23s (ticks 155-230), low at 0.35
    { startTick: 155, endTick: 230, startIntensity: 0.35, endIntensity: 0.35 },
    // Burst 2: 23s-28s (ticks 230-280), ramp to 0.68
    { startTick: 230, endTick: 238, startIntensity: 0.35, endIntensity: 0.68 },
    { startTick: 238, endTick: 280, startIntensity: 0.68, endIntensity: 0.68 },
    // Recovery: 28s-30s (ticks 280-300), drop to 0.45
    { startTick: 280, endTick: 300, startIntensity: 0.68, endIntensity: 0.45 },
    // Sustained plateau: 30s-44s (ticks 300-440), 0.65
    { startTick: 300, endTick: 315, startIntensity: 0.45, endIntensity: 0.65 },
    { startTick: 315, endTick: 440, startIntensity: 0.65, endIntensity: 0.65 },
    // Cool-down: 44s-52s (ticks 440-520), 0.65 -> 0.2
    { startTick: 440, endTick: 520, startIntensity: 0.65, endIntensity: 0.2 },
    // Tail: 52s-60s (ticks 520-600), 0.2
    { startTick: 520, endTick: 600, startIntensity: 0.2, endIntensity: 0.2 },
  ],
};

/**
 * Scenario 2 trace — used for official scoring.
 *
 * Different rhythm: three shorter bursts, irregular spacing,
 * sustained section at 0.75 (triggers the device's secondary heat source).
 * Same ~60s duration.
 */
export const SCENARIO_2_TRACE: Trace = {
  name: 'scenario2',
  totalTicks: 600,
  segments: [
    // Quick ramp: 0s-3s (ticks 0-30), 0.0 -> 0.5
    { startTick: 0, endTick: 30, startIntensity: 0.0, endIntensity: 0.5 },
    // Short burst 1: 3s-5.5s (ticks 30-55), spike to 0.85
    { startTick: 30, endTick: 35, startIntensity: 0.5, endIntensity: 0.85 },
    { startTick: 35, endTick: 55, startIntensity: 0.85, endIntensity: 0.85 },
    // Drop: 5.5s-7s (ticks 55-70), down to 0.35
    { startTick: 55, endTick: 70, startIntensity: 0.85, endIntensity: 0.35 },
    // Short gap: 7s-10s (ticks 70-100), 0.35
    { startTick: 70, endTick: 100, startIntensity: 0.35, endIntensity: 0.35 },
    // Short burst 2: 10s-13s (ticks 100-130), spike to 0.95
    { startTick: 100, endTick: 105, startIntensity: 0.35, endIntensity: 0.95 },
    { startTick: 105, endTick: 130, startIntensity: 0.95, endIntensity: 0.95 },
    // Quick drop: 13s-14.5s (ticks 130-145), down to 0.4
    { startTick: 130, endTick: 145, startIntensity: 0.95, endIntensity: 0.4 },
    // Sustained plateau at 0.75: 14.5s-22s (ticks 145-220)
    // This is 75 ticks — above the 30-tick threshold at >0.7, triggers secondary heat
    { startTick: 145, endTick: 155, startIntensity: 0.4, endIntensity: 0.75 },
    { startTick: 155, endTick: 220, startIntensity: 0.75, endIntensity: 0.75 },
    // Dip: 22s-25s (ticks 220-250), down to 0.3
    { startTick: 220, endTick: 250, startIntensity: 0.75, endIntensity: 0.3 },
    // Short burst 3: 25s-28s (ticks 250-280), spike to 0.9
    { startTick: 250, endTick: 255, startIntensity: 0.3, endIntensity: 0.9 },
    { startTick: 255, endTick: 280, startIntensity: 0.9, endIntensity: 0.9 },
    // Long cool-down: 28s-40s (ticks 280-400), 0.9 -> 0.15
    { startTick: 280, endTick: 400, startIntensity: 0.9, endIntensity: 0.15 },
    // Tail: 40s-60s (ticks 400-600), 0.15
    { startTick: 400, endTick: 600, startIntensity: 0.15, endIntensity: 0.15 },
  ],
};

export function getTrace(name: 'scenario1' | 'scenario2'): Trace {
  return name === 'scenario1' ? SCENARIO_1_TRACE : SCENARIO_2_TRACE;
}

/**
 * Build an ad-hoc trace from segments (e.g. one defined by the agent to probe
 * behavior or stress-test generalization). If totalTicks is omitted, it is
 * derived from the largest segment endTick.
 */
export function buildTrace(segments: TraceSegment[], totalTicks?: number): Trace {
  const derived = totalTicks ?? segments.reduce((m, s) => Math.max(m, s.endTick), 0);
  return { name: 'custom', totalTicks: derived, segments };
}
