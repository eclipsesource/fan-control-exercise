// MCP server: tools over the engine via SSE transport.
// Ships with only `reset` as an example tool. Participants add the rest.
//
// Reference implementation below includes all 5 tools.
// Before distribution, the instructor strips read_controller, deploy_controller,
// run_scenario, run_custom_scenario, and get_last_run, leaving only reset as a
// pattern to follow.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EngineApi } from './engine-api.js';

export function createMcpServer(engine: EngineApi): McpServer {
  const server = new McpServer({
    name: 'fan-control',
    version: '1.0.0',
  });

  // --- Example tool: reset ---
  server.registerTool(
    'reset',
    {
      description: 'Reset the simulator to its initial state. All zone temperatures return to ambient and all fans stop.',
    },
    async () => {
      try {
        engine.reset();
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }] };
      }
    },
  );

  // --- TODO: Participants implement the tools below ---

  // read_controller: read the current controller source code
  server.registerTool(
    'read_controller',
    {
      description: 'Read the current fan controller source code. Returns the TypeScript source of the control function.',
    },
    async () => {
      const code = engine.readController();
      return { content: [{ type: 'text', text: code }] };
    },
  );

  // deploy_controller: write new controller code and hot-swap it
  server.registerTool(
    'deploy_controller',
    {
      description: 'Deploy a new fan controller. Writes the provided TypeScript source code, reloads it, and validates that it exports a valid control(state, context) function returning an array of 4 RPM values (0-5000). The function receives the current SimState (zone temps, fan RPMs/power) and a mutable context object for maintaining state across ticks.',
      inputSchema: {
        code: z.string()
          .describe('The full TypeScript source code for the controller module. Must export a function: control(state: SimState, context: Record<string, any>): number[]'),
      },
    },
    async ({ code }) => {
      const result = await engine.deployController(code);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // run_scenario: run a scored scenario and return the recording
  server.registerTool(
    'run_scenario',
    {
      description: 'Run a scored scenario through the simulator. The controller is called on every tick. Returns the score breakdown, per-zone peak temps, thermal violations, per-fan energy usage, and an optional per-tick time series. Use sampleEvery to control series resolution (1 = every tick, 10 = every 10th tick, omit or set high to skip series).',
      inputSchema: {
        trace: z.enum(['scenario1', 'scenario2']).default('scenario1')
          .describe('Which workload trace to run. "scenario1" for practice, "scenario2" for official scoring.'),
        sampleEvery: z.number().int().min(1).optional()
          .describe('Downsample the returned series (e.g. 10 = every 10th tick). Omit to get full resolution.'),
      },
    },
    async ({ trace, sampleEvery }) => {
      try {
        const result = engine.runScenario(trace, { sampleEvery });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    },
  );

  // run_custom_scenario: run an agent-authored workload trace
  server.registerTool(
    'run_custom_scenario',
    {
      description: 'Run a custom workload trace you define, through the same scoring path as run_scenario. Useful for probing controller behavior under specific conditions (e.g. a flat plateau, a sharp burst) and for stress-testing generalization beyond the two built-in scenarios. The trace is a list of segments; within each segment the workload intensity ramps linearly from startIntensity to endIntensity over [startTick, endTick). Ticks are dt=0.1s each. Returns the same RunResult as run_scenario.',
      inputSchema: {
        segments: z.array(
          z.object({
            startTick: z.number().int().min(0).describe('Tick this segment begins (inclusive).'),
            endTick: z.number().int().min(1).describe('Tick this segment ends (exclusive).'),
            startIntensity: z.number().min(0).max(1).describe('Workload intensity at startTick (0-1).'),
            endIntensity: z.number().min(0).max(1).describe('Workload intensity at endTick (0-1); ramps linearly from startIntensity.'),
          }),
        ).min(1).describe('Ordered workload segments. Gaps (ticks not covered by any segment) default to intensity 0.'),
        totalTicks: z.number().int().min(1).max(6000).optional()
          .describe('Total ticks to run. Defaults to the largest segment endTick.'),
        sampleEvery: z.number().int().min(1).optional()
          .describe('Downsample the returned series. Omit for full resolution.'),
      },
    },
    async ({ segments, totalTicks, sampleEvery }) => {
      try {
        const result = engine.runCustomScenario(segments, { totalTicks, sampleEvery });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err: any) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
      }
    },
  );

  // get_last_run: re-read the recording of the most recent run
  server.registerTool(
    'get_last_run',
    {
      description: 'Retrieve the results of the most recent scenario run, optionally at a different sample resolution. Useful for getting a summary first (high sampleEvery) then zooming in on failures (sampleEvery=1).',
      inputSchema: {
        sampleEvery: z.number().int().min(1).optional()
          .describe('Downsample the returned series. Omit for full resolution.'),
      },
    },
    async ({ sampleEvery }) => {
      const result = engine.getLastRun({ sampleEvery });
      if (!result) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'No run has been executed yet' }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  return server;
}
