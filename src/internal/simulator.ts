// Pure thermal simulator. ZERO I/O. Synchronous step(dt).
// This is the seam: all physics lives here, all time/network lives elsewhere.

import type { SimState } from '../engine-api.js';

export interface ZoneConfig {
  thermalMass: number;
  ambientTemp: number;
  threshold: number;
  heatCoefficient: number;
  ambientLossCoefficient: number;
}

export interface FanConfig {
  maxRpm: number;
  powerCoefficient: number;     // k in power = k * (rpm/max)^3
  airflowCoefficient: number;   // a in airflow formula
  airflowSaturationB: number;   // b in soft clamp: a*(x)/(1+b*x)
}

export interface HiddenRegimeConfig {
  // Efficiency cliff — nonlinear airflow loss near max RPM
  efficiencyCliff: {
    enabled: boolean;
    thresholdFraction: number;   // e.g. 0.85 — above this fraction of maxRpm
    maxDropFraction: number;     // e.g. 0.5 — airflow multiplier drops to (1 - this) at max
  };
  // Secondary heat source — flares up under sustained high load
  secondaryHeat: {
    enabled: boolean;
    workloadThreshold: number;   // e.g. 0.7
    activationTicks: number;     // e.g. 30 consecutive ticks above threshold
    heatMultiplier: number;      // e.g. 0.4 — 40% extra heat
    decayTicks: number;          // e.g. 20 — ticks to decay after workload drops
    targetZone: number;          // which zone gets the extra heat (Zone B = 1)
  };
}

export interface SimConfig {
  zones: ZoneConfig[];
  fans: FanConfig[];
  coupling: number[][];          // coupling[zoneIndex][fanIndex]
  hiddenRegime: HiddenRegimeConfig;
}

export const DEFAULT_CONFIG: SimConfig = {
  zones: [
    {
      thermalMass: 5.0,
      ambientTemp: 25,
      threshold: 80,
      heatCoefficient: 60,
      ambientLossCoefficient: 0.5,
    },
    {
      thermalMass: 15.0,
      ambientTemp: 25,
      threshold: 70,
      heatCoefficient: 50,
      ambientLossCoefficient: 0.3,
    },
  ],
  fans: [
    { maxRpm: 5000, powerCoefficient: 10, airflowCoefficient: 20, airflowSaturationB: 0.5 },
    { maxRpm: 5000, powerCoefficient: 10, airflowCoefficient: 20, airflowSaturationB: 0.5 },
    { maxRpm: 5000, powerCoefficient: 10, airflowCoefficient: 20, airflowSaturationB: 0.5 },
    { maxRpm: 5000, powerCoefficient: 10, airflowCoefficient: 20, airflowSaturationB: 0.5 },
  ],
  // coupling[zoneIndex][fanIndex]
  coupling: [
    // Zone A cooling from each fan
    [0.9, 0.3, 0.15, 0.1],
    // Zone B cooling from each fan
    [0.2, 0.7, 0.85, 0.9],
  ],
  // These are fixed physical traits of the device — always active, not tunable.
  // Scenario 1's gentle workload simply never pushes the hardware hard enough
  // for them to matter; Scenario 2 does.
  hiddenRegime: {
    efficiencyCliff: {
      enabled: true,
      thresholdFraction: 0.85,
      maxDropFraction: 0.5,
    },
    secondaryHeat: {
      enabled: true,
      workloadThreshold: 0.7,
      activationTicks: 30,
      heatMultiplier: 0.4,
      decayTicks: 20,
      targetZone: 1,
    },
  },
};

export class Simulator {
  private config: SimConfig;
  private t: number = 0;
  private zoneTemps: number[];
  private fanRpms: number[];
  private workloadIntensity: number = 0;

  // Secondary heat source state
  private sustainedHighTicks: number = 0;
  private secondaryHeatActive: boolean = false;
  private secondaryHeatDecayRemaining: number = 0;

  constructor(config: SimConfig) {
    this.config = config;
    this.zoneTemps = config.zones.map(z => z.ambientTemp);
    this.fanRpms = config.fans.map(() => 0);
  }

  reset(): void {
    this.t = 0;
    this.zoneTemps = this.config.zones.map(z => z.ambientTemp);
    this.fanRpms = this.config.fans.map(() => 0);
    this.workloadIntensity = 0;
    this.sustainedHighTicks = 0;
    this.secondaryHeatActive = false;
    this.secondaryHeatDecayRemaining = 0;
  }

  setFan(fanIndex: number, rpm: number): void {
    const fan = this.config.fans[fanIndex];
    if (!fan) return;
    this.fanRpms[fanIndex] = Math.max(0, Math.min(fan.maxRpm, rpm));
  }

  setWorkload(intensity: number): void {
    this.workloadIntensity = Math.max(0, Math.min(1, intensity));
  }

  /** Compute fan power: k * (rpm/maxRpm)^3 */
  private fanPower(fanIndex: number): number {
    const fan = this.config.fans[fanIndex];
    const frac = this.fanRpms[fanIndex] / fan.maxRpm;
    return fan.powerCoefficient * frac * frac * frac;
  }

  /** Compute effective airflow with saturation and optional efficiency cliff */
  private fanAirflow(fanIndex: number): number {
    const fan = this.config.fans[fanIndex];
    const frac = this.fanRpms[fanIndex] / fan.maxRpm;

    // Base airflow: soft clamp  a * x / (1 + b * x)
    let airflow = fan.airflowCoefficient * frac / (1 + fan.airflowSaturationB * frac);

    // Efficiency cliff — airflow penalty above the RPM threshold
    const cliff = this.config.hiddenRegime.efficiencyCliff;
    if (cliff.enabled && frac > cliff.thresholdFraction) {
      const overFrac = (frac - cliff.thresholdFraction) / (1 - cliff.thresholdFraction);
      const multiplier = 1 - cliff.maxDropFraction * overFrac * overFrac;
      airflow *= multiplier;
    }

    return airflow;
  }

  /** Update secondary heat source state */
  private updateSecondaryHeat(): number {
    const sh = this.config.hiddenRegime.secondaryHeat;
    if (!sh.enabled) return 0;

    // Track sustained high workload
    if (this.workloadIntensity >= sh.workloadThreshold) {
      this.sustainedHighTicks++;
    } else {
      this.sustainedHighTicks = 0;
    }

    // Activate if sustained long enough
    if (this.sustainedHighTicks >= sh.activationTicks) {
      this.secondaryHeatActive = true;
      this.secondaryHeatDecayRemaining = sh.decayTicks;
    }

    // Decay after workload drops
    if (this.secondaryHeatActive && this.workloadIntensity < sh.workloadThreshold) {
      this.secondaryHeatDecayRemaining--;
      if (this.secondaryHeatDecayRemaining <= 0) {
        this.secondaryHeatActive = false;
      }
    }

    if (this.secondaryHeatActive) {
      return sh.heatMultiplier;
    }
    return 0;
  }

  step(dt: number): SimState {
    // Compute secondary heat multiplier before physics
    const secondaryHeatExtra = this.updateSecondaryHeat();

    // Precompute airflows
    const airflows = this.config.fans.map((_, i) => this.fanAirflow(i));

    // Update each zone
    for (let zi = 0; zi < this.config.zones.length; zi++) {
      const zone = this.config.zones[zi];

      // Heat input from workload
      let heatIn = this.workloadIntensity * zone.heatCoefficient;

      // Secondary heat source (applies to target zone only)
      const sh = this.config.hiddenRegime.secondaryHeat;
      if (sh.enabled && zi === sh.targetZone) {
        heatIn *= (1 + secondaryHeatExtra);
      }

      // Cooling from all fans via coupling matrix
      let cooling = 0;
      for (let fi = 0; fi < this.config.fans.length; fi++) {
        cooling += this.config.coupling[zi][fi] * airflows[fi];
      }

      // Ambient loss (proportional to temp above ambient)
      const ambientLoss = zone.ambientLossCoefficient * (this.zoneTemps[zi] - zone.ambientTemp);

      // Temperature change
      const dT = (heatIn - cooling - ambientLoss) * dt / zone.thermalMass;
      this.zoneTemps[zi] += dT;
    }

    this.t++;
    return this.read();
  }

  read(): SimState {
    const fans = this.config.fans.map((_, i) => ({
      rpm: this.fanRpms[i],
      power: this.fanPower(i),
    }));
    const totalPower = fans.reduce((sum, f) => sum + f.power, 0);

    return {
      t: this.t,
      zones: this.zoneTemps.map(temp => ({ temp })),
      fans,
      totalPower,
    };
  }
}
