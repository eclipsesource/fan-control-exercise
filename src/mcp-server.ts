// MCP server: tools over the engine via SSE transport.
//
// Ships with only `reset` as an example. Your task is to add the tools that let
// Claude Code drive the optimization loop. Build them against the engine's
// public API in `src/engine-api.ts` (the `EngineApi` interface) — that file
// documents every operation and data shape you need.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { EngineApi } from './engine-api.js';

export function createMcpServer(engine: EngineApi): McpServer {
  const server = new McpServer({
    name: 'fan-control',
    version: '1.0.0',
  });

  // --- Example tool: reset ---
  // Follow this pattern for the tools you add:
  //   server.registerTool(name, { description, inputSchema }, handler)
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

  // --- TODO: add your tools here ---
  // The EngineApi (see src/engine-api.ts) exposes:
  //   readController()            — read the current controller source
  //   deployController(code)      — write + hot-reload a new controller
  //   runScenario(trace)          — run a scored scenario ('scenario1' | 'scenario2')
  //   runCustomScenario(segments) — run a workload trace you define
  //   getLastRun()                — re-read the most recent run's result
  // Use `z` (zod) to declare each tool's inputSchema.

  return server;
}
