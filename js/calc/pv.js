// PV yield calculation.
//
// Yield, seasonal shape and temperature are all held per *city* in js/data/cities.json,
// measured by PVGIS at that city's own coordinates. An earlier version snapped cities to a
// 1° grid; in mountainous terrain that put Zürich on an alpine point 8 K colder than the
// city, which wrecked the heat pump and air-conditioning estimates. Do not reintroduce a
// coarse grid lookup for anything temperature-sensitive.
//
// regional-yield.json now carries only the tilt/azimuth correction grids, which vary with
// latitude rather than with local terrain and so remain safe to interpolate.
//
// No live PVGIS calls: PVGIS sends no CORS headers, so a static site cannot reach it.

const PV = (() => {
  let corrections = null;

  async function load(url = "js/data/regional-yield.json") {
    if (corrections) return corrections;
    const res = await fetch(url);
    corrections = await res.json();
    return corrections;
  }

  // A "site" is a city record from cities.json: it must carry specificYield35S, monthlyShape,
  // monthlyMeanTempC and lat/lon.
  function assertSite(site) {
    if (!site || site.specificYield35S == null || !site.monthlyShape) {
      throw new Error(
        "PV: expected a city record with specificYield35S and monthlyShape — " +
          "cities.json may predate the per-city climate fetch."
      );
    }
  }

  // Interpolates the tilt/azimuth correction factor between the two nearest reference
  // latitude bands (e.g. lat=52 interpolates between the "50" and "60" bands).
  function getTiltAzimuthFactor(lat, tilt, aspect) {
    const bands = Object.keys(corrections.tiltAzimuthGridsByLatBand)
      .map(Number)
      .sort((a, b) => a - b);

    const clampedLat = clamp(lat, bands[0], bands[bands.length - 1]);
    let b0 = bands[0];
    let b1 = bands[bands.length - 1];
    for (let i = 0; i < bands.length - 1; i++) {
      if (clampedLat >= bands[i] && clampedLat <= bands[i + 1]) {
        b0 = bands[i];
        b1 = bands[i + 1];
        break;
      }
    }
    const latFrac = b1 === b0 ? 0 : (clampedLat - b0) / (b1 - b0);

    const f0 = factorFromGrid(corrections.tiltAzimuthGridsByLatBand[String(b0)], tilt, aspect);
    const f1 = factorFromGrid(corrections.tiltAzimuthGridsByLatBand[String(b1)], tilt, aspect);
    return f0 + (f1 - f0) * latFrac;
  }

  // Bilinear interpolation over one lat-band's tilt/azimuth correction grid.
  function factorFromGrid(grid, tilt, aspect) {
    const { tilts, aspects, factors } = grid;
    const t = clamp(tilt, tilts[0], tilts[tilts.length - 1]);
    const a = clamp(aspect, aspects[0], aspects[aspects.length - 1]);

    const t0 = lowerBound(tilts, t);
    const t1 = Math.min(t0 + 1, tilts.length - 1);
    const a0 = lowerBound(aspects, a);
    const a1 = Math.min(a0 + 1, aspects.length - 1);

    const tFrac = tilts[t1] === tilts[t0] ? 0 : (t - tilts[t0]) / (tilts[t1] - tilts[t0]);
    const aFrac = aspects[a1] === aspects[a0] ? 0 : (a - aspects[a0]) / (aspects[a1] - aspects[a0]);

    const f00 = factors[tilts[t0]][aspects[a0]];
    const f01 = factors[tilts[t0]][aspects[a1]];
    const f10 = factors[tilts[t1]][aspects[a0]];
    const f11 = factors[tilts[t1]][aspects[a1]];

    const f0 = f00 + (f01 - f00) * aFrac;
    const f1 = f10 + (f11 - f10) * aFrac;
    return f0 + (f1 - f0) * tFrac;
  }

  function lowerBound(arr, v) {
    let idx = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] <= v) idx = i;
    }
    return idx;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // kWp -> annual production (kWh/year) for a given city, orientation and performance ratio.
  function annualProduction({ site, kwp, tilt, aspect, performanceRatio }) {
    assertSite(site);
    const refPR = corrections.meta.referencePerformanceRatio;
    const pr = performanceRatio ?? refPR;
    const orientationFactor = getTiltAzimuthFactor(site.lat, tilt, aspect);
    return kwp * site.specificYield35S * orientationFactor * (pr / refPR);
  }

  // --- Hourly production shape -------------------------------------------------
  // The diurnal shape comes from closed-form solar geometry; the seasonal envelope comes from
  // the city's measured monthly distribution; the annual total is anchored on the measured
  // annual yield. Geometry alone understates winter losses badly and the error grows with
  // latitude (measured June/January ratios run from ~1.5 in Madrid to ~9 in Oslo), so the
  // measured envelope is not optional.
  //
  // Known limitation: a smooth analytic sky has no cloud-driven day-to-day variability, so
  // day-scale surplus swings are understated and battery utilisation is slightly optimistic.

  const DEG = Math.PI / 180;
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const DIFFUSE_FRACTION = 0.18;

  function monthOfDay(dayOfYear) {
    let d = dayOfYear;
    for (let m = 0; m < 12; m++) {
      if (d <= DAYS_IN_MONTH[m]) return m;
      d -= DAYS_IN_MONTH[m];
    }
    return 11;
  }

  function declination(dayOfYear) {
    return 23.45 * DEG * Math.sin(2 * Math.PI * ((284 + dayOfYear) / 365));
  }

  function cosIncidence(phi, delta, omega, beta, gamma) {
    return (
      Math.sin(delta) * Math.sin(phi) * Math.cos(beta) -
      Math.sin(delta) * Math.cos(phi) * Math.sin(beta) * Math.cos(gamma) +
      Math.cos(delta) * Math.cos(phi) * Math.cos(beta) * Math.cos(omega) +
      Math.cos(delta) * Math.sin(phi) * Math.sin(beta) * Math.cos(gamma) * Math.cos(omega) +
      Math.cos(delta) * Math.sin(beta) * Math.sin(gamma) * Math.sin(omega)
    );
  }

  function sinSolarElevation(phi, delta, omega) {
    return Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.cos(omega);
  }

  function hourlyProduction({ site, kwp, tilt, aspect, performanceRatio }) {
    assertSite(site);
    const annual = annualProduction({ site, kwp, tilt, aspect, performanceRatio });
    const phi = site.lat * DEG;
    const beta = tilt * DEG;
    const gamma = aspect * DEG;

    const shape = new Array(8760);
    let shapeSum = 0;

    for (let h = 0; h < 8760; h++) {
      const dayOfYear = Math.floor(h / 24) + 1;
      const hourOfDay = h % 24;
      const delta = declination(dayOfYear);
      // Solar noon assumed at 12:00 local; equation-of-time and longitude offsets are below
      // the resolution this tool claims.
      const omega = 15 * DEG * (hourOfDay + 0.5 - 12);

      const sinElev = sinSolarElevation(phi, delta, omega);
      let value = 0;
      if (sinElev > 0) {
        const beam = Math.max(0, cosIncidence(phi, delta, omega, beta, gamma));
        value = Math.max(0, (1 - DIFFUSE_FRACTION) * beam + DIFFUSE_FRACTION * sinElev);
      }
      shape[h] = value;
      shapeSum += value;
    }

    if (shapeSum <= 0) return new Array(8760).fill(0);

    // Impose the measured seasonal envelope, leaving the geometric diurnal shape within each
    // month intact.
    const rawMonthly = new Array(12).fill(0);
    for (let h = 0; h < 8760; h++) {
      rawMonthly[monthOfDay(Math.floor(h / 24) + 1)] += shape[h];
    }
    const monthFactor = rawMonthly.map((raw, m) =>
      raw > 0 ? (site.monthlyShape[m] * shapeSum) / raw : 0
    );

    let adjustedSum = 0;
    for (let h = 0; h < 8760; h++) {
      shape[h] *= monthFactor[monthOfDay(Math.floor(h / 24) + 1)];
      adjustedSum += shape[h];
    }
    if (adjustedSum <= 0) return new Array(8760).fill(0);

    const scale = annual / adjustedSum;
    return shape.map((v) => v * scale);
  }

  return { load, getTiltAzimuthFactor, annualProduction, hourlyProduction };
})();
