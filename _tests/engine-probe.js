// Runs inside the wizard's own document, where LoadProfiles / Climate / PV / Dispatch /
// Economics / Scenario / Aggregate are in scope.
//
// It is a file rather than a string inside the suite because it is several hundred lines of
// real JavaScript and escaping that into a template literal is how subtle bugs get in. The
// suite fetches it, evals it in the frame to get this function back, and asserts on the plain
// numbers it returns. Everything here computes; nothing here judges — the PASS/FAIL calls all
// live in suite-engine.html, so a failure names a claim rather than a variable.
//
// The modules are top-level `const`s in classic scripts, so they are global bindings but not
// properties of window. Indirect access would fail; this function's scope chain reaches them.

(async function probe(countryCode, cityName) {
  await PV.load();
  const cities = await (await fetch("js/data/cities.json")).json();
  const list = cities.cities[countryCode];
  const site = list.find((c) => c.name === cityName) || list[0];

  const JAN = { from: 0, to: 31 * 24 };
  const JUL = { from: 181 * 24, to: 212 * 24 };
  const sliceSum = (s, r) => s.slice(r.from, r.to).reduce((a, b) => a + b, 0);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  // ---------------------------------------------------------------- profiles
  const ANNUAL_KWH = 4500;
  const baseLoad = LoadProfiles.baseLoad({ annualKwh: ANNUAL_KWH });
  const temps = Climate.hourlyTemperature({ site });

  const hourOfDayMeans = (series) => {
    const out = new Array(24).fill(0);
    for (let h = 0; h < series.length; h++) out[h % 24] += series[h];
    return out.map((v) => v / (series.length / 24));
  };

  const hp = LoadProfiles.heatPumpLoad({
    temps,
    annualHeatKwh: null,
    floorAreaM2: 140,
    standard: "mid",
    supplyTempC: 45,
  });
  const evDumb = LoadProfiles.evLoad({ annualKm: 12000, kwhPer100km: 18, chargingStrategy: "dumb" });
  const evSolar = LoadProfiles.evLoad({ annualKm: 12000, kwhPer100km: 18, chargingStrategy: "solar" });
  const ac = LoadProfiles.acLoad({ temps, floorAreaM2: 80, seer: 3 });

  // ---------------------------------------------------------------- PV
  const yieldAt = (tilt, aspect) =>
    PV.annualProduction({ site, kwp: 1, tilt, aspect, performanceRatio: 0.86 });
  const production = PV.hourlyProduction({
    site,
    kwp: 6,
    tilt: 35,
    aspect: 0,
    performanceRatio: 0.86,
  });

  // ---------------------------------------------------------------- dispatch
  const KWP = 6;
  const BATTERY = 8;
  const sim = (load, capacity, buckets) =>
    Dispatch.simulate({
      production,
      load,
      usableCapacityKwh: capacity,
      roundTripEfficiency: 0.9,
      buckets: buckets || null,
    });

  const flowsBase = sim(baseLoad, 0);
  const flowsBaseBattery = sim(baseLoad, BATTERY);
  const flowsHp = sim(LoadProfiles.add(baseLoad, hp.series), 0);
  const flowsEvDumb = sim(LoadProfiles.add(baseLoad, evDumb.series), 0);
  const flowsEvSolar = sim(LoadProfiles.add(baseLoad, evSolar.series), 0);
  const flowsAc = sim(LoadProfiles.add(baseLoad, ac.series), 0);

  // Does adding a series to the base load leave the base load alone? LoadProfiles.add is used
  // on every recompute, so a mutation here would quietly accumulate across toggles.
  const baseSumAfterAdds = LoadProfiles.sum(baseLoad);

  const bucketed = sim(baseLoad, BATTERY, Aggregate.MONTH_OF_HOUR);
  const bucketTotals = ["production", "load", "directSelfConsumed", "batteryDischargeToLoad",
    "exported", "imported"].reduce((acc, field) => {
    acc[field] = bucketed.buckets.reduce((sum, b) => sum + b[field], 0);
    return acc;
  }, {});

  // ---------------------------------------------------------------- economics
  const ECON = { retailPrice: 0.28, feedInTariff: 0.08, tariffEscalationPct: 0 };
  const CAPEX = KWP * 1400;
  const npvAt = (retailPrice, capex) =>
    Economics.npv({
      capex,
      flows: flowsBase,
      retailPrice,
      feedInTariff: ECON.feedInTariff,
      discountRatePct: 3,
      lifetimeYears: 25,
    });

  // One year, so the discounting can be checked in closed form rather than by direction.
  const oneYearNpv = Economics.npv({
    capex: 1000,
    flows: flowsBase,
    retailPrice: 0.28,
    feedInTariff: 0.08,
    discountRatePct: 5,
    lifetimeYears: 1,
    omPctOfCapex: 0,
  });
  const oneYearCashFlow = Economics.annualCashFlow({
    flows: flowsBase,
    retailPrice: 0.28,
    feedInTariff: 0.08,
    yearIndex: 0,
    omAnnual: 0,
  });

  const spread = (feedInTariff) =>
    Economics.batteryIncrement({
      flowsWithout: flowsBase,
      flowsWith: flowsBaseBattery,
      batteryCapex: BATTERY * 900,
      retailPrice: 0.28,
      feedInTariff,
      discountRatePct: 3,
      lifetimeYears: 25,
      batteryLifetimeYears: 15,
    });

  const cumulative = Economics.cumulativeCashFlow({
    capex: CAPEX,
    flows: flowsBase,
    retailPrice: 0.28,
    feedInTariff: 0.08,
    lifetimeYears: 25,
  });

  // ---------------------------------------------------------------- scenario
  const params = {
    site,
    kwp: KWP,
    tilt: 35,
    aspect: 0,
    performanceRatio: 0.86,
    annualConsumptionKwh: ANNUAL_KWH,
    batteryKwh: BATTERY,
    roundTripEfficiency: 0.9,
    capexPerKwp: 1400,
    batteryCapexPerKwh: 900,
    discountRatePct: 3,
    lifetimeYears: 25,
    batteryLifetimeYears: 15,
    retailPrice: 0.28,
    feedInTariff: 0.08,
    tariffEscalationPct: 0,
    hp: { mode: "area", floorAreaM2: 140, standard: "mid", supplyTempC: 45 },
    ev: { annualKm: 12000, kwhPer100km: 18, chargingStrategy: "dumb" },
    ac: { floorAreaM2: 80, seer: 3 },
  };

  const modelA = Scenario.build(params);
  const modelB = Scenario.build(params);

  const none = { hp: false, ev: false, ac: false };
  const scenarioNone = Scenario.compute(modelA, none);
  const scenarioHp = Scenario.compute(modelA, { hp: true, ev: false, ac: false });

  // The same dispatch, rolled by hand from the model's own series. If Scenario.compute ever
  // starts doing something extra to the flows it reports, this is what says so.
  const handRolled = Dispatch.simulate({
    production: modelA.production,
    load: modelA.baseLoad,
    usableCapacityKwh: modelA.batteryKwh,
    roundTripEfficiency: modelA.roundTripEfficiency,
  });

  // Two models from one params object must not share mutable state. Computing against A with
  // an asset enabled must leave B untouched.
  Scenario.compute(modelB, { hp: true, ev: true, ac: true });
  const independence = {
    separateArrays: modelA.production !== modelB.production && modelA.baseLoad !== modelB.baseLoad,
    baseLoadSumA: LoadProfiles.sum(modelA.baseLoad),
    baseLoadSumB: LoadProfiles.sum(modelB.baseLoad),
    productionSumA: modelA.production.reduce((a, b) => a + b, 0),
    productionSumB: modelB.production.reduce((a, b) => a + b, 0),
  };

  const flowShape = (f) => ({
    totalProduction: f.totalProduction,
    totalLoad: f.totalLoad,
    directSelfConsumed: f.directSelfConsumed,
    batteryDischargeToLoad: f.batteryDischargeToLoad,
    selfConsumed: f.selfConsumed,
    exported: f.exported,
    imported: f.imported,
    chargeLosses: f.chargeLosses,
    dischargeLosses: f.dischargeLosses,
    selfConsumptionRate: f.selfConsumptionRate,
    selfSufficiencyRate: f.selfSufficiencyRate,
    equivalentFullCycles: f.equivalentFullCycles,
  });

  return {
    site: {
      name: site.name,
      lat: site.lat,
      specificYield35S: site.specificYield35S,
      janMeanC: site.monthlyMeanTempC[0],
      julMeanC: site.monthlyMeanTempC[6],
      monthlyShapeSum: site.monthlyShape.reduce((a, b) => a + b, 0),
    },

    baseLoad: {
      length: baseLoad.length,
      sum: LoadProfiles.sum(baseLoad),
      min: Math.min(...baseLoad),
      janSum: sliceSum(baseLoad, JAN),
      julSum: sliceSum(baseLoad, JUL),
      eveningVsNight: hourOfDayMeans(baseLoad)[19] / hourOfDayMeans(baseLoad)[3],
      sumAfterAdds: baseSumAfterAdds,
    },

    climate: {
      length: temps.length,
      janMean: mean(temps.slice(JAN.from, JAN.to)),
      julMean: mean(temps.slice(JUL.from, JUL.to)),
      diurnalRange: Math.max(...temps.slice(0, 24)) - Math.min(...temps.slice(0, 24)),
      warmestHourOfDay: hourOfDayMeans(temps).indexOf(Math.max(...hourOfDayMeans(temps))),
      heatingDegreeHours: Climate.heatingDegreeHours(temps, LoadProfiles.HEATING_BASE_C),
      coolingDegreeHours: Climate.coolingDegreeHours(temps, LoadProfiles.COOLING_BASE_C),
    },

    cop: {
      atMinus10: LoadProfiles.heatPumpCOP(-10, 45),
      atZero: LoadProfiles.heatPumpCOP(0, 45),
      atPlus10: LoadProfiles.heatPumpCOP(10, 45),
      underfloorAtZero: LoadProfiles.heatPumpCOP(0, 35),
      oldRadiatorsAtZero: LoadProfiles.heatPumpCOP(0, 55),
      clampedLow: LoadProfiles.heatPumpCOP(-50, 45),
      clampedHigh: LoadProfiles.heatPumpCOP(44, 45),
      min: 1.6,
      max: 5.5,
    },

    hp: {
      heatDemandKwh: hp.heatDemandKwh,
      expectedHeatDemandKwh: 140 * LoadProfiles.BUILDING_STANDARDS.mid.kwhPerM2,
      electricityKwh: hp.electricityKwh,
      seasonalCOP: hp.seasonalCOP,
      seriesSum: LoadProfiles.sum(hp.series),
      julShare: sliceSum(hp.series, JUL) / LoadProfiles.sum(hp.series),
      janShare: sliceSum(hp.series, JAN) / LoadProfiles.sum(hp.series),
    },

    ev: {
      dumbKwh: evDumb.electricityKwh,
      solarKwh: evSolar.electricityKwh,
      expectedKwh: (12000 / 100) * 18 * 1.1,
      dumbNoonShare: hourOfDayMeans(evDumb.series)[12] / mean(hourOfDayMeans(evDumb.series)),
      solarNoonShare: hourOfDayMeans(evSolar.series)[12] / mean(hourOfDayMeans(evSolar.series)),
      dumbEveningShare: hourOfDayMeans(evDumb.series)[19] / mean(hourOfDayMeans(evDumb.series)),
    },

    ac: {
      coolingDemandKwh: ac.coolingDemandKwh,
      electricityKwh: ac.electricityKwh,
      seer: 3,
      julShare: LoadProfiles.sum(ac.series) > 0 ? sliceSum(ac.series, JUL) / LoadProfiles.sum(ac.series) : 0,
      janShare: LoadProfiles.sum(ac.series) > 0 ? sliceSum(ac.series, JAN) / LoadProfiles.sum(ac.series) : 0,
    },

    pv: {
      south35: yieldAt(35, 0),
      east35: yieldAt(35, -90),
      west35: yieldAt(35, 90),
      flat: yieldAt(0, 0),
      vertical: yieldAt(90, 0),
      hourlySum: production.reduce((a, b) => a + b, 0),
      expectedAnnual: PV.annualProduction({ site, kwp: KWP, tilt: 35, aspect: 0, performanceRatio: 0.86 }),
      nightIsZero: production.filter((v, h) => h % 24 === 2).every((v) => v === 0),
      junJanRatio: sliceSum(production, { from: 151 * 24, to: 181 * 24 }) / sliceSum(production, JAN),
    },

    flows: {
      base: flowShape(flowsBase),
      baseBattery: flowShape(flowsBaseBattery),
      hp: flowShape(flowsHp),
      evDumb: flowShape(flowsEvDumb),
      evSolar: flowShape(flowsEvSolar),
      ac: flowShape(flowsAc),
    },

    buckets: {
      totals: bucketTotals,
      annual: {
        production: bucketed.totalProduction,
        load: bucketed.totalLoad,
        directSelfConsumed: bucketed.directSelfConsumed,
        batteryDischargeToLoad: bucketed.batteryDischargeToLoad,
        exported: bucketed.exported,
        imported: bucketed.imported,
      },
      count: bucketed.buckets.length,
      capacity: BATTERY,
    },

    economics: {
      npvCheap: npvAt(0.2, CAPEX),
      npvDear: npvAt(0.4, CAPEX),
      npvLowCapex: npvAt(0.28, CAPEX * 0.5),
      npvHighCapex: npvAt(0.28, CAPEX * 2),
      payback: Economics.simplePaybackYears({
        capex: CAPEX,
        flows: flowsBase,
        retailPrice: 0.28,
        feedInTariff: 0.08,
        lifetimeYears: 25,
      }),
      neverPaysBack: Economics.simplePaybackYears({
        capex: CAPEX * 50,
        flows: flowsBase,
        retailPrice: 0.28,
        feedInTariff: 0.08,
        lifetimeYears: 25,
      }),
      degradedYear10: Economics.annualCashFlow({
        flows: flowsBase, retailPrice: 0.28, feedInTariff: 0.08, yearIndex: 10, omAnnual: 0,
      }),
      year0: Economics.annualCashFlow({
        flows: flowsBase, retailPrice: 0.28, feedInTariff: 0.08, yearIndex: 0, omAnnual: 0,
      }),
      escalatedYear10: Economics.annualCashFlow({
        flows: flowsBase, retailPrice: 0.28, feedInTariff: 0.08, yearIndex: 10, omAnnual: 0,
        tariffEscalationPct: 3,
      }),
      oneYearNpv,
      oneYearExpected: -1000 + oneYearCashFlow / 1.05,
      cumulativeFirst: cumulative[0],
      cumulativeLength: cumulative.length,
      capex: CAPEX,
      batteryWideSpread: spread(0.08),
      batteryNoSpread: spread(0.28),
      bill: {
        noPv: Economics.annualBill({
          flows: { selfConsumed: 0, exported: 0, imported: ANNUAL_KWH },
          retailPrice: 0.28, feedInTariff: 0.08,
        }),
        withPv: Economics.annualBill({ flows: flowsBase, retailPrice: 0.28, feedInTariff: 0.08 }),
      },
    },

    scenario: {
      none: {
        totalConsumption: scenarioNone.totalConsumption,
        baselineConsumption: scenarioNone.baselineConsumption,
        hasBattery: scenarioNone.hasBattery,
        withBattery: flowShape(scenarioNone.withBattery),
        pvOnly: flowShape(scenarioNone.pvOnly),
        totalCapex: scenarioNone.totalCapex,
        expectedCapex: KWP * 1400 + BATTERY * 900,
        assetDeltaCount: scenarioNone.assetDeltas.length,
        cashFlowYears: scenarioNone.cashFlow.years.length,
        dayProfileBuckets: scenarioNone.dayFlows.buckets.length,
      },
      hp: {
        totalConsumption: scenarioHp.totalConsumption,
        selfSufficiency: scenarioHp.chosen.selfSufficiencyRate,
        assetDeltaCount: scenarioHp.assetDeltas.length,
        delta: scenarioHp.assetDeltas[0]
          ? {
              key: scenarioHp.assetDeltas[0].key,
              from: scenarioHp.assetDeltas[0].selfSufficiencyFrom,
              to: scenarioHp.assetDeltas[0].selfSufficiencyTo,
              extraImport: scenarioHp.assetDeltas[0].extraImport,
              extraSelfConsumed: scenarioHp.assetDeltas[0].extraSelfConsumed,
            }
          : null,
      },
      handRolled: flowShape(handRolled),
      batteryThroughput: Scenario.batteryThroughput(scenarioNone.withBattery),
      independence,
    },
  };
});
