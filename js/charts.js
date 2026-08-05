// Results-dashboard charts (milestone 5), built on the vendored Chart.js in js/vendor/.
//
// Colour is assigned by *entity*, once, and every chart reuses that assignment — blue is
// always solar used in the house, aqua is always solar that went through the battery, orange
// is always electricity bought from the grid, yellow is always solar exported. A reader who
// learns a colour on one chart keeps it on the next.
//
// Those four hues are the reference categorical slots 1-4, and the sets were checked with the
// palette validator rather than judged by eye. Each plot clears the strictest (all-pairs)
// gate on its own set in both light and dark mode:
//
//   monthly stack   blue / aqua / orange   CVD ΔE 9.2 light, 9.4 dark   (normal 24.0 / 20.9)
//   energy split    blue / aqua / yellow   CVD ΔE 9.1 light, 8.4 dark   (normal 22.9 / 19.8)
//
// Orange and yellow are the one pair that fails when measured together, so they are never put
// in the same plot — grid-import and export appear in different cards, each with its legend.
// In light mode aqua (2.8:1) and yellow (2.2:1) sit below 3:1 against the surface, which
// obliges the documented relief: every series carries a legend entry, and the same figures are
// repeated as text in the results lists, so no value is reachable only by colour.
//
// The values are read from CSS custom properties rather than hardcoded here, so light and dark
// swap in one place (css/style.css) and the chart body stays written against roles.

const Charts = (() => {
  const instances = new Map();

  // Series names are the only words in this file. It sits in the UI layer, not the calc layer,
  // so it reads them from the catalogue directly rather than having every caller thread eleven
  // labels through. The caller re-renders on a language change exactly as it does on a theme
  // change — a canvas cannot restyle or relabel itself.
  // (`t` is already taken here for the resolved theme, so the catalogue helper is `tr`.)
  const tr = (key) => I18n.t(key);

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function theme() {
    return {
      solar: cssVar("--c-solar"),
      battery: cssVar("--c-battery"),
      grid: cssVar("--c-grid"),
      exported: cssVar("--c-exported"),
      surface: cssVar("--bg"),
      ink: cssVar("--fg"),
      inkSecondary: cssVar("--muted"),
      gridline: cssVar("--chart-gridline"),
      axis: cssVar("--border"),
    };
  }

  // Area fills are a wash, not a block — the line carries the identity.
  function wash(hex, alpha) {
    const h = hex.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function baseOptions(t, { money = false, fmt }) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 4 } },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            // Identity rides a coloured key beside text in an ink token — never coloured text.
            color: t.inkSecondary,
            boxWidth: 10,
            boxHeight: 10,
            usePointStyle: true,
            pointStyle: "circle",
            padding: 14,
            font: { size: 12 },
          },
        },
        tooltip: {
          backgroundColor: t.ink,
          titleColor: t.surface,
          bodyColor: t.surface,
          padding: 10,
          cornerRadius: 6,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          usePointStyle: true,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y ?? ctx.parsed)}`,
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          border: { color: t.axis },
          grid: { display: false },
          // Rotated tick labels are unreadable at this size; thin them out instead.
          ticks: { color: t.inkSecondary, font: { size: 11 }, autoSkip: true, maxRotation: 0 },
        },
        y: {
          stacked: true,
          beginAtZero: !money,
          border: { display: false },
          // Recessive hairline grid, solid — never dashed.
          grid: { color: t.gridline, lineWidth: 1, drawTicks: false },
          ticks: {
            color: t.inkSecondary,
            font: { size: 11 },
            padding: 6,
            maxTicksLimit: 6,
            callback: (v) => fmt(v),
          },
        },
      },
    };
  }

  function render(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (instances.has(canvasId)) instances.get(canvasId).destroy();
    instances.set(canvasId, new Chart(canvas.getContext("2d"), config));
  }

  // --- 1. Where your electricity came from, month by month ----------------------
  // Bar height is that month's consumption; the split is how it was met. This is the chart
  // that makes the European winter legible — the orange band swells exactly when the roof
  // has least to give.
  // yMax pins the axis so two of these can be read against each other. Side-by-side charts
  // that auto-scale independently are worse than no chart: the taller bars in the smaller
  // system look like more energy. Comparison mode passes the larger of the two maxima.
  function monthly(canvasId, { labels, direct, battery, grid, hasBattery, kwhFmt, yMax = null }) {
    const t = theme();
    const series = [
      { label: tr("chart.series.direct"), data: direct, color: t.solar },
      ...(hasBattery
        ? [{ label: tr("chart.series.viaBattery"), data: battery, color: t.battery }]
        : []),
      { label: tr("chart.series.imported"), data: grid, color: t.grid },
    ];

    render(canvasId, {
      type: "bar",
      data: {
        labels,
        datasets: series.map((s, i) => ({
          label: s.label,
          data: s.data,
          backgroundColor: s.color,
          // A 2px gap in the surface colour separates touching segments; the top segment
          // carries the rounded data-end, and every segment stays square at the baseline.
          borderColor: t.surface,
          borderWidth: { top: i === series.length - 1 ? 0 : 2, left: 0, right: 0, bottom: 0 },
          borderRadius: i === series.length - 1 ? { topLeft: 4, topRight: 4 } : 0,
          borderSkipped: false,
          maxBarThickness: 24,
        })),
      },
      options: (() => {
        const o = baseOptions(t, { fmt: kwhFmt });
        if (yMax != null) o.scales.y.suggestedMax = yMax;
        return o;
      })(),
    });
  }

  // --- 2. Where the year's solar output went ------------------------------------
  // The three slices sum to production exactly, which is why the battery slice is everything
  // that went *into* the battery rather than what came back out of it: the round-trip losses
  // are solar output too, and dropping them would leave a doughnut whose arcs silently imply
  // they add up to the whole when they do not. The breakdown of that slice — what returned
  // and what was lost — is in the results list beside the chart.
  //
  // A fourth slice for the losses was tried and abandoned: no fourth hue clears the
  // colour-vision gates against these three on the dark surface (the best candidate, violet,
  // measures ΔE 1.9 against the blue).
  function split(canvasId, { direct, throughBattery, exported, kwhFmt }) {
    const t = theme();
    const slices = [
      { label: tr("chart.slice.direct"), value: direct, color: t.solar },
      { label: tr("chart.slice.stored"), value: throughBattery, color: t.battery },
      { label: tr("chart.slice.exported"), value: exported, color: t.exported },
    ];
    const total = slices.reduce((a, s) => a + s.value, 0);
    const share = (v) => (total > 0 ? `${Math.round((v / total) * 100)}%` : "0%");

    render(canvasId, {
      type: "doughnut",
      data: {
        labels: slices.map((s) => s.label),
        datasets: [
          {
            data: slices.map((s) => s.value),
            backgroundColor: slices.map((s) => s.color),
            borderColor: t.surface,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: t.inkSecondary,
              boxWidth: 10,
              boxHeight: 10,
              usePointStyle: true,
              pointStyle: "circle",
              padding: 14,
              font: { size: 12 },
              // The share rides in the legend rather than only in the tooltip: a hover is not
              // a way to read a value on a touch screen, and it is the percentages people
              // came to this chart for.
              generateLabels: (chart) =>
                slices.map((s, i) => ({
                  text: `${s.label} — ${share(s.value)}`,
                  fillStyle: s.color,
                  strokeStyle: s.color,
                  lineWidth: 0,
                  pointStyle: "circle",
                  hidden: false,
                  index: i,
                })),
            },
          },
          tooltip: {
            backgroundColor: t.ink,
            titleColor: t.surface,
            bodyColor: t.surface,
            padding: 10,
            cornerRadius: 6,
            usePointStyle: true,
            boxWidth: 8,
            boxHeight: 8,
            callbacks: {
              label: (ctx) => `${ctx.label}: ${kwhFmt(ctx.parsed)} (${share(ctx.parsed)})`,
            },
          },
        },
      },
    });
  }

  // --- 3. A typical day ---------------------------------------------------------
  // Solar as a washed line, household demand as a neutral reference line on top of it. The
  // gap between them is the whole screening question, drawn: where demand sits above the
  // curve you are importing, where the curve sits above demand you are exporting.
  function dayProfile(canvasId, { hours, production, load, kwhFmt }) {
    const t = theme();
    render(canvasId, {
      type: "line",
      data: {
        labels: hours,
        datasets: [
          {
            label: tr("chart.series.production"),
            data: production,
            borderColor: t.solar,
            backgroundColor: wash(t.solar, 0.1),
            borderWidth: 2,
            fill: "origin",
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: t.surface,
          },
          {
            label: tr("chart.series.load"),
            data: load,
            borderColor: t.inkSecondary,
            borderWidth: 2,
            fill: false,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: t.surface,
          },
        ],
      },
      options: (() => {
        const o = baseOptions(t, { fmt: kwhFmt });
        o.scales.x.stacked = false;
        o.scales.y.stacked = false;
        o.scales.x.ticks.maxTicksLimit = 7;
        o.elements = { line: { capBezierPoints: true } };
        return o;
      })(),
    });
  }

  // --- 4. Money over the system's life ------------------------------------------
  // Undiscounted running total, so the line crosses zero at the payback year reported beside
  // it. The battery is plotted on its own incremental basis — its own cost against the extra
  // saving it alone unlocks — which is how its NPV is computed.
  function cashFlow(canvasId, { years, solar, battery, moneyFmt }) {
    const t = theme();
    const datasets = [
      {
        label: tr("chart.series.pvSystem"),
        data: solar,
        borderColor: t.solar,
        backgroundColor: t.solar,
        borderWidth: 2,
        fill: false,
        tension: 0,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: t.surface,
      },
    ];
    if (battery) {
      datasets.push({
        label: tr("chart.series.batteryOnTop"),
        data: battery,
        borderColor: t.battery,
        backgroundColor: t.battery,
        borderWidth: 2,
        fill: false,
        tension: 0,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: t.surface,
      });
    }

    render(canvasId, {
      type: "line",
      data: { labels: years, datasets },
      options: (() => {
        const o = baseOptions(t, { money: true, fmt: moneyFmt });
        o.scales.x.stacked = false;
        o.scales.y.stacked = false;
        o.scales.x.ticks.maxTicksLimit = 9;
        o.scales.x.title = {
          display: true,
          text: tr("chart.axis.years"),
          color: t.inkSecondary,
          font: { size: 11 },
        };
        // Break-even is the one line worth drawing on top of the grid.
        o.scales.y.grid = {
          color: (ctx) => (ctx.tick.value === 0 ? t.axis : t.gridline),
          lineWidth: (ctx) => (ctx.tick.value === 0 ? 1.5 : 1),
          drawTicks: false,
        };
        return o;
      })(),
    });
  }

  // Charts are drawn to a canvas, so unlike CSS they cannot restyle themselves when the OS
  // theme flips. The caller re-renders.
  function onThemeChange(callback) {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", callback);
  }

  return { monthly, split, dayProfile, cashFlow, onThemeChange };
})();
