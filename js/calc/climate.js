// Hourly air-temperature reconstruction for a site.
//
// The lookup table stores twelve monthly mean temperatures per grid point (PVGIS MRcalc,
// 2016-2020 average). Heat pumps and air conditioning both respond to temperature rather than
// to irradiance, and a heat pump's efficiency depends on how cold it is *at the moment it
// runs* — so monthly means alone are not enough and a plausible hourly series is reconstructed
// from them.
//
// What this is not: real weather. There are no cold snaps, no heatwaves, no still winter weeks.
// Peak-day sizing must never be based on this series; it is for annual-energy screening only.

const Climate = (() => {
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // Day-of-year at the centre of each month, where the monthly mean is anchored.
  const MONTH_CENTRES = (() => {
    const centres = [];
    let cumulative = 0;
    for (let m = 0; m < 12; m++) {
      centres.push(cumulative + DAYS_IN_MONTH[m] / 2);
      cumulative += DAYS_IN_MONTH[m];
    }
    return centres;
  })();

  // Typical day/night swing. Real amplitude varies with season, cloud and distance from the
  // coast; a single value keeps the reconstruction honest about its own coarseness.
  const DIURNAL_AMPLITUDE_K = 5;
  const WARMEST_HOUR = 15;

  // Smoothly interpolates the twelve monthly means onto a day-of-year, wrapping December into
  // January so the series has no discontinuity at the year boundary.
  function dailyMeanTemp(monthlyMeans, dayOfYear) {
    const d = dayOfYear - 1;

    let before = 11;
    let after = 0;
    for (let m = 0; m < 12; m++) {
      if (MONTH_CENTRES[m] <= d) before = m;
    }
    after = (before + 1) % 12;

    const cBefore = MONTH_CENTRES[before];
    let cAfter = MONTH_CENTRES[after];
    let position = d;
    if (after === 0) {
      cAfter += 365;
    }
    if (d < MONTH_CENTRES[0]) {
      // Before mid-January: interpolate from mid-December of the previous year.
      return interpolate(
        monthlyMeans[11],
        monthlyMeans[0],
        (d + 365 - MONTH_CENTRES[11]) / (MONTH_CENTRES[0] + 365 - MONTH_CENTRES[11])
      );
    }

    const frac = (position - cBefore) / (cAfter - cBefore);
    return interpolate(monthlyMeans[before], monthlyMeans[after], frac);
  }

  // Cosine easing rather than straight lines, so monthly turning points are rounded instead
  // of kinked.
  function interpolate(a, b, frac) {
    const eased = (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, frac)))) / 2;
    return a + (b - a) * eased;
  }

  function monthlyMeansFor(site) {
    if (!site || !site.monthlyMeanTempC) {
      throw new Error(
        "Climate: expected a city record carrying monthlyMeanTempC — cities.json may " +
          "predate the per-city climate fetch."
      );
    }
    return site.monthlyMeanTempC;
  }

  // 8760 hourly air temperatures (deg C) for a city record from cities.json.
  function hourlyTemperature({ site }) {
    const means = monthlyMeansFor(site);
    const series = new Array(8760);
    for (let h = 0; h < 8760; h++) {
      const dayOfYear = Math.floor(h / 24) + 1;
      const hourOfDay = h % 24;
      const daily = dailyMeanTemp(means, dayOfYear);
      const diurnal =
        DIURNAL_AMPLITUDE_K * Math.cos((2 * Math.PI * (hourOfDay - WARMEST_HOUR)) / 24);
      series[h] = daily + diurnal;
    }
    return series;
  }

  // Degree-hours above/below a base temperature, in K·h. Divide by 24 for degree-days.
  function heatingDegreeHours(temps, baseC) {
    return temps.reduce((sum, t) => sum + Math.max(0, baseC - t), 0);
  }

  function coolingDegreeHours(temps, baseC) {
    return temps.reduce((sum, t) => sum + Math.max(0, t - baseC), 0);
  }

  return {
    hourlyTemperature,
    heatingDegreeHours,
    coolingDegreeHours,
    monthlyMeansFor,
  };
})();
