# Thermal Fan Control Workshop

A thermal simulator with a web-based instrument panel. Your job: write an MCP
server and a Claude Code skill that lets Claude optimize the fan controller.

## Quick Start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser to see the
instrument panel.

## What You're Looking At

The simulator models a device with **2 thermal zones** and **4 fans**. Each zone
has a temperature threshold it shouldn't exceed. Fans consume power (cubic with
RPM) and cool zones based on their physical coupling.

| Zone | Threshold |
|------|-----------|
| A    | 80°C      |
| B    | 70°C      |

Fans are independently controllable (0–5000 RPM).

## How It Works

1. A **workload trace** injects heat into the zones over time
2. The **controller** (`src/controller.ts`) reads temperatures and sets fan RPMs
3. The **score** measures how well the controller performed

## Scoring

```
score = Σ thermal_violations + λ × Σ power
```

- **Thermal violation**: `(temp - threshold)²` per zone per tick when over threshold
- **Power weight (λ)**: `0.1` by default (adjustable in the UI)
- **Lower score = better**

Thermal violations dominate — keeping zones cool is the priority. Power is the
tiebreaker for equally cool solutions.

## The Controller

Edit `src/controller.ts`:

```typescript
export function control(state: SimState, context: Record<string, any>): number[]
```

- `state` — current temperatures, fan RPMs, power readings
- `context` — mutable object that persists across ticks (resets per run)
- Returns an RPM value (0–5000) for each of the 4 fans

The shipped starter is a naive proportional controller that ignores fan-zone
coupling. It works but scores poorly.

## Your Task

1. **Build the MCP server** — `src/mcp-server.ts` has one example tool (`reset`).
   Add tools so Claude Code can deploy controllers, run scenarios, and read results.
2. **Write a Claude Code skill** — teach Claude the iterative optimization
   approach: deploy, run, analyze, improve.
3. **Let Claude optimize** — use the MCP tools to probe the system and iterate
   on the controller.

## MCP Configuration

Once your MCP server is ready, configure Claude Code to connect:

```json
{
  "mcpServers": {
    "fan-control": {
      "type": "sse",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Make sure the server is running (`npm start`) before connecting Claude Code.

## Web UI Controls

- **Scenario** dropdown — select Scenario 1 (practice) or Scenario 2 (official scoring)
- **Trigger Run** — plays the selected scenario trace in real-time
- **Run Scored** — runs the selected scenario instantly and shows the score
- **Reset** — returns simulator to ambient state
- **Speed** (1×/3×/5×) — playback speed for real-time runs only (does not affect scoring)
- **λ** — power weight in the scoring formula

## The Two Scenarios

The device's hardware is fixed — fans have nonlinear airflow and there's a
secondary heat source that can flare up under sustained load. The two scenarios
just differ in the workload they throw at it:

- **Scenario 1 (practice)** — a moderate workload that stays below the load
  level that trips the secondary heat source, so that behavior stays dormant.
  It's still demanding enough that the naive starter overshoots a threshold —
  a good place to learn the fan-zone coupling and get real control working.
- **Scenario 2 (official scoring)** — a heavier, differently-timed workload.
  It sustains enough load to trigger the hardware's harder-to-cool behavior.

The **official score** uses Scenario 2. A controller that only performs well on
Scenario 1 — or that reacts to its specific burst timing — will score worse on
Scenario 2.

## Running Tests

```bash
npm test
```
