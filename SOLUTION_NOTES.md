# Solution Notes (Instructor Only)

**Do not share this file with participants.**

## The device

- **Zone A** — threshold 80°C, low thermal mass (fast), the **binding constraint**
  (nearly all thermal penalty comes from here).
- **Zone B** — threshold 70°C, high thermal mass (slow), lots of headroom — but it
  is the target of the secondary heat source (see below).

## Coupling matrix + per-fan strength

The core puzzle is that the fans differ in **both** which zone they cool (coupling)
**and** how much air they move (`airflowCoefficient`):

| Fan | Labeled | airflowCoefficient | Coupling → A | Coupling → B |
|-----|---------|--------------------|--------------|--------------|
| 0   | Zone A  | 36                 | 0.9          | 0.2          |
| 1   | Zone A  | **46 (strongest)** | 0.3          | **0.7**      |
| 2   | Zone B  | 33                 | 0.15         | 0.85         |
| 3   | Zone B  | 33                 | 0.1          | 0.9          |

**Fan 1 is the trap, doubly so.** It is labeled/positioned as a Zone-A fan, but it
(a) cools Zone B far more effectively than Zone A (0.7 vs 0.3) **and** (b) is the
single **most powerful** fan. The naive starter pours its strongest fan into Zone A
at 0.3 coupling — a large wasted-capacity sink — while Zone B is left to the weaker
fans 2/3. Discovering "route fan 1 → Zone B" is the highest-value move, and it's
easy to detect by probing (its effect is large).

## Device cooling capacity

The hardware **can** cool a full sustained load (workload 1.0) — but only if run
well. At all four fans ≈4250 RPM (the airflow-efficiency peak), Zone A settles at
~**79.9°C** (just under 80). But:

- At ~4000 RPM it **fails** (~82.6°C) — not enough airflow.
- At 5000 RPM it **fails** (~108°C) — the efficiency cliff halves airflow.

So there is a **narrow ~4200–4250 RPM operating band** at high load: below it you
starve, above it you fall off the cliff. Getting the RPM right is essential.

## Hidden regimes (always-on physical traits, not difficulty settings)

### Efficiency cliff

Above **85% of max RPM (4250)**, effective airflow is multiplied by a penalty that
drops quadratically to **0.5× at 5000 RPM**:

```
efficiencyMultiplier = 1.0 - 0.5 * ((rpm/max - 0.85) / 0.15)²
```

Effective airflow therefore **peaks at ~4250 RPM** and *falls* above it. Running
flat-out cools *less* while paying full cubic power. Optimal: keep fans at/below
~4250 and spread load across fans (two moderate beat one maxed — sublinear airflow
+ cubic power).

### Secondary heat source

When workload stays **≥0.7 for 30+ consecutive ticks (3s)**, a secondary source
adds **40% extra heat to Zone B**; it decays over 20 ticks once workload drops
below 0.7. Scenario 1 keeps every ≥0.7 excursion under 30 ticks, so it never fires
there; Scenario 2's sustained **0.8 plateau** (ticks 160–230) fires it, driving
Zone B up if the controller isn't cooling B hard enough.

## The two scenarios

- **Scenario 1 (practice)** — gentle, with two short spikes (~0.85 and ~0.88, each
  <30 ticks at ≥0.7, so no secondary heat). A competent controller holds it easily
  with margin to spare. Its role is learning the basics + power efficiency.
- **Scenario 2 (official)** — harder: bursts to 0.85 / 0.97 / 0.92 and a sustained
  0.8 plateau that trips the secondary heat source. Solvable, but demands using all
  four fans, capping near 4250, routing fan 1 to Zone B, and handling the Zone-B
  secondary heat.

## The shipped starter's flaw

The starter aims **at** the thresholds (`limits = [80, 70]`), so a proportional
controller only produces cooling *after* a zone is already over — it perpetually
rides in violation. It overheats **both** scenarios (S1 ≈ 269 violations, S2 ≈ 464).
The first fix a participant should find is to **leave margin** (aim below the
threshold to absorb thermal lag); that alone clears Scenario 1.

## What a good controller discovers

1. **Leave margin** — aim below the thresholds; proportional-at-the-limit rides over.
2. **Coupling awareness** — route the strong fan 1 to Zone B (0.7), not Zone A (0.3).
3. **Use all four fans** — even the "wrong-zone" fans contribute (fans 2/3 help A at
   0.15/0.10; fan 0 helps B at 0.2).
4. **Cap near ~4250** — the airflow peak; never blast to 5000 (cliff).
5. **Load spreading** — cubic power makes many-moderate far cheaper than few-maxed.
6. **Integral term** — kills proportional-only steady-state error; handles lag.
7. **Handle the secondary heat** — cool Zone B through the Scenario-2 0.8 plateau.

## Suggested λ values for mid-workshop demo

| λ     | Effect |
|-------|--------|
| 0.01  | "Cool at all costs" — aggressive, all fans high |
| 0.1   | Default balance — optimize cooling and power together |
| 0.3   | "Power matters" — rewards load-spreading and using the efficient fans; keep at or below this, since higher λ starts rewarding *accepting* thermal violations to save power |

Flip λ mid-workshop to show how the optimal strategy shifts. Note: on Scenario 1 a
reasonable controller is already near power-optimal, so raising λ mostly scales the
score without changing the ranking; the λ tradeoff is most visible on Scenario 2.
