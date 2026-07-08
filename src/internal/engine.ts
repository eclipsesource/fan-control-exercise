// Engine: owns the simulator instance, the tick loop, and the mode guard.
// Two clocks: real-time (for web UI) and scoring (synchronous, for MCP).

import fs from 'node:fs';
import { Simulator, DEFAULT_CONFIG, type SimConfig } from './simulator.js';
import { computeRunResult, type RunRecording } from './scoring.js';
import { getTrace, getIntensityAtTick, buildTrace, type Trace } from './trace.js';
import type { EngineApi, SimState, RunResult, TraceName, TraceSegment } from '../engine-api.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type Mode = 'idle' | 'realtime' | 'scoring';

export interface EngineConfig {
  dt: number;
  uiTickHz: number;
  realtimeSpeedMultiplier: number;
  sim: SimConfig;
}

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  dt: 0.1,
  uiTickHz: 20,
  realtimeSpeedMultiplier: 3,
  sim: DEFAULT_CONFIG,
};

export type LiveSnapshot = SimState & { mode: Mode };

export class Engine implements EngineApi {
  private config: EngineConfig;
  private sim: Simulator;
  private mode: Mode = 'idle';
  private lambda: number = 0.1;
  private tickCallbacks: Array<(s: LiveSnapshot) => void> = [];
  private runCompleteCallbacks: Array<(r: RunResult) => void> = [];
  private realtimeTimer: ReturnType<typeof setInterval> | null = null;
  private controlFn: ((state: SimState, context: Record<string, any>) => number[]) | null = null;
  private controlContext: Record<string, any> = {};
  private lastRunResult: { recording: RunRecording; lambda: number } | null = null;

  // Real-time playback state
  private realtimeTrace: Trace | null = null;
  private realtimeTickIndex: number = 0;
  private realtimeRecording: { states: SimState[]; workloads: number[] } | null = null;

  constructor(config?: Partial<EngineConfig>) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.sim = new Simulator(this.config.sim);
    this.loadDefaultController();
  }

  private async loadDefaultController(): Promise<void> {
    try {
      const mod = await import(`../controller.ts?t=${Date.now()}`);
      if (typeof mod.control === 'function') {
        this.controlFn = mod.control;
      }
    } catch {
      // Starter controller not available yet — fine
    }
  }

  getMode(): Mode {
    return this.mode;
  }

  getLambda(): number {
    return this.lambda;
  }

  getConfig(): EngineConfig {
    return this.config;
  }

  setLambda(value: number): void {
    this.lambda = Math.max(0, value);
  }

  setRealtimeSpeedMultiplier(x: number): void {
    this.config.realtimeSpeedMultiplier = Math.max(0.1, x);
    // Restart the timer if currently running to apply new speed
    if (this.realtimeTimer) {
      this.stopRealtimeTimer();
      this.startRealtimeTimer();
    }
  }

  onTick(cb: (s: LiveSnapshot) => void): void {
    this.tickCallbacks.push(cb);
  }

  onRunComplete(cb: (r: RunResult) => void): void {
    this.runCompleteCallbacks.push(cb);
  }

  getLiveSnapshot(): LiveSnapshot {
    return { ...this.sim.read(), mode: this.mode };
  }

  reset(): void {
    if (this.mode === 'scoring') {
      throw new Error('Cannot reset during scoring');
    }
    this.stopRealtime();
    this.sim.reset();
    this.controlContext = {};
    this.realtimeTrace = null;
    this.realtimeTickIndex = 0;
    this.mode = 'idle';
    this.emitTick();
  }

  // --- Real-time mode (human face) ---

  startRealtime(): void {
    if (this.mode === 'scoring') {
      throw new Error('Cannot start real-time during scoring');
    }
    this.mode = 'realtime';
    this.startRealtimeTimer();
  }

  stopRealtime(): void {
    this.stopRealtimeTimer();
    if (this.mode === 'realtime') {
      this.mode = 'idle';
    }
  }

  /**
   * Trigger a workload trace for real-time playback on the web board.
   * Resets the sim first, then plays the trace at the current speed multiplier.
   */
  triggerWorkload(traceName: TraceName): void {
    if (this.mode === 'scoring') {
      throw new Error('Cannot trigger workload during scoring');
    }
    this.stopRealtimeTimer();
    this.sim.reset();
    this.controlContext = {};
    this.realtimeTrace = getTrace(traceName);
    this.realtimeTickIndex = 0;
    this.realtimeRecording = { states: [], workloads: [] };
    this.mode = 'realtime';
    this.startRealtimeTimer();
  }

  private startRealtimeTimer(): void {
    if (this.realtimeTimer) return;
    const intervalMs = 1000 / this.config.uiTickHz;
    this.realtimeTimer = setInterval(() => this.realtimeTick(), intervalMs);
  }

  private stopRealtimeTimer(): void {
    if (this.realtimeTimer) {
      clearInterval(this.realtimeTimer);
      this.realtimeTimer = null;
    }
  }

  private realtimeTick(): void {
    // How many sim steps per UI tick to match the speed multiplier.
    // Each UI tick is 1/uiTickHz wall-seconds. We want to advance
    // realtimeSpeedMultiplier/uiTickHz simulated seconds per tick.
    // Each step advances dt simulated seconds.
    const stepsPerTick = Math.max(1, Math.round(
      this.config.realtimeSpeedMultiplier / (this.config.uiTickHz * this.config.dt)
    ));

    for (let s = 0; s < stepsPerTick; s++) {
      // Set workload from trace if playing one
      if (this.realtimeTrace) {
        if (this.realtimeTickIndex >= this.realtimeTrace.totalTicks) {
          // Trace finished — compute result and notify
          this.stopRealtimeTimer();
          this.mode = 'idle';
          if (this.realtimeRecording && this.realtimeRecording.states.length > 0) {
            const recording: RunRecording = {
              dt: this.config.dt,
              states: this.realtimeRecording.states,
              workloads: this.realtimeRecording.workloads,
              config: this.config.sim,
            };
            this.lastRunResult = { recording, lambda: this.lambda };
            const result = computeRunResult(recording, this.lambda);
            for (const cb of this.runCompleteCallbacks) {
              try { cb(result); } catch { /* ignore */ }
            }
          }
          this.realtimeTrace = null;
          this.realtimeRecording = null;
          return;
        }
        const intensity = getIntensityAtTick(this.realtimeTrace, this.realtimeTickIndex);
        this.sim.setWorkload(intensity);
        this.realtimeTickIndex++;
      }

      // Apply controller
      if (this.controlFn) {
        try {
          const rpms = this.controlFn(this.sim.read(), this.controlContext);
          if (Array.isArray(rpms)) {
            for (let fi = 0; fi < rpms.length && fi < this.config.sim.fans.length; fi++) {
              const rpm = Number(rpms[fi]);
              if (!isNaN(rpm)) this.sim.setFan(fi, rpm);
            }
          }
        } catch {
          // Controller error — keep last RPMs
        }
      }

      const state = this.sim.step(this.config.dt);

      // Record for scoring at end of trace
      if (this.realtimeRecording && this.realtimeTrace) {
        this.realtimeRecording.states.push(state);
        this.realtimeRecording.workloads.push(
          getIntensityAtTick(this.realtimeTrace, this.realtimeTickIndex - 1),
        );
      }
    }

    this.emitTick();
  }

  private emitTick(): void {
    const snapshot = this.getLiveSnapshot();
    for (const cb of this.tickCallbacks) {
      try { cb(snapshot); } catch { /* ignore callback errors */ }
    }
  }

  // --- Controller read/write/deploy ---

  private get controllerPath(): string {
    return resolve(__dirname, '..', 'controller.ts');
  }

  /** Read the current controller source code. */
  readController(): string {
    return fs.readFileSync(this.controllerPath, 'utf-8');
  }

  /** Write new controller source code to disk (does NOT reload it). */
  writeController(code: string): void {
    fs.writeFileSync(this.controllerPath, code, 'utf-8');
  }

  /**
   * Deploy the controller: optionally write new source, then reload and validate.
   * If code is provided, writes it first. Then hot-reloads via cache-busting import.
   */
  async deployController(code?: string): Promise<{ ok: boolean; error?: string }> {
    if (this.mode === 'scoring') {
      return { ok: false, error: 'Cannot deploy during scoring' };
    }

    // Write source if provided
    if (code !== undefined) {
      this.writeController(code);
    }

    try {
      // Cache-busting dynamic import
      const mod = await import(`../controller.ts?t=${Date.now()}`);

      // Check export exists
      if (typeof mod.control !== 'function') {
        return { ok: false, error: '`control` export is not a function' };
      }

      // Dry-run validation
      const dummyState: SimState = {
        t: 0,
        zones: this.config.sim.zones.map(z => ({ temp: z.ambientTemp })),
        fans: this.config.sim.fans.map(() => ({ rpm: 0, power: 0 })),
        totalPower: 0,
      };
      const dummyContext: Record<string, any> = {};
      const result = mod.control(dummyState, dummyContext);

      if (!Array.isArray(result)) {
        return { ok: false, error: `control() returned ${typeof result}, expected array` };
      }
      if (result.length !== this.config.sim.fans.length) {
        return { ok: false, error: `control() returned ${result.length} values, expected ${this.config.sim.fans.length}` };
      }
      for (let i = 0; i < result.length; i++) {
        const v = result[i];
        if (typeof v !== 'number' || isNaN(v)) {
          return { ok: false, error: `control() returned invalid value at index ${i}: ${v}` };
        }
      }

      this.controlFn = mod.control;
      this.controlContext = {};
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  // --- Scoring mode (agent face) ---

  /**
   * Run a scenario synchronously. Ticks the entire trace in a tight loop.
   * Records every tick. Returns RunResult with score + optional series.
   */
  runScenario(
    traceName: TraceName,
    opts?: { sampleEvery?: number },
  ): RunResult {
    return this.runTrace(getTrace(traceName), opts);
  }

  /**
   * Run an ad-hoc trace defined by segments (agent-authored scenario).
   * Same scoring path as runScenario — useful for probing behavior or
   * stress-testing controller generalization beyond the built-in scenarios.
   */
  runCustomScenario(
    segments: TraceSegment[],
    opts?: { totalTicks?: number; sampleEvery?: number },
  ): RunResult {
    return this.runTrace(buildTrace(segments, opts?.totalTicks), opts);
  }

  private runTrace(
    trace: Trace,
    opts?: { sampleEvery?: number },
  ): RunResult {
    if (this.mode === 'scoring') {
      throw new Error('A scoring run is already in progress');
    }
    if (this.mode === 'realtime') {
      this.stopRealtime();
    }

    this.mode = 'scoring';
    try {
      this.sim.reset();
      this.controlContext = {};

      const states: SimState[] = [];
      const workloads: number[] = [];

      for (let tick = 0; tick < trace.totalTicks; tick++) {
        const intensity = getIntensityAtTick(trace, tick);
        this.sim.setWorkload(intensity);

        // Apply controller
        if (this.controlFn) {
          try {
            const rpms = this.controlFn(this.sim.read(), this.controlContext);
            if (Array.isArray(rpms)) {
              for (let fi = 0; fi < rpms.length && fi < this.config.sim.fans.length; fi++) {
                const rpm = Number(rpms[fi]);
                if (!isNaN(rpm)) this.sim.setFan(fi, rpm);
              }
            }
          } catch {
            // Controller error — keep last RPMs
          }
        }

        const state = this.sim.step(this.config.dt);
        states.push(state);
        workloads.push(intensity);
      }

      const recording: RunRecording = {
        dt: this.config.dt,
        states,
        workloads,
        config: this.config.sim,
      };
      this.lastRunResult = { recording, lambda: this.lambda };

      const result = computeRunResult(recording, this.lambda, opts?.sampleEvery ?? 1);

      // Notify listeners
      for (const cb of this.runCompleteCallbacks) {
        try { cb(result); } catch { /* ignore */ }
      }

      // Push final state to web board
      this.emitTick();

      return result;
    } finally {
      this.mode = 'idle';
    }
  }

  /**
   * Re-read the recording of the last run, optionally at a different sample rate.
   */
  getLastRun(opts?: { sampleEvery?: number }): RunResult | null {
    if (!this.lastRunResult) return null;
    return computeRunResult(
      this.lastRunResult.recording,
      this.lastRunResult.lambda,
      opts?.sampleEvery ?? 1,
    );
  }
}
