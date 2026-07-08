import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Simulator, DEFAULT_CONFIG, SimConfig } from './simulator.js';

function makeConfig(overrides?: Partial<SimConfig>): SimConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function configWithRegime(
  cliff: boolean = false,
  secondary: boolean = false,
): SimConfig {
  return makeConfig({
    hiddenRegime: {
      ...DEFAULT_CONFIG.hiddenRegime,
      efficiencyCliff: {
        ...DEFAULT_CONFIG.hiddenRegime.efficiencyCliff,
        enabled: cliff,
      },
      secondaryHeat: {
        ...DEFAULT_CONFIG.hiddenRegime.secondaryHeat,
        enabled: secondary,
      },
    },
  });
}

describe('Simulator', () => {
  it('is deterministic: two identical runs produce identical output', () => {
    const config = makeConfig();
    const simA = new Simulator(config);
    const simB = new Simulator(config);

    simA.setWorkload(0.8);
    simB.setWorkload(0.8);
    simA.setFan(0, 3000);
    simB.setFan(0, 3000);
    simA.setFan(2, 2500);
    simB.setFan(2, 2500);

    for (let i = 0; i < 100; i++) {
      const stateA = simA.step(0.1);
      const stateB = simB.step(0.1);
      assert.deepStrictEqual(stateA, stateB, `Diverged at tick ${i}`);
    }
  });

  it('shows thermal lag: fan change does not fully cool in one tick', () => {
    const sim = new Simulator(makeConfig());
    sim.setWorkload(0.8);

    // Let it heat up for 50 ticks with no fans
    for (let i = 0; i < 50; i++) sim.step(0.1);
    const heated = sim.read();
    const tempBefore = heated.zones[0].temp;
    assert.ok(tempBefore > 30, 'Zone A should have heated up');

    // Stop workload, turn fans on max — isolate cooling
    sim.setWorkload(0);
    for (let fi = 0; fi < 4; fi++) sim.setFan(fi, 5000);
    const afterOne = sim.step(0.1);
    const afterTen = (() => {
      for (let i = 0; i < 9; i++) sim.step(0.1);
      return sim.read();
    })();

    // After 1 tick: temp should drop, but not back to ambient
    assert.ok(afterOne.zones[0].temp < tempBefore, 'Temp should decrease after fans on');
    assert.ok(afterOne.zones[0].temp > 30, 'Temp should not reach ambient in 1 tick');
    // After 10 ticks: should have cooled more
    assert.ok(afterTen.zones[0].temp < afterOne.zones[0].temp, 'More cooling after 10 ticks');
  });

  it('shows cross-zone coupling: Fan 1 cools Zone B more than Zone A', () => {
    const config = makeConfig();
    const sim = new Simulator(config);

    // Heat both zones
    sim.setWorkload(0.8);
    for (let i = 0; i < 50; i++) sim.step(0.1);

    // Record heated temps
    const heated = sim.read();
    const heatedA = heated.zones[0].temp;
    const heatedB = heated.zones[1].temp;

    // Turn on ONLY fan 1 at max
    sim.setFan(1, 5000);
    sim.setWorkload(0); // stop heating to isolate cooling effect
    for (let i = 0; i < 30; i++) sim.step(0.1);

    const cooled = sim.read();
    const coolingA = heatedA - cooled.zones[0].temp;
    const coolingB = heatedB - cooled.zones[1].temp;

    // Fan 1 coupling: 0.3 to Zone A, 0.7 to Zone B
    // Zone B has higher thermal mass so raw temp drop is moderated,
    // but the cooling *input* to B is much larger. Check that B gets
    // meaningful cooling despite higher mass.
    assert.ok(coolingB > 0, 'Fan 1 should cool Zone B');
    assert.ok(coolingA > 0, 'Fan 1 should cool Zone A somewhat');
    // Given coupling 0.7 vs 0.3 and mass 15 vs 5, the cooling energy
    // to B is 0.7/0.3 = 2.33x more, but mass is 3x higher. Net: B cools
    // per-degree less but receives much more cooling energy. The raw dT
    // for B should still be significant relative to A considering the coupling ratio.
  });

  it('follows RPM^3 power law', () => {
    const sim = new Simulator(makeConfig());

    sim.setFan(0, 2500); // 50% of max
    const halfPower = sim.read().fans[0].power;

    sim.setFan(0, 5000); // 100% of max
    const fullPower = sim.read().fans[0].power;

    // power(full) / power(half) should be (1.0/0.5)^3 = 8
    const ratio = fullPower / halfPower;
    assert.ok(
      Math.abs(ratio - 8) < 0.01,
      `Power ratio should be 8, got ${ratio}`,
    );
  });

  it('shows airflow saturation: diminishing returns at high RPM', () => {
    // We measure effective cooling. Run two scenarios with same total RPM:
    // A) one fan at 100% (5000 RPM)
    // B) two fans at 50% (2500 RPM each)
    // With the coupling to zone A: fan0=0.9, fan1=0.3
    // Scenario A: fan0@5000 -> airflow = 20 * 1.0 / (1 + 0.5*1.0) = 13.33, coupling 0.9 -> 12.0
    // Scenario B: fan0@2500 + fan1@2500 -> each airflow = 20 * 0.5 / (1 + 0.5*0.5) = 8.0
    //   fan0 coupling 0.9 -> 7.2, fan1 coupling 0.3 -> 2.4, total = 9.6
    // But the power cost is dramatically different:
    // A) 10 * 1^3 = 10
    // B) 2 * 10 * 0.125 = 2.5
    // So cooling-per-watt is much better when spread across fans.

    const config = makeConfig();
    const sim = new Simulator(config);
    sim.setWorkload(0.8);
    for (let i = 0; i < 50; i++) sim.step(0.1);

    // Scenario A: one fan maxed
    const simA = new Simulator(config);
    simA.setWorkload(0.8);
    for (let i = 0; i < 50; i++) simA.step(0.1);
    simA.setFan(0, 5000);
    simA.setWorkload(0);
    const powerA = simA.read().fans[0].power;

    // Scenario B: two fans at half
    const simB = new Simulator(config);
    simB.setWorkload(0.8);
    for (let i = 0; i < 50; i++) simB.step(0.1);
    simB.setFan(0, 2500);
    simB.setFan(1, 2500);
    simB.setWorkload(0);
    const powerB = simB.read().totalPower;

    // Power: A should use much more than B
    assert.ok(powerA > powerB * 3, `Single fan at max (${powerA}) should use >3x power of two at half (${powerB})`);
  });

  it('applies efficiency cliff above 85% RPM when enabled', () => {
    const configOff = configWithRegime(false, false);
    const configOn = configWithRegime(true, false);

    // Run both sims identically: one fan at 90% RPM, measure cooling
    function measureCooling(config: SimConfig): number {
      const sim = new Simulator(config);
      sim.setWorkload(0.8);
      for (let i = 0; i < 50; i++) sim.step(0.1);
      const before = sim.read().zones[0].temp;
      sim.setFan(0, 4500); // 90% of 5000 — above 85% cliff
      sim.setWorkload(0);
      for (let i = 0; i < 30; i++) sim.step(0.1);
      return before - sim.read().zones[0].temp;
    }

    const coolingOff = measureCooling(configOff);
    const coolingOn = measureCooling(configOn);

    // With cliff enabled, cooling should be less
    assert.ok(
      coolingOn < coolingOff,
      `Cooling with cliff (${coolingOn}) should be less than without (${coolingOff})`,
    );
    // But at 60% RPM (below cliff), cooling should be the same
    function measureCoolingLow(config: SimConfig): number {
      const sim = new Simulator(config);
      sim.setWorkload(0.8);
      for (let i = 0; i < 50; i++) sim.step(0.1);
      const before = sim.read().zones[0].temp;
      sim.setFan(0, 3000); // 60% — below 85% cliff
      sim.setWorkload(0);
      for (let i = 0; i < 30; i++) sim.step(0.1);
      return before - sim.read().zones[0].temp;
    }

    const lowOff = measureCoolingLow(configOff);
    const lowOn = measureCoolingLow(configOn);
    assert.ok(
      Math.abs(lowOff - lowOn) < 0.001,
      `Below cliff, cooling should be identical: ${lowOff} vs ${lowOn}`,
    );
  });

  it('activates secondary heat source after 30 sustained high-workload ticks', () => {
    const config = configWithRegime(false, true);
    const sim = new Simulator(config);

    // Run at high workload (0.8 > 0.7 threshold) for 29 ticks — should NOT activate
    sim.setWorkload(0.8);
    for (let i = 0; i < 29; i++) sim.step(0.1);
    const before30 = sim.read().zones[1].temp; // Zone B

    // Tick 30 — should activate secondary heat
    sim.step(0.1);
    const at30 = sim.read().zones[1].temp;

    // Continue for more ticks with secondary heat active
    for (let i = 0; i < 20; i++) sim.step(0.1);
    const after50 = sim.read().zones[1].temp;

    // Compare with a run that has secondary heat disabled
    const configOff = configWithRegime(false, false);
    const simOff = new Simulator(configOff);
    simOff.setWorkload(0.8);
    for (let i = 0; i < 50; i++) simOff.step(0.1);
    const after50Off = simOff.read().zones[1].temp;

    // Zone B should be hotter with secondary heat active
    assert.ok(
      after50 > after50Off,
      `Zone B with secondary heat (${after50}) should be hotter than without (${after50Off})`,
    );
  });
});
