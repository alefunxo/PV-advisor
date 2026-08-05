// Synthetic hourly load profile generators (8760 h/year).
//
// Milestone 2 scope: base household load only. HP / EV / AC generators land in milestone 4
// and are designed to be *added on top of* the base series returned here, so the combined
// profile is just an element-wise sum (see Section 4.1 of the build plan).
//
// The base shape is an SLP-style residential pattern: a morning peak, a daytime trough, a
// larger evening peak, plus a mild seasonal swing (more lighting/indoor activity in winter)
// and a flatter, later weekend pattern. Shapes are relative — the whole series is rescaled
// so the annual sum equals the user's stated consumption, which is the number they actually
// have from their bill.

const LoadProfiles = (() => {
  // Relative hourly weights, midnight -> 23:00.
  const WEEKDAY_SHAPE = [
    0.55, 0.48, 0.44, 0.42, 0.43, 0.52, 0.78, 1.05, 1.02, 0.88, 0.82, 0.83,
    0.88, 0.84, 0.80, 0.83, 0.95, 1.25, 1.62, 1.72, 1.55, 1.28, 0.98, 0.72,
  ];

  const WEEKEND_SHAPE = [
    0.62, 0.54, 0.48, 0.45, 0.44, 0.48, 0.60, 0.78, 0.96, 1.08, 1.12, 1.10,
    1.08, 1.02, 0.96, 0.96, 1.05, 1.28, 1.58, 1.65, 1.50, 1.30, 1.05, 0.80,
  ];

  // Month index 0-11. Winter months draw more (lighting, indoor time); summer less.
  const MONTHLY_FACTOR = [
    1.15, 1.11, 1.04, 0.96, 0.90, 0.86, 0.85, 0.87, 0.94, 1.03, 1.11, 1.18,
  ];

  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function monthOfDay(dayOfYear) {
    let d = dayOfYear;
    for (let m = 0; m < 12; m++) {
      if (d <= DAYS_IN_MONTH[m]) return m;
      d -= DAYS_IN_MONTH[m];
    }
    return 11;
  }

  // dayOfYear is 1-based. Day 1 is treated as a Monday; the exact weekday alignment of a
  // given calendar year is irrelevant at this resolution, only the 5:2 weekday/weekend mix.
  function isWeekend(dayOfYear) {
    const dow = (dayOfYear - 1) % 7;
    return dow >= 5;
  }

  // Returns an 8760-element array summing to annualKwh.
  function baseLoad({ annualKwh }) {
    const series = new Array(8760);
    let sum = 0;

    for (let h = 0; h < 8760; h++) {
      const dayOfYear = Math.floor(h / 24) + 1;
      const hourOfDay = h % 24;
      const shape = isWeekend(dayOfYear) ? WEEKEND_SHAPE : WEEKDAY_SHAPE;
      const value = shape[hourOfDay] * MONTHLY_FACTOR[monthOfDay(dayOfYear)];
      series[h] = value;
      sum += value;
    }

    if (sum <= 0) return new Array(8760).fill(0);

    const scale = annualKwh / sum;
    return series.map((v) => v * scale);
  }

  // --- Heat pump ---------------------------------------------------------------
  // Space heating only — domestic hot water is not modelled, so a household whose hot water
  // also runs off the heat pump will use more than this suggests.
  //
  // Heat demand follows heating degree hours; electricity is that demand divided by a COP
  // that falls as it gets colder. The COP variation is the point: a fixed COP would overstate
  // exactly the midwinter hours when the heat pump works hardest and the sun is weakest.

  // Typical space-heating intensity by building vintage, kWh of heat per m² per year.
  // The dropdown wording is a catalogue key, not a sentence: this module stays language-free
  // and the UI layer turns the key into words.
  const BUILDING_STANDARDS = {
    old: { labelKey: "building.old", kwhPerM2: 160 },
    mid: { labelKey: "building.mid", kwhPerM2: 105 },
    recent: { labelKey: "building.recent", kwhPerM2: 70 },
    modern: { labelKey: "building.modern", kwhPerM2: 45 },
    passive: { labelKey: "building.passive", kwhPerM2: 25 },
  };

  // Below this outdoor temperature the building needs heat. Internal gains and solar gains
  // cover the gap between this and a ~20 °C indoor target.
  const HEATING_BASE_C = 15;

  // Carnot efficiency actually achieved by a real machine.
  const CARNOT_EFFICIENCY = 0.42;
  const COP_MIN = 1.6;
  const COP_MAX = 5.5;

  function heatPumpCOP(outdoorC, supplyC) {
    const lift = Math.max(5, supplyC - outdoorC);
    const carnot = (supplyC + 273.15) / lift;
    return Math.max(COP_MIN, Math.min(COP_MAX, CARNOT_EFFICIENCY * carnot));
  }

  // Returns { series, heatDemandKwh, electricityKwh, seasonalCOP }.
  //
  // Whether a building needs heat on a given day is decided from the *daily mean* temperature,
  // the standard degree-day convention. Deciding it hour by hour would have the boiler firing
  // on a cool July night, which no real building with any thermal mass does. Within a heating
  // day the heat is then weighted towards the colder hours, and the COP is evaluated at each
  // hour's own temperature.
  function heatPumpLoad({ temps, annualHeatKwh, floorAreaM2, standard, supplyTempC = 45 }) {
    const heatKwh =
      annualHeatKwh != null
        ? annualHeatKwh
        : floorAreaM2 * (BUILDING_STANDARDS[standard] || BUILDING_STANDARDS.mid).kwhPerM2;

    const days = Math.floor(temps.length / 24);
    const dailyDegreeDays = new Array(days);
    let totalDegreeDays = 0;

    for (let d = 0; d < days; d++) {
      let sum = 0;
      for (let h = 0; h < 24; h++) sum += temps[d * 24 + h];
      const dailyMean = sum / 24;
      const dd = Math.max(0, HEATING_BASE_C - dailyMean);
      dailyDegreeDays[d] = dd;
      totalDegreeDays += dd;
    }

    if (totalDegreeDays <= 0 || heatKwh <= 0) {
      return {
        series: new Array(temps.length).fill(0),
        heatDemandKwh: heatKwh,
        electricityKwh: 0,
        seasonalCOP: 0,
      };
    }

    const series = new Array(temps.length).fill(0);
    let electricityKwh = 0;

    for (let d = 0; d < days; d++) {
      if (dailyDegreeDays[d] <= 0) continue;
      const dayHeat = (dailyDegreeDays[d] / totalDegreeDays) * heatKwh;

      // Weight within the day towards colder hours, with a floor so a mild day still spreads
      // its (small) demand rather than collapsing onto a single hour.
      const weights = new Array(24);
      let weightSum = 0;
      for (let h = 0; h < 24; h++) {
        const w = Math.max(0.2, HEATING_BASE_C - temps[d * 24 + h]);
        weights[h] = w;
        weightSum += w;
      }

      for (let h = 0; h < 24; h++) {
        const idx = d * 24 + h;
        const heat = dayHeat * (weights[h] / weightSum);
        const electricity = heat / heatPumpCOP(temps[idx], supplyTempC);
        series[idx] = electricity;
        electricityKwh += electricity;
      }
    }

    return {
      series,
      heatDemandKwh: heatKwh,
      electricityKwh,
      seasonalCOP: electricityKwh > 0 ? heatKwh / electricityKwh : 0,
    };
  }

  // --- Electric vehicle --------------------------------------------------------
  // Two strategies, and the default is deliberately the unflattering one. Defaulting to
  // solar-following charging would quietly inflate self-consumption for every user, including
  // the majority whose car is not at home on a weekday afternoon.

  // Charging weights by hour. "Dumb" charging starts on arrival home and tapers as cars finish.
  const EV_DUMB_SHAPE = [
    0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.01, 0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.02, 0.10, 0.18, 0.18, 0.15, 0.12, 0.07, 0.05,
  ];

  // Solar-following charging concentrates on the middle of the day.
  const EV_SOLAR_SHAPE = [
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.02, 0.08, 0.14, 0.18,
    0.18, 0.16, 0.12, 0.08, 0.04, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
  ];

  // Returns { series, electricityKwh }.
  function evLoad({ annualKm, kwhPer100km = 18, chargingStrategy = "dumb", chargingLossPct = 10 }) {
    const energyAtWheels = (annualKm / 100) * kwhPer100km;
    // Charging losses mean the meter sees more than the battery receives.
    const electricityKwh = energyAtWheels * (1 + chargingLossPct / 100);

    const shape = chargingStrategy === "solar" ? EV_SOLAR_SHAPE : EV_DUMB_SHAPE;
    const shapeSum = shape.reduce((a, b) => a + b, 0);
    const perDay = electricityKwh / 365;

    const series = new Array(8760);
    for (let h = 0; h < 8760; h++) {
      series[h] = (shape[h % 24] / shapeSum) * perDay;
    }

    return { series, electricityKwh };
  }

  // --- Air conditioning --------------------------------------------------------
  // Cooling demand follows cooling degree hours, so it lands in the sunniest months and the
  // sunniest hours. Of the three assets this is the one that genuinely helps the solar case.

  const COOLING_BASE_C = 22;
  // Cooling energy per square metre per degree-hour above the base temperature.
  const COOLING_KWH_PER_M2_KH = 0.00125;

  // Returns { series, coolingDemandKwh, electricityKwh }.
  function acLoad({ temps, floorAreaM2, seer = 3.0 }) {
    const degreeHours = temps.map((t) => Math.max(0, t - COOLING_BASE_C));
    const totalDegreeHours = degreeHours.reduce((a, b) => a + b, 0);
    const coolingDemandKwh = floorAreaM2 * totalDegreeHours * COOLING_KWH_PER_M2_KH;

    if (coolingDemandKwh <= 0) {
      return {
        series: new Array(temps.length).fill(0),
        coolingDemandKwh: 0,
        electricityKwh: 0,
      };
    }

    const electricityKwh = coolingDemandKwh / seer;
    const series = degreeHours.map((dh) => (dh / totalDegreeHours) * electricityKwh);

    return { series, coolingDemandKwh, electricityKwh };
  }

  function sum(series) {
    return series.reduce((a, b) => a + b, 0);
  }

  function add(...seriesList) {
    return seriesList.reduce((acc, s) => acc.map((v, i) => v + s[i]));
  }

  return {
    baseLoad,
    heatPumpLoad,
    evLoad,
    acLoad,
    heatPumpCOP,
    sum,
    add,
    BUILDING_STANDARDS,
    HEATING_BASE_C,
    COOLING_BASE_C,
    WEEKDAY_SHAPE,
    WEEKEND_SHAPE,
    MONTHLY_FACTOR,
  };
})();
