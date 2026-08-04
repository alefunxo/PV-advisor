// Comparison mode (milestone 6): one house, two kits, side by side.
//
// Reached only from the last step of the wizard, which hands the whole scenario over in the
// URL (js/state.js). That is why the house here is *fixed* rather than merely shared: it was
// settled in the wizard, and letting it move would break the one thing this page is for. Two
// scenarios in different towns, or on different roofs, are not comparable — the difference
// would not be something a homeowner could act on. Only the kit differs between the columns:
// panel size, battery size, and which of the heat pump / electric car / air conditioning are
// present, with their own settings.
//
// Both columns start identical to what the user already chose. That is deliberate: changing
// one thing at a time is the only way a comparison answers a question, and a zero diff on
// arrival makes the starting point obvious.
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

  const state = { a: { model: null, scenario: null }, b: { model: null, scenario: null } };

  // ---- the handed-over scenario ---------------------------------------------
  const shared = ShareState.decode();
  if (!shared) {
    // Opened directly. A locked house needs a house to lock.
    $("noStatePanel").hidden = false;
    return;
  }

  const [, cities] = await Promise.all([
    PV.load(),
    fetch("js/data/cities.json").then((r) => r.json()),
  ]);

  const countryList = cities.cities[shared.country] || [];
  const city = countryList.find((c) => c.name === shared.cityName) || countryList[0];
  const countryName = (cities.countries.find((c) => c.code === shared.country) || {}).name || "";

  if (!city) {
    $("noStatePanel").hidden = false;
    return;
  }

  // The house: fixed for the life of this page.
  const house = {
    city,
    countryName,
    orientation: Number(shared.orientation),
    tilt: Number(shared.tilt),
    consumption: Number(shared.consumption),
  };

  $("housePanel").hidden = false;
  $("assumptions").hidden = false;

  // ---- prefill the editable, non-house inputs -------------------------------
  const PREFILL = {
    currency: "currency",
    retailPrice: "retailPrice",
    feedInTariff: "feedInTariff",
    capexPerKwp: "capexPerKwp",
    batteryCapexPerKwh: "batteryCapexPerKwh",
    discountRate: "discountRate",
    lifetime: "lifetime",
    batteryLifetime: "batteryLifetime",
    roundTrip: "roundTrip",
    performanceRatio: "performanceRatio",
    tariffEscalation: "tariffEscalation",
  };
  Object.entries(PREFILL).forEach(([key, id]) => {
    if (shared[key] !== undefined && $(id)) $(id).value = shared[key];
  });

  const ORIENTATION_LABELS = {
    "0": "South", "-45": "South-east", "45": "South-west", "-90": "East", "90": "West",
  };
  const TILT_LABELS = {
    "0": "Flat roof", "15": "Shallow (15°)", "30": "Typical pitch (30°)", "45": "Steep (45°)",
  };

  // ---- column markup --------------------------------------------------------
  // Generated from one template so the two columns cannot drift apart. Ids are suffixed with
  // the column key. Both start from the kit the user already chose.
  function columnMarkup(col) {
    const on = (v) => (ShareState.isOn(v) ? " checked" : "");
    const v = (key, fallback) => (shared[key] !== undefined ? shared[key] : fallback);
    return `
      <section class="compare-col" data-col="${col}">
        <h2>${LABELS[col]}</h2>

        <div class="col-inputs">
          <div class="row">
            <div class="field">
              <label for="kwp-${col}">Solar (kWp)</label>
              <input type="number" id="kwp-${col}" min="0" step="0.5" value="${v("kwp", 6)}" />
            </div>
            <div class="field">
              <label for="battery-${col}">Battery (kWh)</label>
              <input type="number" id="battery-${col}" min="0" step="0.5" value="${v("batteryKwh", 0)}" />
            </div>
          </div>

          <p class="scenario-bar-label">Electric extras</p>
          <div class="scenario-toggles">
            <label class="chip"><input type="checkbox" id="hp-${col}"${on(shared.hp)} /> <span>Heat pump</span></label>
            <label class="chip"><input type="checkbox" id="ev-${col}"${on(shared.ev)} /> <span>Electric car</span></label>
            <label class="chip"><input type="checkbox" id="ac-${col}"${on(shared.ac)} /> <span>Air conditioning</span></label>
          </div>

          <details class="advanced" data-asset-details="${col}">
            <summary>Extras settings</summary>
            <div class="row">
              <div class="field">
                <label for="hpArea-${col}">Heated floor area (m²)</label>
                <input type="number" id="hpArea-${col}" min="10" step="5" value="${v("hpArea", 140)}" />
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
                <option value="45">Mixed / large radiators</option>
                <option value="55">Old radiators (less efficient)</option>
              </select>
            </div>
            <div class="row">
              <div class="field">
                <label for="evKm-${col}">Kilometres driven per year</label>
                <input type="number" id="evKm-${col}" min="0" step="500" value="${v("evKm", 12000)}" />
              </div>
              <div class="field">
                <label for="evEfficiency-${col}">Consumption (kWh per 100 km)</label>
                <input type="number" id="evEfficiency-${col}" min="5" step="0.5" value="${v("evEfficiency", 18)}" />
              </div>
            </div>
            <div class="field">
              <label for="evStrategy-${col}">When do you charge?</label>
              <select id="evStrategy-${col}">
                <option value="dumb">Plug in when I get home (evening)</option>
                <option value="solar">Charge during the day, from my own solar</option>
              </select>
            </div>
            <div class="row">
              <div class="field">
                <label for="acArea-${col}">Cooled floor area (m²)</label>
                <input type="number" id="acArea-${col}" min="5" step="5" value="${v("acArea", 80)}" />
              </div>
              <div class="field">
                <label for="acSeer-${col}">Efficiency (SEER)</label>
                <input type="number" id="acSeer-${col}" min="1.5" step="0.1" value="${v("acSeer", 3)}" />
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

        <div class="col-energy" id="energy-${col}"></div>
        <div class="col-summary" id="summary-${col}"></div>
      </section>`;
  }

  $("compareGrid").innerHTML = COLUMNS.map(columnMarkup).join("");

  COLUMNS.forEach((col) => {
    $(`hpStandard-${col}`).innerHTML = Object.entries(LoadProfiles.BUILDING_STANDARDS)
      .map(([k, def]) => `<option value="${k}">${def.label}</option>`)
      .join("");
    // Selects cannot be prefilled through the template's value attribute.
    if (shared.hpStandard) $(`hpStandard-${col}`).value = shared.hpStandard;
    if (shared.hpSupply) $(`hpSupply-${col}`).value = shared.hpSupply;
    if (shared.evStrategy) $(`evStrategy-${col}`).value = shared.evStrategy;
  });

  // ---- reading the form -----------------------------------------------------
  const numOr = (id, fallback) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };

  function paramsFor(col) {
    return {
      site: house.city,
      country: house.countryName,
      kwp: num(`kwp-${col}`),
      tilt: house.tilt,
      aspect: house.orientation,
      performanceRatio: num("performanceRatio"),
      annualConsumptionKwh: house.consumption,
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

  // Every number must be usable before anything is computed; unlike the wizard there are no
  // steps to validate one at a time.
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
  // The three whose purchase price the tool does not model.
  const UNCOSTED = { hp: "heat pump", ev: "car and its charger", ac: "air conditioner" };

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

  const share = (v, total) =>
    total > 0
      ? `${fmt.kwh(v)} <span class="share">(${Math.round((v / total) * 100)}%)</span>`
      : fmt.kwh(v);

  // ---- rendering ------------------------------------------------------------
  function sharedMonthlyMax() {
    return Math.max(
      ...COLUMNS.flatMap((col) => state[col].scenario.chosen.buckets.map((b) => b.load))
    );
  }

  function renderColumn(col, yMax) {
    const m = state[col].model;
    const s = state[col].scenario;
    const worthIt = s.totalNpv > 0;
    const produced = s.chosen.totalProduction;
    const dash = '<span class="na">—</span>';

    // Every row is rendered in both columns, with a dash where it does not apply. Two columns
    // that grow different numbers of rows would put their charts at different heights, and
    // charts you cannot scan across defeat the point of a side-by-side layout.
    $(`result-${col}`).innerHTML = `
      <p class="headline ${worthIt ? "good" : "bad"}">
        ${worthIt ? "+" : ""}${fmt.money(s.totalNpv)}
      </p>
      <p class="hint headline-note">over ${m.lifetimeYears} years, after paying for the kit</p>
      <dl class="kv">
        <dt>Upfront cost</dt><dd>${fmt.money(s.totalCapex)}</dd>
        <dt class="sub">…panels</dt><dd>${fmt.money(m.pvCapex)}</dd>
        <dt class="sub">…battery</dt><dd>${s.hasBattery ? fmt.money(m.batteryCapex) : dash}</dd>
        <dt>Yearly bill before solar</dt><dd>${fmt.money(s.billNow)}</dd>
        <dt>Yearly bill now</dt><dd>${fmt.money(s.hasBattery ? s.billBattery : s.billPv)}</dd>
        <dt>Yearly saving</dt><dd>${fmt.money(s.billNow - (s.hasBattery ? s.billBattery : s.billPv))}</dd>
        <dt>Solar pays back in</dt><dd>${fmt.years(s.pvPayback)}</dd>
        <dt>Battery pays back in</dt><dd>${s.hasBattery ? fmt.years(s.battery.paybackYears) : dash}</dd>
        <dt>Value of the panels</dt><dd>${fmt.money(s.pvNpv)}</dd>
        <dt>Value of the battery</dt><dd>${s.hasBattery ? fmt.money(s.battery.npv) : dash}</dd>
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

    const throughput = Scenario.batteryThroughput(s.chosen);
    $(`energy-${col}`).innerHTML = `
      <h3>The energy, over a year</h3>
      <dl class="kv">
        <dt>Electricity used</dt><dd>${fmt.kwh(s.totalConsumption)}</dd>
        <dt>Solar produced</dt><dd>${fmt.kwh(produced)}</dd>
        <dt>Used straight away</dt><dd>${share(s.chosen.directSelfConsumed, produced)}</dd>
        <dt>Stored in the battery</dt><dd>${s.hasBattery ? share(throughput, produced) : dash}</dd>
        <dt class="sub">…of which came back out</dt>
        <dd>${s.hasBattery ? fmt.kwh(s.chosen.batteryDischargeToLoad) : dash}</dd>
        <dt class="sub">…of which lost charging</dt>
        <dd>${s.hasBattery ? share(s.chosen.chargeLosses + s.chosen.dischargeLosses, produced) : dash}</dd>
        <dt>Sent to the grid</dt><dd>${share(s.chosen.exported, produced)}</dd>
        <dt>Bought from the grid</dt><dd>${fmt.kwh(s.chosen.imported)}</dd>
        <dt>Self-sufficiency</dt><dd>${fmt.pct(s.chosen.selfSufficiencyRate)}</dd>
        <dt>Of your solar, used on site</dt><dd>${fmt.pct(s.chosen.selfConsumptionRate)}</dd>
        <dt>Battery full cycles a year</dt>
        <dd>${s.hasBattery ? fmtInt(s.chosen.equivalentFullCycles) : dash}</dd>
      </dl>`;

    // The "initial situation" summary: what this column actually is, in words, so a reader
    // scrolled down to the charts does not have to scroll back up to remember.
    const extras = Scenario.ASSET_KEYS.filter((k) => s.enabled[k]).map((k) => ASSET_NAMES[k]);
    $(`summary-${col}`).innerHTML = `
      <h3>What ${LABELS[col]} is</h3>
      <ul class="summary-list">
        <li><strong>${m.kwp.toFixed(1)} kWp</strong> of panels — about ${fmtInt(m.kwp / KWP_PER_USABLE_M2)} m² of roof</li>
        <li><strong>${m.batteryKwh > 0 ? `${m.batteryKwh} kWh battery` : "No battery"}</strong></li>
        <li><strong>${extras.length ? extras.join(", ") : "No electric extras"}</strong></li>
      </ul>`;
  }

  // Only the panels and the battery are costed anywhere in this tool. A heat pump, a car or an
  // air conditioner changes the electricity bill, and that change is in every figure above —
  // but buying the thing is not. Saying so quietly in the assumptions panel is not enough when
  // the headline is a money figure a reader will compare against another money figure.
  function renderCostNotice() {
    const missing = new Set();
    COLUMNS.forEach((col) => {
      Scenario.ASSET_KEYS.forEach((k) => {
        if (state[col].scenario.enabled[k]) missing.add(k);
      });
    });

    if (!missing.size) {
      $("costNotice").hidden = true;
      return;
    }

    const names = [...missing].map((k) => UNCOSTED[k]);
    const list =
      names.length === 1
        ? names[0]
        : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    $("costNotice").hidden = false;
    $("costNotice").innerHTML = `
      <strong>What you pay for the ${list} is not included.</strong>
      Only the panels and the battery are costed here. The extras change the electricity bill,
      and that is in every figure on this page — but the price of buying and installing them
      is not, so the value figures are not a full purchase decision for them.`;
  }

  function renderDelta() {
    const a = state.a.scenario;
    const b = state.b.scenario;
    const better = a.totalNpv >= b.totalNpv ? "a" : "b";
    const gap = Math.abs(a.totalNpv - b.totalNpv);
    const billOf = (s) => (s.hasBattery ? s.billBattery : s.billPv);
    const identical = gap < 1 && Math.abs(a.totalCapex - b.totalCapex) < 1 &&
      Math.abs(a.totalConsumption - b.totalConsumption) < 1;

    const rows = [
      ["Value over the system's life", fmt.money(a.totalNpv), fmt.money(b.totalNpv),
       fmt.signedMoney(b.totalNpv - a.totalNpv)],
      ["Upfront cost", fmt.money(a.totalCapex), fmt.money(b.totalCapex),
       fmt.signedMoney(b.totalCapex - a.totalCapex)],
      ["Yearly bill", fmt.money(billOf(a)), fmt.money(billOf(b)),
       fmt.signedMoney(billOf(b) - billOf(a))],
      ["Yearly saving",
       fmt.money(a.billNow - billOf(a)), fmt.money(b.billNow - billOf(b)),
       fmt.signedMoney((b.billNow - billOf(b)) - (a.billNow - billOf(a)))],
      ["Solar produced", fmt.kwh(a.chosen.totalProduction), fmt.kwh(b.chosen.totalProduction),
       fmt.signedKwh(b.chosen.totalProduction - a.chosen.totalProduction)],
      ["Self-sufficiency", fmt.pct(a.chosen.selfSufficiencyRate), fmt.pct(b.chosen.selfSufficiencyRate),
       fmt.pts(b.chosen.selfSufficiencyRate - a.chosen.selfSufficiencyRate)],
      ["Of your solar, used on site",
       fmt.pct(a.chosen.selfConsumptionRate), fmt.pct(b.chosen.selfConsumptionRate),
       fmt.pts(b.chosen.selfConsumptionRate - a.chosen.selfConsumptionRate)],
      ["Bought from the grid", fmt.kwh(a.chosen.imported), fmt.kwh(b.chosen.imported),
       fmt.signedKwh(b.chosen.imported - a.chosen.imported)],
      ["Electricity used per year", fmt.kwh(a.totalConsumption), fmt.kwh(b.totalConsumption),
       fmt.signedKwh(b.totalConsumption - a.totalConsumption)],
    ];

    $("deltaBody").innerHTML = `
      <p class="verdict-line">
        ${
          identical
            ? "Both columns are the same system — change the panels, the battery or the extras on one side to see what it does."
            : `<strong>${LABELS[better]}</strong> is worth <strong>${fmt.money(gap)}</strong> more over the system's life.` +
              (gap < 500
                ? " That is close enough that the choice can rest on what you want rather than on the money."
                : "")
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

  function renderHouse() {
    $("houseSummary").innerHTML = `
      <dt>Town</dt><dd>${house.city.name}, ${house.countryName}</dd>
      <dt>Roof</dt><dd>${ORIENTATION_LABELS[String(house.orientation)] || `${house.orientation}°`},
        ${TILT_LABELS[String(house.tilt)] || `${house.tilt}°`}</dd>
      <dt>Electricity used, before extras</dt><dd>${fmt.kwh(house.consumption)} a year</dd>`;
  }

  function renderAssumptions() {
    const m = state.a.model;
    $("assumptions-body").innerHTML = `
      <ul>
        <li><strong>Screening estimate, not a quote.</strong> Treat these as a first indication,
        not an engineering study or a financial promise.</li>
        <li><strong>Only the panels and the battery are costed.</strong> Buying and installing a
        heat pump, an electric car or an air conditioner is not in any figure here — their
        effect on your electricity bill is, but their price is not.</li>
        <li><strong>Sunlight and temperature</strong> are PVGIS measurements for
        ${m.site.name} (${m.country}) itself, and are identical for both columns.</li>
        <li><strong>Only the kit differs.</strong> Both columns share the house, the roof, the
        base electricity use and every tariff — that is what makes the comparison meaningful.
        To compare two towns or two tariffs, run the step-by-step version twice.</li>
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
      renderHouse();
      renderCostNotice();
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
    if (!e.target.matches("input[type=checkbox]")) invalidate();
    refresh();
  });

  Charts.onThemeChange(refresh);

  refresh();
});
