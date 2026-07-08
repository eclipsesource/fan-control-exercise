// Public contract for the fan-control engine.
//
// This is the ONLY engine file the MCP server (and controller) should need.
// It exposes the operations you can drive and the shapes of the data you get
// back — but nothing about *how* the device behaves. The physics, coupling,
// scenario timings, and scoring live in `src/internal/` and are intentionally
// out of reach: the whole point of the exercise is to discover that behavior
// empirically, through the tools you build, not by reading the source.

/** Which workload trace to run. */
export type TraceName = 'scenario1' | 'scenario2';

/** A snapshot of the simulator at one instant. */
export interface SimState {
  /** Tick counter (integer steps since reset). */
  t: number;
  /** Per-zone temperatures (°C), indexed by zone. */
  zones: { temp: number }[];
  /** Per-fan readings, indexed by fan. */
  fans: { rpm: number; power: number }[];
  /** Sum of all fan power this tick. */
  totalPower: number;
}

/** One segment of a workload trace; intensity ramps linearly across [startTick, endTick). */
export interface TraceSegment {
  startTick: number;
  endTick: number;
  startIntensity: number;
  endIntensity: number;
}

/** The result of running a scenario: score breakdown plus diagnostics. */
export interface RunResult {
  /** Composite score (lower is better): thermal + λ·power. */
  score: number;
  /** Score split into its two components. */
  components: { thermal: number; power: number };
  /** Highest temperature reached per zone (°C). */
  perZonePeakTemp: number[];
  /** Every tick a zone was over its threshold. */
  violations: { zone: number; tick: number; temp: number }[];
  /** Energy consumed per fan over the run. */
  perFanEnergy: number[];
  /** Total energy consumed over the run. */
  totalEnergy: number;
  /** Number of ticks simulated. */
  ticks: number;
  /** Seconds per tick. */
  dt: number;
  /** Optional downsampled time series (present when a sample rate was requested). */
  series?: {
    t: number[];
    workload: number[];
    zoneTemp: number[][];   // [zoneIndex][sample]
    fanRpm: number[][];     // [fanIndex][sample]
    fanPower: number[][];   // [fanIndex][sample]
    totalPower: number[];
  };
}

/**
 * The engine surface relevant to controller optimization. Build your MCP tools
 * on top of these methods.
 */
export interface EngineApi {
  /** Reset the simulator to ambient; stop all fans. */
  reset(): void;

  /** Read the current controller source code. */
  readController(): string;

  /**
   * Deploy a controller: optionally write new source, then hot-reload and
   * validate it. Returns { ok } or { ok:false, error } if it fails to load or
   * does not export a valid control(state, context) => number[] function.
   */
  deployController(code?: string): Promise<{ ok: boolean; error?: string }>;

  /** Run a built-in scenario through the current controller and score it. */
  runScenario(traceName: TraceName, opts?: { sampleEvery?: number }): RunResult;

  /** Run an ad-hoc workload trace (your own segments) through the current controller. */
  runCustomScenario(
    segments: TraceSegment[],
    opts?: { totalTicks?: number; sampleEvery?: number },
  ): RunResult;

  /** Re-read the most recent run's result, optionally at a different sample rate. */
  getLastRun(opts?: { sampleEvery?: number }): RunResult | null;
}
