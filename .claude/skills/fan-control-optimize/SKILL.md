---
name: fan-control-optimize
description: Optimize/tune the fan controller for the fan-control thermal simulator. Use when asked to improve the controller's score, tune fan-control parameters, or drive the fan-control optimization loop. Instructions + verified rig facts only; all compute is in the MCP tools.
---

# Optimizing the fan-control simulator

Guidance + a cheat-sheet for tuning the fan controller. **All computation lives
in the MCP tools** — this skill is instructions and verified facts only, never
scripts. Never use Bash for analysis: the server does it and returns bounded JSON.

## When to use

Optimizing / tuning the fan controller for the **fan-control simulator** (improve
the score, reduce thermal violations or power).

## Simulator cheat-sheet (verified facts)

- **State** each tick: `{ t, zones:[{temp}], fans:[{rpm,power}], totalPower }`.
  There is **no workload input exposed** — infer load from the temperature slope
  (store previous temp in `context`).
- **Score = thermal + power** (lower is better):
  - `thermal = Σ_zones Σ_(ticks over threshold) (temp − threshold)²` — per tick
    over all 600 ticks, **no dt**.
  - `power  = Σ_fans Σ_ticks 10·(rpm/5000)³ · dt`, `dt = 0.1`. Cubic ⇒ high rpm
    is *very* expensive.
- **Thresholds: zone0 = 80 °C, zone1 = 70 °C.** (Hardcoded in the server as
  `ZONE_THRESHOLDS`; the engine does not expose them.)
- **Fan → zone mapping:** fans 0,1 → zone0, fans 2,3 → zone1. Weak cross-coupling
  (zone1's airflow slightly helps zone0).
- **Fans self-heat.** Their cubic power dumps heat into the zone, so net cooling
  **peaks near ~3600 rpm**; running at 5000 cools *less* and costs ~8× the power.
  A brief burst to ~4200 helps a short transient peak, but a max-rpm burst
  **backfires on a sustained peak**. RPM is hard-capped at 5000.
- **Scenarios are deterministic.** Naive-starter baselines: scenario1 ≈ 362,
  scenario2 ≈ 6435. **Scenario2 is the hard one** (official score); it sustains
  load long enough to trip a secondary heat source. Its practical floor is
  ~350 — zone0 physically peaks ~81 °C at the sustained load.

*(These numbers are for the current rig. The MCP tool code stays the same across
hardware; only this cheat-sheet is re-derived.)*

## Built-in parametric controller

The server ships a parametric control law you tune with **numbers only** via
`run_params` / `evaluate_params` / `optimize` (no code, no confirmation prompts).
Per zone (fans 0,1 → zone0, 2,3 → zone1):

```ts
ZoneParams = { spUp, spDown, kp, kd, cap }   // direction-aware setpoint, P+D gains, rpm cap
ControllerParams = { zones:[ZoneParams,ZoneParams], emaAlpha, slopeRisingThreshold }
```

The server's default params are a **neutral** PD starting point, not the answer.

## Recommended starting point (known-good: sc1 ≈ 296, sc2 ≈ 351)

```jsonc
{
  "zones": [
    { "spUp": 50, "spDown": 62, "kp": 320, "kd": 1800, "cap": 4200 },
    { "spUp": 44, "spDown": 64, "kp": 160, "kd": 800,  "cap": 3400 }
  ],
  "emaAlpha": 0.6,
  "slopeRisingThreshold": 0.01
}
```

Each lever:
- **spUp / spDown** — direction-aware setpoint. High `spUp` = little cooling while
  temperature rises and there's headroom (saves cubic power); coast on a higher
  `spDown` past the peak to save tail power.
- **kp** — proportional pull toward the setpoint.
- **kd** — derivative on the smoothed slope; **strong kd anticipates fast rises**
  and pre-cools the ~100 ticks before a peak.
- **cap** — max rpm; keep near the **~3600–4200 cooling optimum**, not 5000.
- **emaAlpha** — slope smoothing; **slopeRisingThreshold** — slope above which the
  "rising" setpoint applies.

## Tool playbook (the loop)

1. `reset`.
2. `evaluate_params` — a small grid around the starting point, across
   **both** scenarios. Read the ranked table (sorted by worst-case score).
3. `analyze_run` on the leader's runId:
   - `violationWindows` → where thermal comes from (which zone, which ticks).
   - `byBucket` (energy vs. phase) → where power is wasted.
   - `peaks` → per-zone peak tick/temp.
4. Refine the grid toward the leader, or call `optimize`
   (`objective:"minWorst"`, `method:"coord-descent"`, a modest `budget`, fixed
   `seed`) to search server-side.
5. Re-check the winner on both scenarios; confirm it's not overfit to scenario1.

Prefer **batch** (`evaluate_params`/`optimize`) over one run at a time. Analysis
is built in — **never** shell out to `jq`/Python.

## Known dead-ends (don't repeat)

- **All-fans-max / cap ≥ 4600 / dynamic 5000 bursts** — self-heating makes zone0
  *hotter* on the sustained scenario2 peak, and costs ~8× the power. Verified.
- **Too-low gains** — overshoot the threshold before reacting.
- **Deep early pre-cooling** — wasted; thermal memory is short, so cooling long
  before a peak doesn't help.
- **Tuning only on scenario1** — it never trips the secondary heat source;
  scenario2 is where the score is won or lost.
