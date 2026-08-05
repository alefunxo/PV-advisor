// Reads every constant the methodology page quotes back out of the module that actually uses
// it, so the prose can be checked against the code rather than against somebody's memory of
// the code. Runs inside the wizard's document, where the modules are in scope.
//
// Several of these constants are private to their module — CARNOT_EFFICIENCY, the 0.5 C power
// limit, the charging loss, the O&M rate. They are recovered by driving the public function
// with inputs that isolate them, which is better than exporting them for the test's benefit:
// it checks the constant as the engine actually applies it.

(async function probe() {
  await PV.load();
  const cities = await (await fetch("js/data/cities.json")).json();
  const grid = await (await fetch("js/data/regional-yield.json")).json();

  const cityCount = Object.values(cities.cities).reduce((n, list) => n + list.length, 0);
  const largestCountryList = Math.max(...Object.values(cities.cities).map((l) => l.length));

  const findCity = (code, name) => (cities.cities[code] || []).find((c) => c.name === name);
  // The measured June-to-January ratio, straight out of each town's monthly shape. The prose
  // quotes three of these to make the case that geometry alone is not enough.
  const junJan = (code, name) => {
    const c = findCity(code, name);
    return c ? c.monthlyShape[5] / c.monthlyShape[0] : null;
  };

  // --- heat pump ---------------------------------------------------------------
  // COP = carnot × (supply + 273.15) / max(5, supply − outdoor), clamped.
  // At supply 45 / outdoor 5 the lift is 40 and the result is inside the clamps, so the
  // Carnot fraction falls straight out.
  const carnotEfficiency = (LoadProfiles.heatPumpCOP(5, 45) * 40) / (45 + 273.15);

  // --- electric car ------------------------------------------------------------
  // 100 km at 100 kWh/100 km is 100 kWh at the wheels; whatever the meter sees on top is the
  // charging loss.
  const evAtWheels = LoadProfiles.evLoad({ annualKm: 100, kwhPer100km: 100 }).electricityKwh;
  const chargingLossPct = (evAtWheels - 100) * 100 / 100;

  // --- air conditioning --------------------------------------------------------
  // One square metre, one degree-hour above the base, SEER 1.
  const coolingIntensity = LoadProfiles.acLoad({
    temps: [LoadProfiles.COOLING_BASE_C + 1],
    floorAreaM2: 1,
    seer: 1,
  }).coolingDemandKwh;

  // --- dispatch ----------------------------------------------------------------
  // A single hour with more surplus than the battery can take: what it accepts is the power
  // limit, so the C-rate falls out of the ratio.
  const CAPACITY = 8;
  const powerLimited = Dispatch.simulate({
    production: [CAPACITY * 10],
    load: [0],
    usableCapacityKwh: CAPACITY,
    roundTripEfficiency: 1,
  });
  const acceptedKwh = CAPACITY * 10 - powerLimited.exported;
  const cRate = acceptedKwh / CAPACITY;

  // A deliberately terrible round trip, so the one-way split is unmistakable: with 0.25
  // round-trip, an even split means half is lost on the way in.
  const split = Dispatch.simulate({
    production: [1],
    load: [0],
    usableCapacityKwh: 1000,
    roundTripEfficiency: 0.25,
  });
  const oneWayEfficiency = 1 - split.chargeLosses;

  const startsEmpty = Dispatch.simulate({
    production: [0],
    load: [5],
    usableCapacityKwh: 10,
    roundTripEfficiency: 0.9,
  }).batteryDischargeToLoad;

  // --- economics ---------------------------------------------------------------
  const cf = (yearIndex) =>
    Economics.annualCashFlow({
      flows: { selfConsumed: 100, exported: 0 },
      retailPrice: 1,
      feedInTariff: 0,
      yearIndex,
      omAnnual: 0,
    });
  const degradationPctPerYear = (cf(0) - cf(1)) * 100 / cf(0);

  // No flows at all, one year, no discounting: everything left is the maintenance charge.
  const omOnly = Economics.npv({
    capex: 1000,
    flows: { selfConsumed: 0, exported: 0 },
    retailPrice: 1,
    feedInTariff: 0,
    discountRatePct: 0,
    lifetimeYears: 1,
  });
  const omPctOfCapex = (-omOnly - 1000) * 100 / 1000;

  // End-of-year discounting: one year at 100% would halve a mid-year convention differently.
  const oneYear = Economics.npv({
    capex: 0,
    flows: { selfConsumed: 100, exported: 0 },
    retailPrice: 1,
    feedInTariff: 0,
    discountRatePct: 100,
    lifetimeYears: 1,
    omPctOfCapex: 0,
  });
  const discountExponentAtYearOne = Math.log(100 / oneYear) / Math.log(2);

  // The battery's earnings are the spread, not the retail price.
  const noSpread = Economics.batteryIncrement({
    flowsWithout: { selfConsumed: 100, exported: 100 },
    flowsWith: { selfConsumed: 150, exported: 50 },
    batteryCapex: 0,
    retailPrice: 0.3,
    feedInTariff: 0.3,
    discountRatePct: 0,
    lifetimeYears: 1,
  }).year1Benefit;

  // --- climate -----------------------------------------------------------------
  const site = findCity("CH", "Zürich") || Object.values(cities.cities)[0][0];
  const temps = Climate.hourlyTemperature({ site });
  const firstDay = temps.slice(0, 24);
  const diurnalAmplitude = (Math.max(...firstDay) - Math.min(...firstDay)) / 2;
  const warmestHour = firstDay.indexOf(Math.max(...firstDay));

  // --- load profile -------------------------------------------------------------
  const seasonalHigh = Math.max(...LoadProfiles.MONTHLY_FACTOR);
  const seasonalLow = Math.min(...LoadProfiles.MONTHLY_FACTOR);

  return {
    hoursInYear: LoadProfiles.baseLoad({ annualKwh: 1 }).length,
    cityCount,
    largestCountryList,

    buildingIntensities: Object.fromEntries(
      Object.entries(LoadProfiles.BUILDING_STANDARDS).map(([k, v]) => [k, v.kwhPerM2])
    ),
    heatingBaseC: LoadProfiles.HEATING_BASE_C,
    coolingBaseC: LoadProfiles.COOLING_BASE_C,
    coolingIntensity,
    carnotEfficiency,
    copMin: LoadProfiles.heatPumpCOP(-273, 45),
    copMax: LoadProfiles.heatPumpCOP(44, 45),
    chargingLossPct,

    cRate,
    oneWayEfficiency,
    expectedOneWay: Math.sqrt(0.25),
    batteryStartsEmpty: startsEmpty === 0,

    degradationPctPerYear,
    omPctOfCapex,
    discountExponentAtYearOne,
    batteryNoSpreadBenefit: noSpread,

    diurnalAmplitude,
    warmestHour,
    seasonalHigh,
    seasonalLow,

    referenceTilt: grid.meta.referenceTilt,
    referencePerformanceRatio: grid.meta.referencePerformanceRatio,
    referenceSystemLossPct: grid.meta.referenceSystemLossPct,
    referenceMounting: grid.meta.referenceMounting,
    referenceHorizon: String(grid.meta.referenceHorizon),
    latitudeBands: Object.keys(grid.tiltAzimuthGridsByLatBand).map(Number).sort((a, b) => a - b),
    pointsPerBand: Object.values(grid.meta.referenceBandPoints).map((p) => p.length),

    junJanMadrid: junJan("ES", "Madrid"),
    junJanOslo: junJan("NO", "Oslo"),
  };
});
