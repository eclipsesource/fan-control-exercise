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
  const targets = [70, 60]; // conservative target temps per zone

  return state.fans.map((_fan, i) => {
    // Naive: fan 0,1 react to zone A; fan 2,3 react to zone B
    const zone = i < 2 ? 0 : 1;
    const error = state.zones[zone].temp - targets[zone];
    return Math.max(0, Math.min(maxRpm, error * 200));
  });
}
