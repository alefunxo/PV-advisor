// Rule-based battery dispatch heuristic (Section 4.3 of the build plan).
//
// This is NOT a solved dispatch. It is a greedy, myopic rule: charge whatever PV surplus
// exists right now, discharge whatever deficit exists right now, within power and capacity
// limits. It has no foresight, no tariff arbitrage, and no grid-services logic — a real
// optimiser would beat it. That is the intended tradeoff for a static screening tool, and
// the results UI must say so.
//
// Operates on plain arrays so it stays independent of the profile generators and of any
// particular timestep count; dt is the timestep length in hours.

const Dispatch = (() => {
  // Simulates PV + optional battery against a load series.
  //
  // production, load : equal-length arrays (kWh per timestep)
  // usableCapacityKwh: usable (not nameplate) energy capacity; 0 disables the battery
  // roundTripEfficiency: applied as sqrt() on each of charge and discharge
  // maxPowerKw       : charge/discharge power limit; defaults to 0.5C
  // buckets          : optional per-step integer group index (e.g. month of hour). When given,
  //                    the same flows are also totalled per group and returned as `buckets`.
  //                    Passing the grouping in rather than deriving it keeps this module free
  //                    of any calendar assumption — see js/calc/aggregate.js for the caller.
  function simulate({
    production,
    load,
    usableCapacityKwh = 0,
    roundTripEfficiency = 0.9,
    maxPowerKw = null,
    dtHours = 1,
    buckets = null,
  }) {
    const n = Math.min(production.length, load.length);
    const etaOneWay = Math.sqrt(roundTripEfficiency);
    const powerLimit = maxPowerKw ?? usableCapacityKwh * 0.5;
    const maxPerStep = powerLimit * dtHours;

    let soc = 0;
    let directSelfConsumed = 0; // PV used by load at the same timestep
    let batteryDischargeToLoad = 0; // PV routed to load via the battery
    let exported = 0;
    let imported = 0;
    let chargeLosses = 0;
    let dischargeLosses = 0;
    let throughputIn = 0; // energy stored, for cycle counting

    let bucketTotals = null;
    if (buckets) {
      const groups = new Set();
      for (let i = 0; i < n; i++) groups.add(buckets[i]);
      bucketTotals = [];
      for (let g = 0; g <= Math.max(...groups); g++) {
        bucketTotals.push({
          production: 0,
          load: 0,
          directSelfConsumed: 0,
          batteryDischargeToLoad: 0,
          exported: 0,
          imported: 0,
        });
      }
    }

    for (let i = 0; i < n; i++) {
      const p = production[i];
      const l = load[i];
      const bucket = bucketTotals ? bucketTotals[buckets[i]] : null;
      if (bucket) {
        bucket.production += p;
        bucket.load += l;
      }

      const direct = Math.min(p, l);
      directSelfConsumed += direct;
      if (bucket) bucket.directSelfConsumed += direct;

      let surplus = p - direct;
      let deficit = l - direct;

      if (usableCapacityKwh > 0) {
        if (surplus > 0) {
          // Charge: limited by power, by remaining headroom, and by conversion losses.
          const headroomIn = (usableCapacityKwh - soc) / etaOneWay;
          const drawn = Math.min(surplus, maxPerStep, headroomIn);
          const stored = drawn * etaOneWay;
          soc += stored;
          chargeLosses += drawn - stored;
          throughputIn += stored;
          surplus -= drawn;
        } else if (deficit > 0) {
          // Discharge: limited by power, by state of charge, and by conversion losses.
          const availableOut = soc * etaOneWay;
          const delivered = Math.min(deficit, maxPerStep, availableOut);
          const drained = delivered / etaOneWay;
          soc -= drained;
          dischargeLosses += drained - delivered;
          batteryDischargeToLoad += delivered;
          if (bucket) bucket.batteryDischargeToLoad += delivered;
          deficit -= delivered;
        }
      }

      exported += surplus;
      imported += deficit;
      if (bucket) {
        bucket.exported += surplus;
        bucket.imported += deficit;
      }
    }

    const totalProduction = production.slice(0, n).reduce((a, b) => a + b, 0);
    const totalLoad = load.slice(0, n).reduce((a, b) => a + b, 0);
    const selfConsumed = directSelfConsumed + batteryDischargeToLoad;

    return {
      totalProduction,
      totalLoad,
      directSelfConsumed,
      batteryDischargeToLoad,
      selfConsumed,
      exported,
      imported,
      chargeLosses,
      dischargeLosses,
      // Share of PV output used on site rather than exported.
      selfConsumptionRate: totalProduction > 0 ? selfConsumed / totalProduction : 0,
      // Share of consumption covered by PV rather than imported.
      selfSufficiencyRate: totalLoad > 0 ? selfConsumed / totalLoad : 0,
      // Full-equivalent cycles per simulated year, for battery lifetime sanity checks.
      equivalentFullCycles: usableCapacityKwh > 0 ? throughputIn / usableCapacityKwh : 0,
      // Same flows totalled per group, or null when no grouping was supplied.
      buckets: bucketTotals,
    };
  }

  return { simulate };
})();
