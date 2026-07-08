// Composite scoring over a workload trace recording.
// score = Σ_t Σ_zone penalty(temp, threshold) + λ * Σ_t totalPower
// Lower is better.

import type { SimConfig } from './simulator.js';
import type { SimState, RunResult } from '../engine-api.js';

export interface RunRecording {
  dt: number;
  states: SimState[];
  workloads: number[];
  config: SimConfig;
}

/**
 * Compute the score and build a RunResult from a full recording.
 * sampleEvery controls series downsampling (1 = full resolution).
 */
export function computeRunResult(
  recording: RunRecording,
  lambda: number,
  sampleEvery: number = 1,
): RunResult {
  const { states, workloads, config, dt } = recording;
  const numZones = config.zones.length;
  const numFans = config.fans.length;

  let thermalPenalty = 0;
  let powerCost = 0;
  const perZonePeakTemp = new Array(numZones).fill(-Infinity);
  const perFanEnergy = new Array(numFans).fill(0);
  const violations: { zone: number; tick: number; temp: number }[] = [];
  let totalEnergy = 0;

  for (let i = 0; i < states.length; i++) {
    const state = states[i];

    // Thermal violation penalty
    for (let zi = 0; zi < numZones; zi++) {
      const temp = state.zones[zi].temp;
      const threshold = config.zones[zi].threshold;
      if (temp > perZonePeakTemp[zi]) perZonePeakTemp[zi] = temp;
      if (temp > threshold) {
        const over = temp - threshold;
        thermalPenalty += over * over;
        violations.push({ zone: zi, tick: i, temp });
      }
    }

    // Power
    for (let fi = 0; fi < numFans; fi++) {
      const p = state.fans[fi].power;
      perFanEnergy[fi] += p * dt;
    }
    powerCost += state.totalPower;
    totalEnergy += state.totalPower * dt;
  }

  const score = thermalPenalty + lambda * powerCost;

  // Build optional series (downsampled)
  let series: RunResult['series'] | undefined;
  if (sampleEvery > 0 && sampleEvery < states.length) {
    const t: number[] = [];
    const workload: number[] = [];
    const zoneTemp: number[][] = Array.from({ length: numZones }, () => []);
    const fanRpm: number[][] = Array.from({ length: numFans }, () => []);
    const fanPower: number[][] = Array.from({ length: numFans }, () => []);
    const totalPowerSeries: number[] = [];

    for (let i = 0; i < states.length; i += sampleEvery) {
      const state = states[i];
      t.push(state.t * dt);
      workload.push(workloads[i]);
      for (let zi = 0; zi < numZones; zi++) {
        zoneTemp[zi].push(state.zones[zi].temp);
      }
      for (let fi = 0; fi < numFans; fi++) {
        fanRpm[fi].push(state.fans[fi].rpm);
        fanPower[fi].push(state.fans[fi].power);
      }
      totalPowerSeries.push(state.totalPower);
    }

    series = { t, workload, zoneTemp, fanRpm, fanPower, totalPower: totalPowerSeries };
  }

  return {
    score,
    components: { thermal: thermalPenalty, power: lambda * powerCost },
    perZonePeakTemp,
    violations,
    perFanEnergy,
    totalEnergy,
    ticks: states.length,
    dt,
    series,
  };
}
