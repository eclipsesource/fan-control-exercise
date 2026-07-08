# Solution Notes (Instructor Only)

**Do not share this file with participants.**

## Coupling Matrix

The fan-zone coupling is asymmetric and is the core puzzle:

| Fan | Home Zone | Coupling to A | Coupling to B |
|-----|-----------|--------------|--------------|
| 0   | A         | 0.9          | 0.2          |
| 1   | A         | 0.3          | **0.7**      |
| 2   | B         | 0.15         | 0.85         |
| 3   | B         | 0.1          | 0.9          |

**Fan 1 is the trap.** It's positioned/labeled as a Zone A fan but actually cools
Zone B more than twice as effectively as it cools Zone A (0.7 vs 0.3 coupling).
The naive starter controller assigns Fan 1 to react to Zone A temperature,
wasting its cooling capacity while Zone B struggles.

A good controller discovers this by probing — e.g., setting each fan to max one
at a time and observing which zones cool.

## Hidden Regimes

These are **always-on physical traits of the device** — not tunable difficulty
settings. Scenario 1's gentle workload simply never pushes the hardware hard
enough for them to matter; Scenario 2's heavier workload does.

### Efficiency Cliff

Above **85% of max RPM** (4250 RPM), effective airflow is multiplied by a
penalty factor that drops quadratically to **0.5× at max RPM**.

```
efficiencyMultiplier = 1.0 - 0.5 * ((rpm/max - 0.85) / 0.15)²
```

Impact: a fan at 100% RPM delivers only half the expected airflow while paying
full cubic power cost. The optimal strategy is to cap fans below ~4000 RPM and
spread load across multiple fans.

Symptoms in RunResult: per-fan power is disproportionately high compared to
cooling effect at high RPM.

Note: this is RPM-driven, not workload-driven, so it *can* bite on Scenario 1 if
a controller over-revs a fan — but Scenario 1's low cooling demand means a sane
controller never needs to.

### Secondary Heat Source

When workload intensity stays above **0.7** for **30+ consecutive ticks** (3s
simulated), a secondary heat source adds **40% extra heat to Zone B**. After
workload drops below 0.7, the secondary source decays over 20 ticks.

Impact: Scenario 1 is deliberately capped below 0.7 throughout, so it never
triggers this. Scenario 2 has a plateau at 0.75 that triggers the secondary heat
source, causing Zone B to overshoot if the controller isn't prepared.

Symptoms in RunResult: Zone B temperature diverges from what the workload alone
would explain at a specific point in the Scenario 2 trace.

## What a Good Controller Discovers

1. **Coupling awareness**: Fan 1 should primarily serve Zone B, not A
2. **Load spreading**: two fans at moderate RPM beat one fan at max (sublinear
   airflow + cubic power)
3. **PID with integral term**: eliminates steady-state error, handles thermal lag
4. **Conservative targets**: aim well below threshold to absorb burst transients
5. **RPM caps**: avoid the efficiency cliff by capping at ~80% max
6. **Preemptive cooling**: detect sustained high workload and pre-cool Zone B
   before the secondary heat activates (matters on Scenario 2)

## Suggested λ Values for Mid-Workshop Demo

| λ     | Effect |
|-------|--------|
| 0.01  | "Cool at all costs" — optimal strategy is aggressive, all fans high |
| 0.1   | Default balance — must optimize both cooling and power |
| 0.5   | "Power matters" — forces creative solutions, smart load spreading |

Flip λ mid-workshop to show how the same controller's score changes and how the
optimal strategy shifts. Good for a 5-minute demo on the tradeoff.
