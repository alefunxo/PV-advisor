// One scenario, end to end: profiles -> dispatch -> economics.
//
// Extracted from the wizard in milestone 6 because comparison mode needs two of these alive at
// once. Nothing here touches the DOM or formats a string for a human — it takes a plain params
// object and returns numbers, so the same module serves the single-scenario wizard
// (js/main.js) and the two-column comparison (js/compare.js), and can be driven straight from
// a test page.
//
// The two-stage split is the load-bearing part. build() does the expensive work that does not
// depend on which extras are switched on — hourly PV, the temperature series, the base load,
// and all three asset profiles whether or not they are enabled. compute() then only sums the
// enabled series and re-dispatches. Keeping these apart is what makes the results-page toggles
// feel instant; folding them back together would make every toggle a full rebuild.

const Scenario = (() => {
  const ASSET_KEYS = ["hp", "ev", "ac"];

  // Fallbacks cover detail fields belonging to an asset that is switched off: validation skips
  // hidden inputs, so they can still hold something unusable when we reach for them.
  const numOr = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

  function build(p) {
    // The site is a city record from cities.json: it carries the measured yield, seasonal
    // shape and temperatures for its own coordinates.
    const production = PV.hourlyProduction({
      site: p.site,
      kwp: p.kwp,
      tilt: p.tilt,
      aspect: p.aspect,
      performanceRatio: p.performanceRatio,
    });
    const baseLoad = LoadProfiles.baseLoad({ annualKwh: p.annualConsumptionKwh });
    const temps = Climate.hourlyTemperature({ site: p.site });

    const hp = LoadProfiles.heatPumpLoad({
      temps,
      annualHeatKwh: p.hp.mode === "kwh" ? numOr(p.hp.annualHeatKwh, 12000) : null,
      floorAreaM2: numOr(p.hp.floorAreaM2, 140),
      standard: p.hp.standard,
      supplyTempC: numOr(p.hp.supplyTempC, 45),
    });
    const ev = LoadProfiles.evLoad({
      annualKm: numOr(p.ev.annualKm, 12000),
      kwhPer100km: numOr(p.ev.kwhPer100km, 18),
      chargingStrategy: p.ev.chargingStrategy,
    });
    const ac = LoadProfiles.acLoad({
      temps,
      floorAreaM2: numOr(p.ac.floorAreaM2, 80),
      seer: numOr(p.ac.seer, 3),
    });

    return {
      site: p.site,
      country: p.country,
      kwp: p.kwp,
      consumption: p.annualConsumptionKwh,
      production,
      baseLoad,
      batteryKwh: p.batteryKwh,
      roundTripEfficiency: p.roundTripEfficiency,
      pvCapex: p.kwp * p.capexPerKwp,
      batteryCapex: p.batteryKwh * p.batteryCapexPerKwh,
      discountRatePct: p.discountRatePct,
      lifetimeYears: p.lifetimeYears,
      batteryLifetimeYears: p.batteryLifetimeYears,
      econOpts: {
        retailPrice: p.retailPrice,
        feedInTariff: p.feedInTariff,
        tariffEscalationPct: p.tariffEscalationPct,
      },
      // Raw figures only. The sentence a user reads about each asset is the UI's business.
      assets: {
        hp: {
          key: "hp",
          series: hp.series,
          electricityKwh: hp.electricityKwh,
          heatDemandKwh: hp.heatDemandKwh,
          seasonalCOP: hp.seasonalCOP,
        },
        ev: {
          key: "ev",
          series: ev.series,
          electricityKwh: ev.electricityKwh,
          annualKm: numOr(p.ev.annualKm, 12000),
          chargingStrategy: p.ev.chargingStrategy,
        },
        ac: {
          key: "ac",
          series: ac.series,
          electricityKwh: ac.electricityKwh,
          coolingDemandKwh: ac.coolingDemandKwh,
        },
      },
    };
  }

  function compute(m, enabled) {
    const { batteryKwh, roundTripEfficiency, production, baseLoad, econOpts } = m;
    const hasBattery = batteryKwh > 0;
    const capacity = hasBattery ? batteryKwh : 0;

    const active = ASSET_KEYS.filter((k) => enabled[k]).map((k) => m.assets[k]);
    const load = active.length
      ? LoadProfiles.add(baseLoad, ...active.map((a) => a.series))
      : baseLoad;
    const totalConsumption = LoadProfiles.sum(load);

    // Month buckets ride along with the two simulations the economics already need, so the
    // monthly chart costs nothing extra.
    const pvOnly = Dispatch.simulate({
      production,
      load,
      usableCapacityKwh: 0,
      buckets: Aggregate.MONTH_OF_HOUR,
    });
    const withBattery = hasBattery
      ? Dispatch.simulate({
          production,
          load,
          usableCapacityKwh: batteryKwh,
          roundTripEfficiency,
          buckets: Aggregate.MONTH_OF_HOUR,
        })
      : pvOnly;

    // The charts show the system the user is actually testing.
    const chosen = hasBattery ? withBattery : pvOnly;

    // Day profiles come from their own pass over the whole year rather than an isolated
    // 24-hour slice, so the battery arrives at each July morning in the state a July morning
    // really leaves it in.
    const dayFlows = Dispatch.simulate({
      production,
      load,
      usableCapacityKwh: capacity,
      roundTripEfficiency,
      buckets: Aggregate.DAY_PROFILE_OF_HOUR,
    });

    // Per-asset effect: the base household plus this one asset, against the same system, so
    // each figure is attributable to the asset rather than to a resized system.
    const baselineFlows = Dispatch.simulate({
      production,
      load: baseLoad,
      usableCapacityKwh: capacity,
      roundTripEfficiency,
    });
    const assetDeltas = active.map((asset) => {
      const withAsset = Dispatch.simulate({
        production,
        load: LoadProfiles.add(baseLoad, asset.series),
        usableCapacityKwh: capacity,
        roundTripEfficiency,
      });
      return {
        ...asset,
        selfSufficiencyFrom: baselineFlows.selfSufficiencyRate,
        selfSufficiencyTo: withAsset.selfSufficiencyRate,
        extraImport: withAsset.imported - baselineFlows.imported,
        extraSelfConsumed: withAsset.selfConsumed - baselineFlows.selfConsumed,
      };
    });

    const noPv = { selfConsumed: 0, exported: 0, imported: totalConsumption };
    const pvNpv = Economics.npv({
      capex: m.pvCapex,
      flows: pvOnly,
      discountRatePct: m.discountRatePct,
      lifetimeYears: m.lifetimeYears,
      ...econOpts,
    });
    const pvPayback = Economics.simplePaybackYears({
      capex: m.pvCapex,
      flows: pvOnly,
      lifetimeYears: m.lifetimeYears,
      ...econOpts,
    });
    const battery = hasBattery
      ? Economics.batteryIncrement({
          flowsWithout: pvOnly,
          flowsWith: withBattery,
          batteryCapex: m.batteryCapex,
          discountRatePct: m.discountRatePct,
          lifetimeYears: m.lifetimeYears,
          batteryLifetimeYears: m.batteryLifetimeYears,
          ...econOpts,
        })
      : null;

    return {
      enabled,
      hasBattery,
      totalConsumption,
      baselineConsumption: LoadProfiles.sum(baseLoad),
      pvOnly,
      withBattery,
      chosen,
      dayFlows,
      assetDeltas,
      pvNpv,
      pvPayback,
      battery,
      // The whole-system verdict: solar plus, where there is one, the battery on top of it.
      totalNpv: pvNpv + (battery ? battery.npv : 0),
      totalCapex: m.pvCapex + (hasBattery ? m.batteryCapex : 0),
      billNow: Economics.annualBill({ flows: noPv, ...econOpts }),
      billPv: Economics.annualBill({ flows: pvOnly, ...econOpts }),
      billBattery: Economics.annualBill({ flows: withBattery, ...econOpts }),
      cashFlow: {
        years: Array.from({ length: m.lifetimeYears + 1 }, (_, i) => i),
        solar: Economics.cumulativeCashFlow({
          capex: m.pvCapex,
          flows: pvOnly,
          lifetimeYears: m.lifetimeYears,
          ...econOpts,
        }),
        battery: battery
          ? Economics.cumulativeCashFlow({
              capex: m.batteryCapex,
              flows: battery.incrementalFlows,
              lifetimeYears: battery.horizonYears,
              omPctOfCapex: 0,
              ...econOpts,
            })
          : null,
      },
    };
  }

  // Everything that went into the battery, losses included. Direct use + this + exports adds
  // up to production exactly, which is what lets the split chart show honest percentages.
  const batteryThroughput = (f) => f.batteryDischargeToLoad + f.chargeLosses + f.dischargeLosses;

  return { ASSET_KEYS, build, compute, batteryThroughput };
})();
