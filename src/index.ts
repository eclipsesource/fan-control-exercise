// Entry point: starts engine, web server, and MCP server.

import { Engine } from './internal/engine.js';
import { createMcpServer } from './mcp-server.js';
import { createWebServer } from './web/server.js';

const PORT = parseInt(process.env.PORT || '3000', 10);

// Create the engine (single simulator instance)
const engine = new Engine();

// Start the web server (serves UI, WebSocket telemetry, and MCP SSE transport).
// The MCP server is built per SSE session (each client connection gets its own
// instance), so we pass a factory rather than a single shared server.
createWebServer({ port: PORT, engine, createMcpServer: () => createMcpServer(engine) });
