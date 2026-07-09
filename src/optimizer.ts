// Deterministic server-side search over the parametric controller's numeric
// space. Given a scalar objective and an async evaluator, returns the best
// params found within a budget of evaluations. Same seed + inputs => same result.
import { DIMENSIONS, fromVector, toVector, type ControllerParams } from './controller-template.js';

/** mulberry32 — small, fast, seedable PRNG (avoids Math.random for determinism). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface OptimizeOptions {
  method: 'coord-descent' | 'random';
  budget: number; // max evaluations (unique param sets)
  seed: number;
  start: ControllerParams;
  /** Evaluate a param set; lower is better. Must return a finite objective. */
  evaluate: (params: ControllerParams) => Promise<{ objective: number; extra?: any }>;
}

export interface OptimizeResult {
  bestParams: ControllerParams;
  bestObjective: number;
  bestExtra?: any;
  history: { evaluation: number; objective: number }[];
  evaluations: number;
}

export async function optimize(opts: OptimizeOptions): Promise<OptimizeResult> {
  const budget = Math.min(500, Math.max(1, Math.floor(opts.budget)));
  const rng = mulberry32(opts.seed);
  const cache = new Map<string, { objective: number; extra?: any }>();
  let evaluations = 0;
  const history: { evaluation: number; objective: number }[] = [];

  const evalVec = async (vec: number[]) => {
    const params = fromVector(vec);
    const key = JSON.stringify(vec);
    const cached = cache.get(key);
    if (cached) return cached;
    const r = await opts.evaluate(params);
    cache.set(key, r);
    evaluations++;
    return r;
  };

  let bestVec = toVector(opts.start);
  let best = await evalVec(bestVec);
  history.push({ evaluation: evaluations, objective: best.objective });

  if (opts.method === 'random') {
    while (evaluations < budget) {
      const vec = DIMENSIONS.map((d) => d.bounds[0] + rng() * (d.bounds[1] - d.bounds[0]));
      const r = await evalVec(vec);
      if (r.objective < best.objective) {
        best = r;
        bestVec = vec;
        history.push({ evaluation: evaluations, objective: r.objective });
      }
      if (evaluations >= budget) break;
    }
  } else {
    // Coordinate descent with shrinking step; step starts at 20% of each range.
    let scale = 0.2;
    while (evaluations < budget && scale > 0.005) {
      let improved = false;
      for (let d = 0; d < DIMENSIONS.length && evaluations < budget; d++) {
        const [lo, hi] = DIMENSIONS[d].bounds;
        const stepSize = (hi - lo) * scale;
        for (const dir of [1, -1]) {
          if (evaluations >= budget) break;
          const trial = clamp(bestVec[d] + dir * stepSize, lo, hi);
          if (trial === bestVec[d]) continue;
          const cand = bestVec.slice();
          cand[d] = trial;
          const r = await evalVec(cand);
          if (r.objective < best.objective) {
            best = r;
            bestVec = cand;
            improved = true;
            history.push({ evaluation: evaluations, objective: r.objective });
          }
        }
      }
      if (!improved) scale /= 2;
    }
  }

  return {
    bestParams: fromVector(bestVec),
    bestObjective: best.objective,
    bestExtra: best.extra,
    history,
    evaluations,
  };
}
