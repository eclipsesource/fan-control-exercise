// Fan controller — the hot-swap target.
// Participants and Claude Code edit this file to improve the score.
//
// Inputs:  state  — current temperatures, fan RPMs, power readings
//          context — mutable object that persists across ticks within a run
//                    (resets on each deploy or new scenario run)
// Output:  an RPM value for each fan (array of 4 numbers, 0–5000)

import type { SimState } from './engine-api.js';

export function control(state: SimState, context: Record<string, any>): number[] {
  const maxRpm = 5000;
  // Spin a fan up in proportion to how far its zone is over the limit.
  const limits = [80, 70]; // zone A must stay under 80°C, zone B under 70°C

  return state.fans.map((_fan, i) => {
    // Fans 0,1 handle zone A; fans 2,3 handle zone B.
    const zone = i < 2 ? 0 : 1;
    const error = state.zones[zone].temp - limits[zone];
    return Math.max(0, Math.min(maxRpm, error * 200));
  });
}
