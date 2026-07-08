// Web server: Node http (serves index.html) + ws (telemetry + commands).
// Also mounts the MCP SSE transport on /mcp.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Engine } from '../internal/engine.js';
import type { RunResult } from '../engine-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebServerOptions {
  port: number;
  engine: Engine;
  /**
   * Factory that builds a fresh McpServer. Called once per SSE session — an
   * McpServer can only be connected to a single transport, so each client
   * connection needs its own instance.
   */
  createMcpServer: () => McpServer;
}

export function createWebServer({ port, engine, createMcpServer }: WebServerOptions) {
  const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');

  // Track active SSE transports for MCP
  const sseTransports = new Map<string, SSEServerTransport>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);

    // MCP SSE endpoint
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        // SSE stream — new MCP session, each with its own McpServer instance
        const transport = new SSEServerTransport('/mcp', res);
        const sessionId = transport.sessionId;
        sseTransports.set(sessionId, transport);

        transport.onclose = () => sseTransports.delete(sessionId);

        // A fresh McpServer per session; it is dereferenced (and GC'd) once its
        // transport closes and is removed from the map above.
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        return;
      }

      if (req.method === 'POST') {
        // MCP message — route to the right transport
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId || !sseTransports.has(sessionId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }));
          return;
        }
        const transport = sseTransports.get(sessionId)!;
        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    // Serve index.html for everything else
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexHtml);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // WebSocket server for live telemetry + commands
  const wss = new WebSocketServer({ server });

  function broadcast(msg: object): void {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // Push telemetry on every engine tick
  engine.onTick((snapshot) => {
    broadcast({ type: 'tick', data: snapshot });
  });

  // Push run complete events
  engine.onRunComplete((result: RunResult) => {
    broadcast({ type: 'runComplete', data: result });
  });

  // Handle incoming WebSocket commands
  wss.on('connection', (ws) => {
    // Send initial state
    ws.send(JSON.stringify({
      type: 'tick',
      data: engine.getLiveSnapshot(),
    }));
    ws.send(JSON.stringify({
      type: 'configUpdate',
      data: { lambda: engine.getLambda() },
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        handleCommand(msg, engine, broadcast);
      } catch {
        // Ignore malformed messages
      }
    });
  });

  server.listen(port, () => {
    console.log(`Fan Control Workshop running at http://localhost:${port}`);
    console.log(`MCP SSE endpoint: http://localhost:${port}/mcp`);
  });

  return server;
}

function handleCommand(
  msg: any,
  engine: Engine,
  broadcast: (msg: object) => void,
): void {
  switch (msg.type) {
    case 'triggerRun': {
      const trace = msg.trace === 'scenario2' ? 'scenario2' : 'scenario1';
      try {
        engine.triggerWorkload(trace);
      } catch (err: any) {
        broadcast({ type: 'error', data: { message: err.message } });
      }
      break;
    }
    case 'runScored': {
      const trace = msg.trace === 'scenario2' ? 'scenario2' : 'scenario1';
      try {
        // runScenario emits runComplete via engine.onRunComplete callback
        engine.runScenario(trace);
      } catch (err: any) {
        broadcast({ type: 'error', data: { message: err.message } });
      }
      break;
    }
    case 'reset':
      try {
        engine.reset();
      } catch (err: any) {
        broadcast({ type: 'error', data: { message: err.message } });
      }
      break;
    case 'setSpeed': {
      const value = Number(msg.value);
      if (!isNaN(value) && value > 0) {
        engine.setRealtimeSpeedMultiplier(value);
      }
      break;
    }
    case 'setLambda': {
      const value = Number(msg.value);
      if (!isNaN(value) && value >= 0) {
        engine.setLambda(value);
        broadcast({
          type: 'configUpdate',
          data: { lambda: engine.getLambda() },
        });
      }
      break;
    }
  }
}
