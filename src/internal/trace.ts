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
 * Gentle overall, but with two short high spikes (~0.85–0.88) that exercise
 * transient response. Each spike is kept UNDER 30 ticks at ≥0.7 so the
 * secondary heat source never triggers here — that regime is Scenario 2's
 * signature. Good place to learn the coupling and get basic control working.
 * 60s simulated = 600 ticks at dt=0.1
 */
export const SCENARIO_1_TRACE: Trace = {
  name: 'scenario1',
  totalTicks: 600,
  segments: [
    { startTick: 0, endTick: 50, startIntensity: 0.0, endIntensity: 0.45 },
    { startTick: 50, endTick: 80, startIntensity: 0.45, endIntensity: 0.45 },
    // Short spike 1: ~0.85 for 18 ticks (<30 at ≥0.7 → no secondary heat)
    { startTick: 80, endTick: 86, startIntensity: 0.45, endIntensity: 0.85 },
    { startTick: 86, endTick: 104, startIntensity: 0.85, endIntensity: 0.85 },
    { startTick: 104, endTick: 120, startIntensity: 0.85, endIntensity: 0.3 },
    // Gap
    { startTick: 120, endTick: 210, startIntensity: 0.3, endIntensity: 0.3 },
    // Short spike 2: ~0.88 for 18 ticks
    { startTick: 210, endTick: 216, startIntensity: 0.3, endIntensity: 0.88 },
    { startTick: 216, endTick: 234, startIntensity: 0.88, endIntensity: 0.88 },
    { startTick: 234, endTick: 250, startIntensity: 0.88, endIntensity: 0.35 },
    // Mild sustained plateau (stays below 0.7)
    { startTick: 250, endTick: 300, startIntensity: 0.35, endIntensity: 0.35 },
    { startTick: 300, endTick: 315, startIntensity: 0.35, endIntensity: 0.6 },
    { startTick: 315, endTick: 440, startIntensity: 0.6, endIntensity: 0.6 },
    // Cool-down + tail
    { startTick: 440, endTick: 520, startIntensity: 0.6, endIntensity: 0.2 },
    { startTick: 520, endTick: 600, startIntensity: 0.2, endIntensity: 0.2 },
  ],
};

/**
 * Scenario 2 trace — used for official scoring.
 *
 * Harder rhythm: sharp bursts up to 0.97 and a sustained 0.8 plateau (ticks
 * 160–230) that comfortably trips the secondary heat source on Zone B. Demands
 * near-optimal control (all fans, capped below the efficiency cliff, coupling
 * aware) to hold both zones. Same ~60s duration.
 */
export const SCENARIO_2_TRACE: Trace = {
  name: 'scenario2',
  totalTicks: 600,
  segments: [
    { startTick: 0, endTick: 30, startIntensity: 0.0, endIntensity: 0.5 },
    // Burst 1: 0.85
    { startTick: 30, endTick: 35, startIntensity: 0.5, endIntensity: 0.85 },
    { startTick: 35, endTick: 55, startIntensity: 0.85, endIntensity: 0.85 },
    { startTick: 55, endTick: 70, startIntensity: 0.85, endIntensity: 0.35 },
    { startTick: 70, endTick: 100, startIntensity: 0.35, endIntensity: 0.35 },
    // Burst 2: 0.97, longer (ticks 105–138)
    { startTick: 100, endTick: 105, startIntensity: 0.35, endIntensity: 0.97 },
    { startTick: 105, endTick: 138, startIntensity: 0.97, endIntensity: 0.97 },
    { startTick: 138, endTick: 150, startIntensity: 0.97, endIntensity: 0.4 },
    // Sustained plateau at 0.8 (ticks 160–230) — triggers secondary heat on Zone B
    { startTick: 150, endTick: 160, startIntensity: 0.4, endIntensity: 0.8 },
    { startTick: 160, endTick: 230, startIntensity: 0.8, endIntensity: 0.8 },
    { startTick: 230, endTick: 255, startIntensity: 0.8, endIntensity: 0.3 },
    // Burst 3: 0.92
    { startTick: 255, endTick: 260, startIntensity: 0.3, endIntensity: 0.92 },
    { startTick: 260, endTick: 285, startIntensity: 0.92, endIntensity: 0.92 },
    // Long cool-down + tail
    { startTick: 285, endTick: 400, startIntensity: 0.92, endIntensity: 0.15 },
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
