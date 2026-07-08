# Fan Control Optimization Skill

You are optimizing a thermal fan controller for a simulated device with 2 thermal
zones and 4 fans. Your goal: minimize the score (thermal violations + power cost).

## Approach

Work empirically, not from assumptions. The system has nonlinear dynamics and
non-obvious coupling between fans and zones.

### Phase 1: Probe the System

Before writing any control logic, understand the hardware:

- The coupling between fans and zones is not what physical position suggests.
  Some fans cool zones they aren't "assigned" to more effectively.
- Probe by running experiments: set one fan at a time, observe which zones
  respond and by how much.
- Use `run_custom_scenario` to design targeted probes — e.g. a flat low-workload
  trace paired with a controller that pins a single fan — so you can isolate
  each fan's effect on each zone instead of inferring it from the busy built-in
  scenarios.
- Build a mental model of the airflow graph before writing a controller.

### Phase 2: Iterate on the Controller

Edit `src/controller.ts`, deploy it, run a scenario, and analyze the results.

The `RunResult` from each run tells you:
- Where violations happened (which zone, which tick, how hot)
- Per-fan energy — which fans are burning the most power
- The full time series — watch for overshoot, oscillation, and lag

Use these diagnostics to localize failures. Don't just look at the total score —
find *where* and *why* the controller failed.

### Phase 3: Refine

- Thermal mass means fan changes take several ticks to show up. A purely
  reactive controller will oscillate. Consider accumulating error over time.
- Power scales with RPM cubed. Two fans at moderate RPM cost far less than one
  fan maxed out — spread the load where coupling allows.
- The controller has a `context` object for maintaining state across ticks.

### Don't Overfit

The Scenario 1 (practice) trace and the Scenario 2 (official scoring) trace have
different timing. A controller that pre-cools at hardcoded timestamps will fail
on Scenario 2. Build a controller that reacts to conditions, not to specific
timing.

Use `run_custom_scenario` to stress-test generalization: author traces with
different burst timing, sustained plateaus, and step changes than Scenario 1,
and confirm the controller holds up. If it only performs well on the exact
scenarios you have seen, it is overfit.
