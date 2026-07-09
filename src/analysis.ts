// Server-side analysis of run results. All outputs are size-bounded so no
// Bash/jq is ever needed downstream.
import type { RunResult } from './engine-api.js';

// Rig fact: per-zone temperature thresholds (°C). The EngineApi does not expose
// these, so they are fixed here as a physical constant of the current rig (not a
// tuning finding). Fan mapping is also fixed: fans 0,1 -> zone0, fans 2,3 -> zone1.
export const ZONE_THRESHOLDS = [80, 70];
export const FAN_ZONE = [0, 0, 1, 1];

const round = (x: number, d = 3): number => {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

export interface PerZoneSummary {
  zone: number;
  threshold: number;
  peak: number;
  violationTicks: number;
  thermal: number;
}

export interface CompactSummary {
  ok: true;
  runId: string;
  scenario: string;
  score: number;
  components: { thermal: number; power: number };
  perZone: PerZoneSummary[];
  perFanEnergy: number[];
  totalEnergy: number;
  ticks: number;
}

/** Part A: small (<1 KB) summary — never the series or full per-tick violations. */
export function buildCompact(res: RunResult, runId: string, scenario: string): CompactSummary {
  const nZones = res.perZonePeakTemp.length;
  const perZone: PerZoneSummary[] = [];
  for (let z = 0; z < nZones; z++) {
    const threshold = ZONE_THRESHOLDS[z] ?? 0;
    let violationTicks = 0;
    let thermal = 0;
    for (const v of res.violations) {
      if (v.zone === z) {
        violationTicks++;
        thermal += (v.temp - threshold) ** 2;
      }
    }
    perZone.push({
      zone: z,
      threshold,
      peak: round(res.perZonePeakTemp[z]),
      violationTicks,
      thermal: round(thermal),
    });
  }
  return {
    ok: true,
    runId,
    scenario,
    score: round(res.score),
    components: { thermal: round(res.components.thermal), power: round(res.components.power) },
    perZone,
    perFanEnergy: res.perFanEnergy.map((e) => round(e)),
    totalEnergy: round(res.totalEnergy),
    ticks: res.ticks,
  };
}

export type AnalysisField = 'byBucket' | 'byFan' | 'violationWindows' | 'peaks';

const MAX_BUCKETS = 60;
const MAX_WINDOWS = 50;

/** Part B: analyze_run — compact, size-bounded views over a stored run's series. */
export function analyzeRun(
  res: RunResult,
  opts: { buckets?: number; include?: AnalysisField[] } = {},
): Record<string, any> {
  const series = res.series;
  if (!series) {
    return { ok: false, error: 'run has no stored series (cannot analyze)' };
  }
  const include = opts.include ?? ['byBucket', 'byFan', 'violationWindows', 'peaks'];
  const buckets = Math.min(MAX_BUCKETS, Math.max(1, Math.floor(opts.buckets ?? 12)));
  const nZones = series.zoneTemp.length;
  const nFans = series.fanRpm.length;
  const nSamples = series.t.length;
  const dt = res.dt;

  const out: Record<string, any> = { ok: true, runId: undefined, ticks: res.ticks, dt };

  if (include.includes('byBucket')) {
    const byBucket: any[] = [];
    for (let b = 0; b < buckets; b++) {
      const lo = Math.floor((b * nSamples) / buckets);
      const hi = Math.floor(((b + 1) * nSamples) / buckets); // exclusive
      if (hi <= lo) continue;
      const perZoneFanEnergy = new Array(nZones).fill(0);
      for (let f = 0; f < nFans; f++) {
        const zone = FAN_ZONE[f] ?? 0;
        let e = 0;
        for (let k = lo; k < hi; k++) e += series.fanPower[f][k] * dt;
        perZoneFanEnergy[zone] += e;
      }
      const perZone: any[] = [];
      for (let z = 0; z < nZones; z++) {
        let tMin = Infinity;
        let tMax = -Infinity;
        for (let k = lo; k < hi; k++) {
          const t = series.zoneTemp[z][k];
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
        }
        perZone.push({ zone: z, tempMin: round(tMin), tempMax: round(tMax), tempEnd: round(series.zoneTemp[z][hi - 1]) });
      }
      byBucket.push({
        t0: series.t[lo],
        t1: series.t[hi - 1],
        perZoneFanEnergy: perZoneFanEnergy.map((e) => round(e)),
        perZone,
      });
    }
    out.byBucket = byBucket;
  }

  if (include.includes('byFan')) {
    const meanRpm: number[] = [];
    const maxRpm: number[] = [];
    for (let f = 0; f < nFans; f++) {
      let sum = 0;
      let mx = -Infinity;
      for (let k = 0; k < nSamples; k++) {
        const r = series.fanRpm[f][k];
        sum += r;
        if (r > mx) mx = r;
      }
      meanRpm.push(round(sum / Math.max(1, nSamples)));
      maxRpm.push(round(mx));
    }
    out.byFan = { fanEnergy: res.perFanEnergy.map((e) => round(e)), meanRpm, maxRpm };
  }

  if (include.includes('violationWindows')) {
    // Contiguous over-threshold intervals per zone, from the per-tick violations.
    const byZone = new Map<number, { tick: number; temp: number }[]>();
    for (const v of res.violations) {
      if (!byZone.has(v.zone)) byZone.set(v.zone, []);
      byZone.get(v.zone)!.push({ tick: v.tick, temp: v.temp });
    }
    const windows: any[] = [];
    for (const [zone, vs] of byZone) {
      vs.sort((a, b) => a.tick - b.tick);
      const threshold = ZONE_THRESHOLDS[zone] ?? 0;
      let cur: { start: number; end: number; peakTick: number; peakTemp: number; thermal: number } | null = null;
      const flush = () => { if (cur) windows.push({ zone, startTick: cur.start, endTick: cur.end, peakTick: cur.peakTick, peakTemp: round(cur.peakTemp), thermal: round(cur.thermal) }); };
      for (const { tick, temp } of vs) {
        if (cur && tick === cur.end + 1) {
          cur.end = tick;
          cur.thermal += (temp - threshold) ** 2;
          if (temp > cur.peakTemp) { cur.peakTemp = temp; cur.peakTick = tick; }
        } else {
          flush();
          cur = { start: tick, end: tick, peakTick: tick, peakTemp: temp, thermal: (temp - threshold) ** 2 };
        }
      }
      flush();
    }
    windows.sort((a, b) => b.thermal - a.thermal);
    out.violationWindows = windows.slice(0, MAX_WINDOWS);
    if (windows.length > MAX_WINDOWS) out.violationWindowsTruncated = windows.length - MAX_WINDOWS;
  }

  if (include.includes('peaks')) {
    const peaks: any[] = [];
    for (let z = 0; z < nZones; z++) {
      let mx = -Infinity;
      let at = 0;
      for (let k = 0; k < nSamples; k++) {
        if (series.zoneTemp[z][k] > mx) { mx = series.zoneTemp[z][k]; at = k; }
      }
      peaks.push({ zone: z, tick: series.t[at], temp: round(mx) });
    }
    out.peaks = peaks;
  }

  return out;
}

const SERIES_FIELDS = ['zoneTemp', 'fanRpm', 'fanPower', 'workload', 'totalPower'] as const;
export type SeriesField = (typeof SERIES_FIELDS)[number];

/** Part B: get_series — downsampled so points-per-field ≤ maxPoints; reports effective rate. */
export function getSeries(
  res: RunResult,
  opts: { fields?: SeriesField[]; sampleEvery?: number; tickRange?: [number, number]; maxPoints?: number } = {},
): Record<string, any> {
  const series = res.series;
  if (!series) return { ok: false, error: 'run has no stored series' };
  const fields = opts.fields ?? ['zoneTemp', 'fanRpm', 'workload'];
  const maxPoints = Math.min(2000, Math.max(1, Math.floor(opts.maxPoints ?? 400)));
  const nSamples = series.t.length;

  // Resolve tick range to sample-index range (series.t is monotonically increasing).
  let lo = 0;
  let hi = nSamples; // exclusive
  if (opts.tickRange) {
    const [a, b] = opts.tickRange;
    lo = series.t.findIndex((t) => t >= a);
    if (lo < 0) lo = nSamples;
    let end = series.t.findIndex((t) => t > b);
    hi = end < 0 ? nSamples : end;
  }
  const rangeLen = Math.max(0, hi - lo);
  const requested = Math.max(1, Math.floor(opts.sampleEvery ?? 1));
  const needed = Math.ceil(rangeLen / maxPoints);
  const step = Math.max(requested, needed, 1);

  const idx: number[] = [];
  for (let k = lo; k < hi; k += step) idx.push(k);

  const out: Record<string, any> = { ok: true, effectiveSampleEvery: step, points: idx.length, t: idx.map((k) => series.t[k]) };
  for (const f of fields) {
    if (f === 'zoneTemp') out.zoneTemp = series.zoneTemp.map((arr) => idx.map((k) => round(arr[k])));
    else if (f === 'fanRpm') out.fanRpm = series.fanRpm.map((arr) => idx.map((k) => round(arr[k])));
    else if (f === 'fanPower') out.fanPower = series.fanPower.map((arr) => idx.map((k) => round(arr[k])));
    else if (f === 'workload') out.workload = idx.map((k) => round(series.workload[k]));
    else if (f === 'totalPower') out.totalPower = idx.map((k) => round(series.totalPower[k]));
  }
  return out;
}
