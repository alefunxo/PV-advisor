// Comparison mode (milestone 6): one house, two kits, side by side.
//
// The house — town, roof, base consumption, tariffs, financial assumptions — is shared and
// edited once. Only the *distributed energy resources* differ between the columns: panel size,
// battery size, and which of the heat pump / electric car / air conditioning are present, with
// their own settings. Comparing two scenarios in different towns or on different tariffs was
// deliberately not built: the difference would not be something a homeowner could act on.
//
// All the maths is js/calc/scenario.js, shared with the wizard. This file is the two-column
// shell: read the form, run each column, render, and diff them.

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (id) => document.getElementById(id);
  const num = (id) => Number($(id).value);
  const COLUMNS = ["a", "b"];
  const LABELS = { a: "System A", b: "System B" };
  // Modules are roughly 200 W/m² and installers rarely fill every square metre — the same
  // pair of assumptions the wizard sizes with, kept here so the two pages agree.
  const KWP_PER_USABLE_M2 = 0.2 * 0.8;

  // Starting kit for each column: a plain solar system against the same system with a battery
  // and a heat pump, which is the comparison most people arrive wanting.
  const PRESETS = {
    a: { kwp: 6, batteryKwh: 0, hp: false, ev: false, ac: false },
    b: { kwp: 6, batteryKwh: 8, hp: true, ev: false, ac: false },
  };

  const state = {
    a: { model: null, scenario: null },
    b: { model: null, scenario: null },
  };

  // ---- data -----------------------------------------------------------------
  const [, cities] = await Promise.all([
    PV.load(),
    fetch("js/data/cities.json").then((r) => r.json()),
  ]);

  const countrySelect = $("country");
  countrySelect.innerHTML = cities.countries
    .map((c) => `<option value="${c.code}">${c.name}</option>`)
    .join("");
  countrySelect.value = "CH";

  function populateCities() {
    const list = cities.cities[countrySelect.value] || [];
    $("city").innerHTML = list.map((c, i) => `<option value="${i}">${c.name}</option>`).join("");
  }

  const CURRENCY_BY_COUNTRY = {
    CH: "CHF", GB: "GBP", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN",
    CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN",
  };
  let currencyTouched = false;
  $("currency").addEventListener("change", () => {
    currencyTouched = true;
  });
  function syncCurrency() {
    if (currencyTouched) return;
    $("currency").value = CURRENCY_BY_COUNTRY[countrySelect.value] || "EUR";
  }

  function selectedCity() {
    const list = cities.cities[countrySelect.value] || [];
    return list[Number($("city").value)] || list[0];
  }

  populateCities();
  syncCurrency();

  // ---- column markup --------------------------------------------------------
  // Generated from one template so the two columns cannot drift apart. Ids are suffixed with
  // the column key.
  function columnMarkup(col) {
    const p = PRESETS[col];
    const on = (v) => (v ? " checked" : "");
    return `
      <section class="compare-col" data-col="${col}">
        <h2>${LABELS[col]}</h2>

        <div class="col-inputs">
          <div class="row">
            <div class="field">
              <label for="kwp-${col}">Solar (kWp)</label>
              <input type="number" id="kwp-${col}" min="0" step="0.5" value="${p.kwp}" />
            </div>
            <div class="field">
              <label for="battery-${col}">Battery (kWh)</label>
              <input type="number" id="battery-${col}" min="0" step="0.5" value="${p.batteryKwh}" />
            </div>
          </div>

          <p class="scenario-bar-label">Electric extras</p>
          <div class="scenario-toggles">
            <label class="chip"><input type="checkbox" id="hp-${col}"${on(p.hp)} /> <span>Heat pump</span></label>
            <label class="chip"><input type="checkbox" id="ev-${col}"${on(p.ev)} /> <span>Electric car</span></label>
            <label class="chip"><input type="checkbox" id="ac-${col}"${on(p.ac)} /> <span>Air conditioning</span></label>
          </div>

          <details class="advanced" data-asset-details="${col}">
            <summary>Extras settings</summary>
            <div class="row">
              <div class="field">
                <label for="hpArea-${col}">Heated floor area (m²)</label>
                <input type="number" id="hpArea-${col}" min="10" step="5" value="140" />
              </div>
              <div class="field">
                <label for="hpStandard-${col}">Building age / insulation</label>
                <select id="hpStandard-${col}"></select>
              </div>
            </div>
            <div class="field">
              <label for="hpSupply-${col}">Heat distribution</label>
              <select id="hpSupply-${col}">
                <option value="35">Underfloor heating (efficient)</option>
                <option value="45" selected>Mixed / large radiators</option>
                <option value="55">Old radiators (less efficient)</option>
              </select>
            </div>
            <div class="row">
              <div class="field">
                <label for="evKm-${col}">Kilometres driven per year</label>
                <input type="number" id="evKm-${col}" min="0" step="500" value="12000" />
              </div>
              <div class="field">
                <label for="evEfficiency-${col}">Consumption (kWh per 100 km)</label>
                <input type="number" id="evEfficiency-${col}" min="5" step="0.5" value="18" />
              </div>
            </div>
            <div class="field">
              <label for="evStrategy-${col}">When do you charge?</label>
              <select id="evStrategy-${col}">
                <option value="dumb" selected>Plug in when I get home (evening)</option>
                <option value="solar">Charge during the day, from my own solar</option>
              </select>
            </div>
            <div class="row">
              <div class="field">
                <label for="acArea-${col}">Cooled floor area (m²)</label>
                <input type="number" id="acArea-${col}" min="5" step="5" value="80" />
              </div>
              <div class="field">
                <label for="acSeer-${col}">Efficiency (SEER)</label>
                <input type="number" id="acSeer-${col}" min="1.5" step="0.1" value="3" />
              </div>
            </div>
          </details>
        </div>

        <div class="col-result" id="result-${col}"></div>

        <figure class="chart-card">
          <figcaption>
            <h3>Where the electricity came from</h3>
            <p class="hint">Each bar is that month's total use.</p>
          </figcaption>
          <div class="chart-frame"><canvas id="chartMonthly-${col}"></canvas></div>
        </figure>

        <div class="col-summary" id="summary-${col}"></div>
      </section>`;
  }

  $("compareGrid").innerHTML = COLUMNS.map(columnMarkup).join("");

  COLUMNS.forEach((col) => {
    $(`hpStandard-${col}`).innerHTML = Object.entries(LoadProfiles.BUILDING_STANDARDS)
      .map(([k, def]) => `<option value="${k}"${k === "mid" ? " selected" : ""}>${def.label}</option>`)
      .join("");
  });

  // ---- reading the form -----------------------------------------------------
  const numOr = (id, fallback) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };

  function paramsFor(col) {
    return {
      site: selectedCity(),
      country: countrySelect.options[countrySelect.selectedIndex].text,
      kwp: num(`kwp-${col}`),
      tilt: num("tilt"),
      aspect: num("orientation"),
      performanceRatio: num("performanceRatio"),
      annualConsumptionKwh: num("consumption"),
      batteryKwh: num(`battery-${col}`),
      roundTripEfficiency: num("roundTrip"),
      capexPerKwp: num("capexPerKwp"),
      batteryCapexPerKwh: num("batteryCapexPerKwh"),
      discountRatePct: num("discountRate"),
      lifetimeYears: num("lifetime"),
      batteryLifetimeYears: num("batteryLifetime"),
      retailPrice: num("retailPrice"),
      feedInTariff: num("feedInTariff"),
      tariffEscalationPct: num("tariffEscalation"),
      hp: {
        mode: "area",
        floorAreaM2: numOr(`hpArea-${col}`, 140),
        standard: $(`hpStandard-${col}`).value,
        supplyTempC: numOr(`hpSupply-${col}`, 45),
      },
      ev: {
        annualKm: numOr(`evKm-${col}`, 12000),
        kwhPer100km: numOr(`evEfficiency-${col}`, 18),
        chargingStrategy: $(`evStrategy-${col}`).value,
      },
      ac: { floorAreaM2: numOr(`acArea-${col}`, 80), seer: numOr(`acSeer-${col}`, 3) },
    };
  }

  const enabledFor = (col) =>
    Scenario.ASSET_KEYS.reduce((acc, k) => {
      acc[k] = $(`${k}-${col}`).checked;
      return acc;
    }, {});

  // Every number on the page must be usable before anything is computed; unlike the wizard
  // there are no steps to validate one at a time.
  function validate() {
    const problems = [];
    document.querySelectorAll("input[type=number]").forEach((input) => {
      input.removeAttribute("aria-invalid");
      const value = input.value.trim();
      const min = input.min === "" ? -Infinity : Number(input.min);
      const max = input.max === "" ? Infinity : Number(input.max);
      const bad =
        value === "" || Number.isNaN(Number(value)) || Number(value) < min || Number(value) > max;
      if (bad) {
        input.setAttribute("aria-invalid", "true");
        const label = document.querySelector(`label[for="${input.id}"]`);
        problems.push(label ? label.textContent.trim() : input.id);
      }
    });
    return problems;
  }

  // ---- formatting -----------------------------------------------------------
  const INT_FORMAT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
  const fmtInt = (v) => INT_FORMAT.format(Math.round(v));
  const ASSET_NAMES = { hp: "Heat pump", ev: "Electric car", ac: "Air conditioning" };

  let fmt;
  function buildFormatters(currency) {
    const money = new Intl.NumberFormat("en-GB", {
      style: "currency", currency, maximumFractionDigits: 0,
    });
    const plain = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
    fmt = {
      money: (v) => money.format(Math.round(v)),
      signedMoney: (v) => (v > 0 ? `+${money.format(Math.round(v))}` : money.format(Math.round(v))),
      kwh: (v) => `${plain.format(Math.round(v))} kWh`,
      signedKwh: (v) => `${v > 0 ? "+" : ""}${plain.format(Math.round(v))} kWh`,
      pct: (v) => `${Math.round(v * 100)}%`,
      pts: (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v * 100))} pts`,
      years: (v) => (isFinite(v) ? `${v.toFixed(1)} years` : "never"),
    };
  }

  // ---- rendering ------------------------------------------------------------
  // The tallest month across both columns. Both charts are drawn to it so their bars can be
  // compared by eye — which is the entire point of putting them next to each other.
  function sharedMonthlyMax() {
    return Math.max(
      ...COLUMNS.flatMap((col) => state[col].scenario.chosen.buckets.map((b) => b.load))
    );
  }

  function renderColumn(col, yMax) {
    const m = state[col].model;
    const s = state[col].scenario;
    const worthIt = s.totalNpv > 0;

    $(`result-${col}`).innerHTML = `
      <p class="headline ${worthIt ? "good" : "bad"}">
        ${worthIt ? "+" : ""}${fmt.money(s.totalNpv)}
      </p>
      <p class="hint headline-note">over ${m.lifetimeYears} years, after paying for the kit</p>
      <dl class="kv">
        <dt>Upfront cost</dt><dd>${fmt.money(s.totalCapex)}</dd>
        <dt>Yearly bill</dt><dd>${fmt.money(s.hasBattery ? s.billBattery : s.billPv)}</dd>
        <dt>Yearly saving</dt><dd>${fmt.money(s.billNow - (s.hasBattery ? s.billBattery : s.billPv))}</dd>
        <dt>Solar pays back in</dt><dd>${fmt.years(s.pvPayback)}</dd>
        ${s.hasBattery ? `<dt>Battery pays back in</dt><dd>${fmt.years(s.battery.paybackYears)}</dd>` : ""}
        <dt>Self-sufficiency</dt><dd>${fmt.pct(s.chosen.selfSufficiencyRate)}</dd>
        <dt>Of your solar, used on site</dt><dd>${fmt.pct(s.chosen.selfConsumptionRate)}</dd>
        <dt>Electricity used per year</dt><dd>${fmt.kwh(s.totalConsumption)}</dd>
      </dl>`;

    const monthly = s.chosen.buckets;
    Charts.monthly(`chartMonthly-${col}`, {
      labels: Aggregate.MONTH_LABELS,
      direct: monthly.map((b) => b.directSelfConsumed),
      battery: monthly.map((b) => b.batteryDischargeToLoad),
      grid: monthly.map((b) => b.imported),
      hasBattery: s.hasBattery,
      kwhFmt: fmt.kwh,
      yMax,
    });

    // The "initial situation" summary: what this column actually is, in words, so a reader
    // scrolled down to the charts does not have to scroll back up to remember.
    const extras = Scenario.ASSET_KEYS.filter((k) => s.enabled[k]).map((k) => ASSET_NAMES[k]);
    $(`summary-${col}`).innerHTML = `
      <h3>What ${LABELS[col]} is</h3>
      <ul class="summary-list">
        <li><strong>${m.kwp.toFixed(1)} kWp</strong> of panels — about ${fmtInt(m.kwp / KWP_PER_USABLE_M2)} m² of roof</li>
        <li><strong>${m.batteryKwh > 0 ? `${m.batteryKwh} kWh battery` : "No battery"}</strong></li>
        <li><strong>${extras.length ? extras.join(", ") : "No electric extras"}</strong></li>
        <li>Produces ${fmt.kwh(s.chosen.totalProduction)} a year, against ${fmt.kwh(s.totalConsumption)} used</li>
      </ul>`;
  }

  function renderDelta() {
    const a = state.a.scenario;
    const b = state.b.scenario;
    const better = a.totalNpv >= b.totalNpv ? "a" : "b";
    const gap = Math.abs(a.totalNpv - b.totalNpv);

    const rows = [
      ["Value over the system's life", fmt.money(a.totalNpv), fmt.money(b.totalNpv),
       fmt.signedMoney(b.totalNpv - a.totalNpv)],
      ["Upfront cost", fmt.money(a.totalCapex), fmt.money(b.totalCapex),
       fmt.signedMoney(b.totalCapex - a.totalCapex)],
      ["Yearly bill",
       fmt.money(a.hasBattery ? a.billBattery : a.billPv),
       fmt.money(b.hasBattery ? b.billBattery : b.billPv),
       fmt.signedMoney((b.hasBattery ? b.billBattery : b.billPv) - (a.hasBattery ? a.billBattery : a.billPv))],
      ["Self-sufficiency", fmt.pct(a.chosen.selfSufficiencyRate), fmt.pct(b.chosen.selfSufficiencyRate),
       fmt.pts(b.chosen.selfSufficiencyRate - a.chosen.selfSufficiencyRate)],
      ["Electricity used per year", fmt.kwh(a.totalConsumption), fmt.kwh(b.totalConsumption),
       fmt.signedKwh(b.totalConsumption - a.totalConsumption)],
    ];

    $("deltaBody").innerHTML = `
      <p class="verdict-line">
        <strong>${LABELS[better]}</strong> is worth
        <strong>${fmt.money(gap)}</strong> more over the system's life.
        ${
          gap < 500
            ? "That is close enough that the choice can rest on what you want rather than on the money."
            : ""
        }
      </p>
      <div class="delta-table" role="table">
        <div class="delta-row head" role="row">
          <span role="columnheader"></span>
          <span role="columnheader">${LABELS.a}</span>
          <span role="columnheader">${LABELS.b}</span>
          <span role="columnheader">B &minus; A</span>
        </div>
        ${rows
          .map(
            ([label, av, bv, dv]) => `
          <div class="delta-row" role="row">
            <span role="cell">${label}</span>
            <span role="cell">${av}</span>
            <span role="cell">${bv}</span>
            <span role="cell" class="delta-cell">${dv}</span>
          </div>`
          )
          .join("")}
      </div>
      <p class="hint">
        Both columns use the same house, the same weather and the same tariffs, so every
        difference above comes from the kit alone.
      </p>`;

    $("verdictBlock").hidden = false;
  }

  function renderAssumptions() {
    const m = state.a.model;
    $("assumptions-body").innerHTML = `
      <ul>
        <li><strong>Screening estimate, not a quote.</strong> Treat these as a first indication,
        not an engineering study or a financial promise.</li>
        <li><strong>Sunlight and temperature</strong> are PVGIS measurements for
        ${m.site.name} (${m.country}) itself, and are identical for both columns.</li>
        <li><strong>Only the kit differs.</strong> Both columns share the house, the roof, the
        base electricity use and every tariff — that is what makes the comparison meaningful.
        If you want to compare two towns or two tariffs, run the step-by-step version twice.</li>
        <li><strong>The extras are added on top</strong> of the same base consumption, so a
        column with a heat pump legitimately uses more electricity than one without. Compare
        the yearly bill and the value over the system's life, not the self-sufficiency alone —
        adding a heat pump lowers self-sufficiency even when it saves money overall.</li>
        <li><strong>Battery control</strong> is a simple rule: store surplus, use it when short.
        No price trading, no forecasting.</li>
        <li><strong>Weather variability</strong> between days is smoothed out, which flatters
        the battery slightly in both columns.</li>
        <li><strong>Money:</strong> ${m.lifetimeYears}-year life, ${m.discountRatePct}% discount
        rate, panels losing 0.5% output per year, maintenance at 1% of system cost per year.
        All amounts are in the currency you selected; no exchange rates are applied.</li>
      </ul>`;
  }

  // ---- recompute ------------------------------------------------------------
  // Scenario.build() is the expensive half and does not depend on which extras are ticked —
  // it always generates all three profiles. So a toggle only re-runs compute(), and the model
  // is thrown away only when something it actually depends on changes.
  function invalidate() {
    COLUMNS.forEach((col) => {
      state[col].model = null;
    });
  }

  let pending = null;
  function refresh() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      const problems = validate();
      if (problems.length) {
        const err = $("formError");
        err.textContent = `Please check: ${problems.slice(0, 4).join(", ")}.`;
        err.hidden = false;
        return;
      }
      $("formError").hidden = true;

      buildFormatters($("currency").value);
      // Both columns are computed before either is drawn, so the charts can share one axis.
      COLUMNS.forEach((col) => {
        if (!state[col].model) state[col].model = Scenario.build(paramsFor(col));
        state[col].scenario = Scenario.compute(state[col].model, enabledFor(col));
      });
      const yMax = sharedMonthlyMax();
      COLUMNS.forEach((col) => renderColumn(col, yMax));
      renderDelta();
      renderAssumptions();
    }, 120);
  }

  // Anything that is not an extras checkbox changes the model itself.
  document.addEventListener("input", (e) => {
    if (e.target.matches("input[type=checkbox]")) return;
    invalidate();
    refresh();
  });
  document.addEventListener("change", (e) => {
    if (e.target === countrySelect) {
      populateCities();
      syncCurrency();
    }
    if (!e.target.matches("input[type=checkbox]")) invalidate();
    refresh();
  });

  Charts.onThemeChange(refresh);

  refresh();
});
