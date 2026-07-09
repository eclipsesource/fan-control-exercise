// MCP server: tools over the fan-control engine via SSE transport.
//
// Tool surface (see fan-control-improvements-plan.md):
//   Safe, auto-approvable loop (numbers only, bounded output):
//     read_controller, run_scenario, run_params, evaluate_params, optimize,
//     analyze_run, get_series, list_runs, get_run, reset
//   Confirmation-gated (arbitrary code): deploy_controller
//
// The parametric controller is owned here: run_params/evaluate_params/optimize
// validate numeric params, render a fixed server-authored template with only
// those numbers, and deploy it via engine.deployController(). The agent never
// supplies code on the loop path.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EngineApi, RunResult, TraceName } from './engine-api.js';
import {
  DEFAULT_PARAMS,
  renderControllerSource,
  validateParams,
  type ControllerParams,
} from './controller-template.js';
import { analyzeRun, buildCompact, getSeries, type CompactSummary } from './analysis.js';
import { RunsStore } from './runs-store.js';
import { optimize } from './optimizer.js';

const round = (x: number, d = 3): number => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : 0);

// --- Reusable zod shapes ---
const zoneParamsSchema = z.object({
  spUp: z.number(),
  spDown: z.number(),
  kp: z.number(),
  kd: z.number(),
  cap: z.number(),
});
const controllerParamsSchema = z.object({
  zones: z.tuple([zoneParamsSchema, zoneParamsSchema]),
  emaAlpha: z.number(),
  slopeRisingThreshold: z.number(),
});
const traceEnum = z.enum(['scenario1', 'scenario2']);
const segmentSchema = z.object({
  startTick: z.number().int().nonnegative(),
  endTick: z.number().int().positive(),
  startIntensity: z.number(),
  endIntensity: z.number(),
});

export function createMcpServer(engine: EngineApi): McpServer {
  const server = new McpServer({ name: 'fan-control', version: '1.0.0' });
  const store = new RunsStore();

  const respond = (obj: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(obj) }] });

  // Wrap a handler with uniform try/catch + JSON-in-text response.
  const register = (
    name: string,
    config: { description: string; inputSchema?: z.ZodRawShape },
    fn: (args: any) => unknown | Promise<unknown>,
  ) => {
    server.registerTool(name, config, async (args: any) => {
      try {
        return respond(await fn(args ?? {}));
      } catch (err: any) {
        return respond({ ok: false, error: err?.message ?? String(err) });
      }
    });
  };

  // Persist a run and return its compact summary.
  const persistRun = (res: RunResult, scenario: string, params?: unknown): CompactSummary => {
    const runId = store.nextRunId();
    store.append({ runId, ts: Date.now(), scenario, params, result: res });
    return buildCompact(res, runId, scenario);
  };

  // Validate params, render + deploy the template. Returns validated params or an error.
  const deployValidated = async (
    input: unknown,
  ): Promise<{ ok: true; params: ControllerParams } | { ok: false; error: string }> => {
    const v = validateParams(input);
    if (!v.ok) return v;
    const dep = await engine.deployController(renderControllerSource(v.params));
    if (!dep.ok) return { ok: false, error: dep.error ?? 'deploy failed' };
    return { ok: true, params: v.params };
  };

  const scenarioLine = (c: CompactSummary) => ({
    runId: c.runId,
    score: c.score,
    thermal: c.components.thermal,
    power: c.components.power,
    peaks: c.perZone.map((z) => z.peak),
  });

  // ---- reset (safe) ----
  register('reset', { description: 'Reset the simulator to its initial state. All zone temperatures return to ambient and all fans stop.' }, () => {
    engine.reset();
    return { ok: true };
  });

  // ---- read_controller (safe) ----
  register('read_controller', { description: 'Read the current fan-controller source code.' }, () => ({
    ok: true,
    source: engine.readController(),
  }));

  // ---- deploy_controller (CONFIRMATION-GATED: arbitrary code) ----
  register(
    'deploy_controller',
    {
      description:
        'Deploy free-form controller code (exports control(state, context) => number[]). Hot-reloads + validates. ' +
        'CONFIRMATION-GATED / not auto-approved — the numbers-only loop tools (run_params/evaluate_params/optimize) are preferred. ' +
        'Omit `code` to re-deploy the current file.',
      inputSchema: { code: z.string().optional() },
    },
    async ({ code }) => engine.deployController(code),
  );

  // ---- run_scenario (safe): runs the CURRENT controller, returns compact summary ----
  register(
    'run_scenario',
    {
      description: 'Run a built-in scenario through the current controller; returns a compact (<1 KB) scored summary. Use get_series/analyze_run for detail.',
      inputSchema: { traceName: traceEnum },
    },
    ({ traceName }: { traceName: TraceName }) => persistRun(engine.runScenario(traceName, { sampleEvery: 1 }), traceName),
  );

  // ---- run_custom_scenario (safe) ----
  register(
    'run_custom_scenario',
    {
      description: 'Run an ad-hoc workload trace through the current controller; returns a compact scored summary.',
      inputSchema: { segments: z.array(segmentSchema), totalTicks: z.number().int().positive().optional() },
    },
    ({ segments, totalTicks }) =>
      persistRun(
        engine.runCustomScenario(segments, totalTicks !== undefined ? { totalTicks, sampleEvery: 1 } : { sampleEvery: 1 }),
        'custom',
      ),
  );

  // ---- get_last_run (safe): compact summary of the most recent run ----
  register('get_last_run', { description: 'Re-read the most recent run as a compact summary. Returns {ok:true, result:null} if none.' }, () => {
    const latest = store.latest();
    if (!latest) return { ok: true, result: null };
    return buildCompact(latest.result, latest.runId, latest.scenario);
  });

  // ---- run_params (safe): tune the built-in parametric controller by numbers ----
  register(
    'run_params',
    {
      description:
        'Validate numeric params, deploy the built-in parametric controller with them, run one scenario (or custom segments), return the compact summary.',
      inputSchema: {
        params: controllerParamsSchema,
        scenario: traceEnum.optional(),
        segments: z.array(segmentSchema).optional(),
        totalTicks: z.number().int().positive().optional(),
      },
    },
    async ({ params, scenario, segments, totalTicks }) => {
      const dep = await deployValidated(params);
      if (!dep.ok) return dep;
      if (segments && segments.length) {
        const res = engine.runCustomScenario(segments, totalTicks !== undefined ? { totalTicks, sampleEvery: 1 } : { sampleEvery: 1 });
        return persistRun(res, 'custom', dep.params);
      }
      const trace: TraceName = scenario ?? 'scenario1';
      return persistRun(engine.runScenario(trace, { sampleEvery: 1 }), trace, dep.params);
    },
  );

  // ---- evaluate_params (safe): batch sweep, server-side, ranked table ----
  register(
    'evaluate_params',
    {
      description:
        'Batch-evaluate up to 64 param configs across scenarios; deploys each unique param set once, runs every scenario, returns a table ranked by worst-case score.',
      inputSchema: {
        configs: z.array(z.object({ label: z.string(), params: controllerParamsSchema })),
        scenarios: z.array(traceEnum).optional(),
      },
    },
    async ({ configs, scenarios }) => {
      if (configs.length > 64) return { ok: false, error: `configs.length ${configs.length} exceeds cap of 64` };
      const scen: TraceName[] = scenarios && scenarios.length ? scenarios : ['scenario1', 'scenario2'];
      for (const cfg of configs) {
        const v = validateParams(cfg.params);
        if (!v.ok) return { ok: false, error: `config "${cfg.label}": ${v.error}` };
      }
      const cache = new Map<string, Record<string, ReturnType<typeof scenarioLine>>>();
      const results: any[] = [];
      for (const cfg of configs) {
        const key = JSON.stringify(cfg.params);
        let byScenario = cache.get(key);
        if (!byScenario) {
          const dep = await deployValidated(cfg.params);
          if (!dep.ok) return { ok: false, error: `config "${cfg.label}": ${dep.error}` };
          byScenario = {};
          for (const sc of scen) {
            byScenario[sc] = scenarioLine(persistRun(engine.runScenario(sc, { sampleEvery: 1 }), sc, dep.params));
          }
          cache.set(key, byScenario);
        }
        const scores = scen.map((sc) => byScenario![sc].score);
        results.push({
          label: cfg.label,
          params: cfg.params,
          byScenario,
          worstScore: round(Math.max(...scores)),
          sumScore: round(scores.reduce((a, b) => a + b, 0)),
        });
      }
      results.sort((a, b) => a.worstScore - b.worstScore);
      return { ok: true, results, best: results[0] ?? null };
    },
  );

  // ---- optimize (safe, stretch): server-side search over the param space ----
  register(
    'optimize',
    {
      description:
        'Deterministic server-side search over the built-in parametric space. Returns {best:{params, byScenario}, history, evaluations}. Same seed => same result.',
      inputSchema: {
        scenarios: z.array(traceEnum).optional(),
        objective: z.enum(['minWorst', 'minSum']).optional(),
        method: z.enum(['coord-descent', 'random']).optional(),
        budget: z.number().int().positive().max(500).optional(),
        seed: z.number().int().optional(),
        startParams: controllerParamsSchema.optional(),
      },
    },
    async ({ scenarios, objective, method, budget, seed, startParams }) => {
      const scen: TraceName[] = scenarios && scenarios.length ? scenarios : ['scenario1', 'scenario2'];
      const obj = objective ?? 'minWorst';
      let start: ControllerParams = DEFAULT_PARAMS;
      if (startParams) {
        const v = validateParams(startParams);
        if (!v.ok) return { ok: false, error: `startParams: ${v.error}` };
        start = v.params;
      }
      const result = await optimize({
        method: method ?? 'coord-descent',
        budget: budget ?? 100,
        seed: seed ?? 1,
        start,
        evaluate: async (params) => {
          const dep = await deployValidated(params);
          if (!dep.ok) throw new Error(dep.error);
          const byScenario: Record<string, ReturnType<typeof scenarioLine>> = {};
          const scores: number[] = [];
          for (const sc of scen) {
            const line = scenarioLine(persistRun(engine.runScenario(sc, { sampleEvery: 1 }), sc, dep.params));
            byScenario[sc] = line;
            scores.push(line.score);
          }
          const worst = Math.max(...scores);
          const sum = scores.reduce((a, b) => a + b, 0);
          return { objective: obj === 'minSum' ? sum : worst, extra: { byScenario, worstScore: round(worst), sumScore: round(sum) } };
        },
      });
      return {
        ok: true,
        best: { params: result.bestParams, ...result.bestExtra },
        history: result.history,
        evaluations: result.evaluations,
      };
    },
  );

  // ---- analyze_run (safe): bounded server-side analysis ----
  register(
    'analyze_run',
    {
      description:
        'Compact, size-bounded analysis of a stored run (default: last run). include: byBucket | byFan | violationWindows | peaks.',
      inputSchema: {
        runId: z.string().optional(),
        buckets: z.number().int().positive().optional(),
        include: z.array(z.enum(['byBucket', 'byFan', 'violationWindows', 'peaks'])).optional(),
      },
    },
    ({ runId, buckets, include }) => {
      const run = runId ? store.get(runId) : store.latest();
      if (!run) return { ok: false, error: runId ? `run ${runId} not found` : 'no runs yet' };
      const out = analyzeRun(run.result, { buckets, include });
      out.runId = run.runId;
      return out;
    },
  );

  // ---- get_series (safe): downsampled, bounded time series ----
  register(
    'get_series',
    {
      description: 'Downsampled time series for a stored run (default: last). Points-per-field ≤ maxPoints; reports effectiveSampleEvery.',
      inputSchema: {
        runId: z.string().optional(),
        fields: z.array(z.enum(['zoneTemp', 'fanRpm', 'fanPower', 'workload', 'totalPower'])).optional(),
        sampleEvery: z.number().int().positive().optional(),
        tickRange: z.tuple([z.number().int(), z.number().int()]).optional(),
        maxPoints: z.number().int().positive().optional(),
      },
    },
    ({ runId, fields, sampleEvery, tickRange, maxPoints }) => {
      const run = runId ? store.get(runId) : store.latest();
      if (!run) return { ok: false, error: runId ? `run ${runId} not found` : 'no runs yet' };
      return { ...getSeries(run.result, { fields, sampleEvery, tickRange, maxPoints }), runId: run.runId };
    },
  );

  // ---- list_runs (safe) ----
  register(
    'list_runs',
    {
      description: 'List recent runs (most recent first) as compact rows {runId, scenario, score, components, ts}.',
      inputSchema: { limit: z.number().int().positive().optional(), scenario: traceEnum.optional() },
    },
    ({ limit, scenario }) => ({
      ok: true,
      runs: store.list({ limit, scenario }).map((r) => ({
        runId: r.runId,
        scenario: r.scenario,
        score: round(r.result.score),
        components: { thermal: round(r.result.components.thermal), power: round(r.result.components.power) },
        ts: r.ts,
      })),
    }),
  );

  // ---- get_run (safe) ----
  register(
    'get_run',
    { description: 'Fetch a stored run by id as a compact summary.', inputSchema: { runId: z.string() } },
    ({ runId }) => {
      const run = store.get(runId);
      if (!run) return { ok: false, error: `run ${runId} not found` };
      return buildCompact(run.result, run.runId, run.scenario);
    },
  );

  return server;
}
