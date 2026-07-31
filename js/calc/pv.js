// PV yield calculation — milestone 1 (no battery, no load-profile toggles).
// Uses the precomputed regional-yield.json lookup table (see js/data/regional-yield.json
// for provenance and methodology). No live PVGIS calls — see Section 5 of the build plan
// (PVGIS has no CORS headers, confirmed, so this stays a static precomputed table).

const PV = (() => {
  let table = null;

  async function load(url = "js/data/regional-yield.json") {
    if (table) return table;
    const res = await fetch(url);
    table = await res.json();
    return table;
  }

  function nearestPoint(lat, lon) {
    let best = null;
    let bestDist = Infinity;
    for (const p of table.points) {
      const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (!best) throw new Error("No grid points loaded");
    return best;
  }

  // Interpolates the tilt/azimuth correction factor between the two nearest
  // reference latitude bands (e.g. lat=52 interpolates between the "50" and "60" bands).
  function getTiltAzimuthFactor(lat, tilt, aspect) {
    const bands = Object.keys(table.tiltAzimuthGridsByLatBand)
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

    const f0 = factorFromGrid(table.tiltAzimuthGridsByLatBand[String(b0)], tilt, aspect);
    const f1 = factorFromGrid(table.tiltAzimuthGridsByLatBand[String(b1)], tilt, aspect);
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

  // kWp -> annual production (kWh/year), given site coordinates, orientation, and performance ratio.
  // performanceRatio defaults to the table's reference PR (0.86, PVGIS default 14% loss).
  function annualProduction({ kwp, lat, lon, tilt, aspect, performanceRatio }) {
    const point = nearestPoint(lat, lon);
    const refPR = table.meta.referencePerformanceRatio;
    const pr = performanceRatio ?? refPR;
    const orientationFactor = getTiltAzimuthFactor(lat, tilt, aspect);
    const specificYield = point.specificYield35S * orientationFactor * (pr / refPR);
    return kwp * specificYield;
  }

  return { load, nearestPoint, getTiltAzimuthFactor, annualProduction };
})();
