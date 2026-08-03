// Wizard shell + results dashboard (Section 7 of the build plan).
//
// Milestone 5 turned the results step into a dashboard: charts (js/charts.js), a fuller
// assumptions panel, and live extras toggles that recompute the page in place.
//
// The maths itself lives in js/calc/scenario.js, which knows nothing about the DOM — milestone
// 6 moved it out so comparison mode (js/compare.js) could run two scenarios at once. What is
// left in this file is the wizard shell: reading the form into params, and turning the numbers
// that come back into sentences. The solar and battery sizes never move between scenarios
// (Section 2), so a difference the user sees when flipping a toggle is the extra's doing and
// not a resized system's.

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (id) => document.getElementById(id);
  const num = (id) => Number($(id).value);
  // Detail fields inside a switched-off asset panel are skipped by validation, so they can
  // still hold something unusable when the results page reaches for them.
  const numOr = (id, fallback) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };

  const LAST_STEP = 4;
  const RESULTS_STEP = 4;
  // Modern modules are roughly 200 W/m²; installers rarely fill every square metre, so only
  // part of the stated roof area ends up covered.
  const KWP_PER_M2 = 0.2;
  const USABLE_AREA_FRACTION = 0.8;

  let step = 1;
  let cities = null;

  // ---- data loading ----------------------------------------------------------
  const [, citiesData] = await Promise.all([
    PV.load(),
    fetch("js/data/cities.json").then((r) => r.json()),
  ]);
  cities = citiesData;

  // ---- step 1 population -----------------------------------------------------
  const countrySelect = $("country");
  countrySelect.innerHTML = cities.countries
    .map((c) => `<option value="${c.code}">${c.name}</option>`)
    .join("");
  countrySelect.value = "CH";

  function populateCities() {
    const list = cities.cities[countrySelect.value] || [];
    $("city").innerHTML = list
      .map((c, i) => `<option value="${i}">${c.name}</option>`)
      .join("");
  }
  // Currency follows the country by default but stays user-editable — border regions and
  // expatriate billing do not always match the map.
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

  countrySelect.addEventListener("change", () => {
    populateCities();
    syncCurrency();
  });
  populateCities();
  syncCurrency();

  function selectedCity() {
    const list = cities.cities[countrySelect.value] || [];
    return list[Number($("city").value)] || list[0];
  }

  // ---- system sizing ---------------------------------------------------------
  function sizeMode() {
    return document.querySelector('input[name="sizeMode"]:checked').value;
  }

  function systemKwp() {
    return sizeMode() === "kwp"
      ? num("kwp")
      : num("roofArea") * USABLE_AREA_FRACTION * KWP_PER_M2;
  }

  function refreshSizing() {
    document.querySelectorAll("[data-size-mode]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.sizeMode !== sizeMode());
    });
    const kwp = systemKwp();
    $("sizeDerived").textContent =
      sizeMode() === "area"
        ? `That is roughly a ${kwp.toFixed(1)} kWp system.`
        : `That needs roughly ${(kwp / (USABLE_AREA_FRACTION * KWP_PER_M2)).toFixed(0)} m² of roof.`;
  }

  document
    .querySelectorAll('input[name="sizeMode"], #roofArea, #kwp')
    .forEach((el) => el.addEventListener("input", refreshSizing));
  refreshSizing();

  // ---- step 3: assets --------------------------------------------------------
  $("hpStandard").innerHTML = Object.entries(LoadProfiles.BUILDING_STANDARDS)
    .map(
      ([key, def]) =>
        `<option value="${key}"${key === "mid" ? " selected" : ""}>${def.label}</option>`
    )
    .join("");

  // The detail panels only make sense once an asset is switched on.
  function refreshAssetPanels() {
    [["hp", "hpEnabled"], ["ev", "evEnabled"], ["ac", "acEnabled"]].forEach(([asset, toggle]) => {
      const panel = document.querySelector(`details.advanced[data-asset="${asset}"]`);
      const on = $(toggle).checked;
      panel.hidden = !on;
      if (!on) panel.open = false;
    });
  }
  ["hpEnabled", "evEnabled", "acEnabled"].forEach((id) =>
    $(id).addEventListener("change", refreshAssetPanels)
  );

  function refreshHpMode() {
    const mode = document.querySelector('input[name="hpMode"]:checked').value;
    document.querySelectorAll("[data-hp-mode]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.hpMode !== mode);
    });
  }
  document
    .querySelectorAll('input[name="hpMode"]')
    .forEach((el) => el.addEventListener("change", refreshHpMode));

  refreshAssetPanels();
  refreshHpMode();

  // ---- validation ------------------------------------------------------------
  // Only the fields on the current step, so a user is never blocked by a field they
  // have not reached yet.
  function validateStep(n) {
    const section = document.querySelector(`.step[data-step="${n}"]`);
    const inputs = section.querySelectorAll("input[type=number]");
    const problems = [];

    inputs.forEach((input) => {
      input.removeAttribute("aria-invalid");
      // Skip anything the user cannot currently see: the unselected sizing mode, and the
      // detail panels of assets that are switched off.
      if (input.closest(".hidden") || input.closest("[hidden]")) return;
      const value = input.value.trim();
      const min = input.min === "" ? -Infinity : Number(input.min);
      const max = input.max === "" ? Infinity : Number(input.max);
      const bad = value === "" || Number.isNaN(Number(value)) || Number(value) < min || Number(value) > max;
      if (bad) {
        input.setAttribute("aria-invalid", "true");
        const label = section.querySelector(`label[for="${input.id}"]`);
        problems.push(label ? label.textContent.trim() : input.id);
      }
    });

    return problems;
  }

  // ---- navigation ------------------------------------------------------------
  function render() {
    document.querySelectorAll(".step").forEach((el) => {
      el.classList.toggle("hidden", Number(el.dataset.step) !== step);
    });
    document.querySelectorAll("#stepper li").forEach((el) => {
      const n = Number(el.dataset.step);
      el.classList.toggle("done", n < step);
      if (n === step) {
        el.setAttribute("aria-current", "step");
      } else {
        el.removeAttribute("aria-current");
      }
    });

    // The wizard reads best as a narrow column; the dashboard needs the width.
    document.body.classList.toggle("results-wide", step === RESULTS_STEP);

    $("backBtn").hidden = step === 1;
    $("nextBtn").hidden = step === RESULTS_STEP;
    $("restartBtn").hidden = step !== RESULTS_STEP;
    $("nextBtn").textContent = step === RESULTS_STEP - 1 ? "See my results" : "Continue";
    $("formError").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $("nextBtn").addEventListener("click", () => {
    const problems = validateStep(step);
    if (problems.length) {
      const err = $("formError");
      err.textContent = `Please check: ${problems.join(", ")}.`;
      err.hidden = false;
      return;
    }
    step = Math.min(LAST_STEP, step + 1);
    if (step === RESULTS_STEP) calculate();
    render();
  });

  $("backBtn").addEventListener("click", () => {
    step = Math.max(1, step - 1);
    render();
  });

  $("restartBtn").addEventListener("click", () => {
    step = 1;
    render();
  });

  // ---- calculation ------------------------------------------------------------
  // The model and the per-scenario maths live in js/calc/scenario.js, DOM-free, so comparison
  // mode can run two of them side by side. This file only reads the form into params and
  // turns the numbers back into sentences.
  const ASSET_KEYS = Scenario.ASSET_KEYS;
  const RESULT_TOGGLE = { hp: "resultHp", ev: "resultEv", ac: "resultAc" };
  const STEP_TOGGLE = { hp: "hpEnabled", ev: "evEnabled", ac: "acEnabled" };

  let model = null;

  function readParams() {
    return {
      site: selectedCity(),
      country: countrySelect.options[countrySelect.selectedIndex].text,
      kwp: systemKwp(),
      tilt: num("tilt"),
      aspect: num("orientation"),
      performanceRatio: num("performanceRatio"),
      annualConsumptionKwh: num("consumption"),
      batteryKwh: num("batteryKwh"),
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
        mode: document.querySelector('input[name="hpMode"]:checked').value,
        annualHeatKwh: numOr("hpHeatKwh", 12000),
        floorAreaM2: numOr("hpArea", 140),
        standard: $("hpStandard").value,
        supplyTempC: numOr("hpSupply", 45),
      },
      ev: {
        annualKm: numOr("evKm", 12000),
        kwhPer100km: numOr("evEfficiency", 18),
        chargingStrategy: $("evStrategy").value,
      },
      ac: { floorAreaM2: numOr("acArea", 80), seer: numOr("acSeer", 3) },
    };
  }

  // ---- results-page extras toggles -------------------------------------------
  function enabledAssets() {
    return ASSET_KEYS.reduce((acc, k) => {
      acc[k] = $(RESULT_TOGGLE[k]).checked;
      return acc;
    }, {});
  }

  function refresh() {
    if (!model) return;
    const scenario = Scenario.compute(model, enabledAssets());
    renderResults(scenario);
    renderCharts(scenario);
  }

  ASSET_KEYS.forEach((k) => {
    $(RESULT_TOGGLE[k]).addEventListener("change", () => {
      // Keep step 3 in step with the results page, so going Back does not contradict what
      // the user just saw.
      $(STEP_TOGGLE[k]).checked = $(RESULT_TOGGLE[k]).checked;
      refreshAssetPanels();
      refresh();
    });
  });

  // A canvas cannot restyle itself the way CSS does when the OS flips to dark mode.
  Charts.onThemeChange(() => {
    if (step === RESULTS_STEP) refresh();
  });

  function calculate() {
    buildFormatters($("currency").value);
    model = Scenario.build(readParams());
    ASSET_KEYS.forEach((k) => {
      $(RESULT_TOGGLE[k]).checked = $(STEP_TOGGLE[k]).checked;
    });
    refresh();
  }

  const INT_FORMAT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
  const fmtInt = (v) => INT_FORMAT.format(Math.round(v));

  // A single neutral locale keeps grouping consistent across all 30 countries; only the
  // currency symbol varies. Formatters are rebuilt per render so a currency change applies.
  let fmt;
  function buildFormatters(currency) {
    const money = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    });
    // Tariffs are fractions of a unit, so they need their own formatter — the whole-unit one
    // rounds every per-kWh price to zero.
    const rate = new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const plain = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
    const fine = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
    fmt = {
      money: (v) => money.format(Math.round(v)),
      rate: (v) => rate.format(v),
      // A single hour of a single day is a kilowatt-hour or two, so whole-kWh rounding
      // collapses a day-profile axis into "2 kWh, 2 kWh, 1 kWh, 1 kWh".
      kwhFine: (v) => `${fine.format(v)} kWh`,
      kwh: (v) => `${plain.format(Math.round(v))} kWh`,
      pct: (v) => `${Math.round(v * 100)}%`,
      years: (v) => (isFinite(v) ? `${v.toFixed(1)} years` : "never"),
    };
  }

  // "a 8 kWh battery" reads wrong; pick the article from how the number is spoken.
  function article(n) {
    const s = String(n);
    return /^(8|11|18|8\d*)/.test(s) ? "an" : "a";
  }

  function bar(fraction) {
    const pct = Math.max(0, Math.min(100, fraction * 100));
    return `<div class="bar"><span style="width:${pct}%"></span></div>`;
  }

  // js/calc/scenario.js returns raw figures; the words are this layer's business.
  const ASSET_NAMES = { hp: "Heat pump", ev: "Electric car", ac: "Air conditioning" };

  function assetDetail(a) {
    if (a.key === "hp") {
      return `${fmtInt(a.heatDemandKwh)} kWh of heat at an average efficiency of ${a.seasonalCOP.toFixed(1)}`;
    }
    if (a.key === "ev") {
      return a.chargingStrategy === "solar"
        ? `${fmtInt(a.annualKm)} km a year, charged during the day`
        : `${fmtInt(a.annualKm)} km a year, charged on arrival home`;
    }
    return a.electricityKwh < 50
      ? "barely used at this location's summer temperatures"
      : `${fmtInt(a.coolingDemandKwh)} kWh of cooling`;
  }

  const batteryThroughput = Scenario.batteryThroughput;

  const withShare = (v, total) =>
    total > 0 ? `${fmt.kwh(v)} <span class="share">(${Math.round((v / total) * 100)}%)</span>` : fmt.kwh(v);

  // Sentence-cased list: "a heat pump", "a heat pump and an electric car", …
  function joinNames(names) {
    if (names.length <= 1) return names[0] || "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  function renderResults(r) {
    const m = model;
    const produced = r.chosen.totalProduction;
    const pvSaving = r.billNow - r.billPv;
    const pvWorthIt = r.pvNpv > 0;
    const batteryWorthIt = r.battery && r.battery.npv > 0;

    // The strip under the toggles: what this scenario is, and what switching the extras on
    // did to the size of the household.
    const activeNames = r.assetDeltas.map((a) => ASSET_NAMES[a.key].toLowerCase());
    const extraKwh = r.totalConsumption - r.baselineConsumption;
    $("scenarioSummary").textContent = activeNames.length
      ? `With ${joinNames(activeNames)}, your household uses ${fmt.kwh(r.totalConsumption)} a year — ` +
        `${fmt.kwh(extraKwh)} more than without. The solar and battery sizes stay exactly as you set them.`
      : `Your household as it is today: ${fmt.kwh(r.totalConsumption)} a year. ` +
        `Switch an extra on to see what it would change.`;

    let verdict;
    if (pvWorthIt) {
      verdict = `<h3>Solar looks worthwhile here.</h3>
        <p>A ${m.kwp.toFixed(1)} kWp system in ${m.site.name} should save about
        <strong>${fmt.money(pvSaving)} per year</strong> and pay for itself in about
        <strong>${fmt.years(r.pvPayback)}</strong>.</p>`;
    } else {
      verdict = `<h3>Solar is marginal at these numbers.</h3>
        <p>At the costs and tariffs you entered, a ${m.kwp.toFixed(1)} kWp system does not fully
        pay back over ${m.lifetimeYears} years. It may still be worth it for other reasons, and a
        lower installed price or higher electricity price would change the answer.</p>`;
    }
    $("verdict").innerHTML = verdict;

    const batterySection = r.hasBattery
      ? `<div class="result-block">
          <h3>Adding ${article(m.batteryKwh)} ${m.batteryKwh} kWh battery</h3>
          <p class="headline ${batteryWorthIt ? "good" : "bad"}">
            ${batteryWorthIt ? "+" : ""}${fmt.money(r.battery.npv)} over ${m.batteryLifetimeYears} years
          </p>
          <p class="hint headline-note">
            ${batteryWorthIt
              ? "The battery pays for itself on top of the solar system."
              : "The battery does not pay for itself — it buys independence, not savings."}
          </p>
          <dl class="kv">
            <dt>Self-sufficiency</dt><dd>${fmt.pct(r.pvOnly.selfSufficiencyRate)} &rarr; ${fmt.pct(r.withBattery.selfSufficiencyRate)}</dd>
            <dt>Extra solar you use yourself</dt><dd>${fmt.kwh(r.battery.extraSelfConsumed)}</dd>
            <dt>Battery cost</dt><dd>${fmt.money(m.batteryCapex)}</dd>
            <dt>Saving in year 1</dt><dd>${fmt.money(r.battery.year1Benefit)}</dd>
            <dt>Pays back in</dt><dd>${fmt.years(r.battery.paybackYears)}</dd>
            <dt>Yearly bill</dt><dd>${fmt.money(r.billBattery)}</dd>
          </dl>
        </div>`
      : `<div class="result-block">
          <h3>Battery</h3>
          <p class="hint">You set the battery size to 0, so we only looked at solar on its own.</p>
        </div>`;

    // This list doubles as the table view for the charts: every figure a chart encodes with
    // colour is also written out here in words, which is what the light-mode contrast relief
    // on the aqua and yellow series requires.
    $("results-body").innerHTML = `
      <div class="result-block">
        <h3>Solar on its own (${m.kwp.toFixed(1)} kWp)</h3>
        <p class="headline ${pvWorthIt ? "good" : "bad"}">
          ${pvWorthIt ? "+" : ""}${fmt.money(r.pvNpv)} over ${m.lifetimeYears} years
        </p>
        <dl class="kv">
          <dt>Yearly bill now</dt><dd>${fmt.money(r.billNow)}</dd>
          <dt>Yearly bill with solar</dt><dd>${fmt.money(r.billPv)}</dd>
          <dt>Yearly saving</dt><dd>${fmt.money(pvSaving)}</dd>
          <dt>System cost</dt><dd>${fmt.money(m.pvCapex)}</dd>
          <dt>Pays back in</dt><dd>${fmt.years(r.pvPayback)}</dd>
        </dl>
      </div>

      ${batterySection}

      <div class="result-block">
        <h3>Where your solar output went</h3>
        <dl class="kv">
          <dt>Produced per year</dt><dd>${fmt.kwh(r.chosen.totalProduction)}</dd>
          <dt>Used straight away</dt><dd>${withShare(r.chosen.directSelfConsumed, produced)}</dd>
          ${r.hasBattery
            ? `<dt>Stored in the battery</dt><dd>${withShare(batteryThroughput(r.chosen), produced)}</dd>
               <dt class="sub">…of which came back out</dt><dd>${fmt.kwh(r.chosen.batteryDischargeToLoad)}</dd>
               <dt class="sub">…of which lost charging</dt><dd>${withShare(r.chosen.chargeLosses + r.chosen.dischargeLosses, produced)}</dd>`
            : ""}
          <dt>Sent to the grid</dt><dd>${withShare(r.chosen.exported, produced)}</dd>
          <dt>Of your output, used on site</dt><dd>${fmt.pct(r.chosen.selfConsumptionRate)}</dd>
        </dl>
        ${bar(r.chosen.selfConsumptionRate)}
        <dl class="kv">
          <dt>Still bought from the grid</dt><dd>${fmt.kwh(r.chosen.imported)}</dd>
          <dt>Share of your use covered by solar</dt><dd>${fmt.pct(r.chosen.selfSufficiencyRate)}</dd>
        </dl>
        ${bar(r.chosen.selfSufficiencyRate)}
      </div>
    `;

    // Each asset is shown against the same solar+battery system, so the figures answer
    // "what does adding this do to me?" rather than "what system should I buy instead?".
    $("results-extras").innerHTML = r.assetDeltas.length
      ? `<div class="result-block">
          <h3>What your extras change</h3>
          <p class="hint">
            Each line adds that one item to your household on its own, on top of the same
            ${m.kwp.toFixed(1)} kWp system${r.hasBattery ? ` and ${m.batteryKwh} kWh battery` : ""}.
          </p>
          <div class="delta-list">
            ${r.assetDeltas
              .map((a) => {
                const drop = a.selfSufficiencyFrom - a.selfSufficiencyTo;
                const direction =
                  drop > 0.005
                    ? `self-sufficiency falls ${fmt.pct(a.selfSufficiencyFrom)} &rarr; ${fmt.pct(a.selfSufficiencyTo)}`
                    : drop < -0.005
                    ? `self-sufficiency rises ${fmt.pct(a.selfSufficiencyFrom)} &rarr; ${fmt.pct(a.selfSufficiencyTo)}`
                    : `self-sufficiency barely moves (${fmt.pct(a.selfSufficiencyTo)})`;
                return `<div class="delta">
                    <span class="name">${ASSET_NAMES[a.key]}</span>
                    <span class="figure">+${fmt.kwh(a.electricityKwh)}/yr</span>
                    <span class="note">
                      ${assetDetail(a)}. Of that, ${fmt.kwh(a.extraSelfConsumed)} comes from your own
                      roof and ${fmt.kwh(a.extraImport)} from the grid — ${direction}.
                    </span>
                  </div>`;
              })
              .join("")}
          </div>
        </div>`
      : "";

    const assetAssumptions = [];
    if (r.assetDeltas.some((a) => a.key === "hp")) {
      assetAssumptions.push(
        `<li><strong>Heat pump:</strong> space heating only — hot water is not included, so a
        heat pump that also heats your water will use more. Its efficiency is calculated hour by
        hour and falls in cold weather, which is why the winter figures look worse than a single
        headline efficiency would suggest.</li>`
      );
    }
    if (r.assetDeltas.some((a) => a.key === "ev")) {
      assetAssumptions.push(
        `<li><strong>Electric car:</strong> the same amount is charged every day of the year, so
        holidays and long trips are averaged away. Daytime charging assumes the car is at home
        and plugged in on weekday afternoons.</li>`
      );
    }
    if (r.assetDeltas.some((a) => a.key === "ac")) {
      assetAssumptions.push(
        `<li><strong>Air conditioning:</strong> cooling is estimated from how far summer
        temperatures rise above ${LoadProfiles.COOLING_BASE_C} °C, not from your building's
        insulation or how you actually use it.</li>`
      );
    }

    $("assumptions-body").innerHTML = `
      <ul>
        <li><strong>Screening estimate, not a quote.</strong> Treat these numbers as a first
        indication, not an engineering study or a financial promise. A proper design tool
        optimises the system; this one tests the system you described.</li>
        <li><strong>Sunlight and temperature</strong> are PVGIS measurements for
        ${m.site.name} (${m.country}) itself. If you live well above or below the town —
        common in valleys and hill country — your own conditions will differ.</li>
        ${assetAssumptions.join("\n")}
        <li><strong>Your electricity use</strong> is spread over the year using a typical
        household pattern scaled to the ${fmt.kwh(m.consumption)} you entered — not your real
        meter data. A household that is out all day will see less benefit than this;
        one at home during the day will see more.${
          r.assetDeltas.length
            ? ` With your extras added, total use comes to ${fmt.kwh(r.totalConsumption)} a year.`
            : ""
        }</li>
        <li><strong>The extras are tested against a fixed system.</strong> Switching a heat
        pump, car or air conditioner on never resizes the ${m.kwp.toFixed(1)} kWp of panels
        ${m.batteryKwh > 0 ? `or the ${m.batteryKwh} kWh battery ` : ""}— that is deliberate,
        so the change you see is the extra's doing and not a different system's. A larger
        system would usually suit a bigger household better.</li>
        <li><strong>No shading</strong> from trees, chimneys or neighbouring buildings is
        modelled.</li>
        <li><strong>Battery control</strong> is a simple rule: store surplus, use it when short.
        It does not trade on prices or plan ahead, so a smart system could do slightly better.</li>
        <li><strong>Weather variability</strong> between days is smoothed out, which makes the
        battery look slightly better than it would be in a real year. The typical-day charts
        are month averages for the same reason: a real day is spikier than either curve, so
        never read a peak or a fuse size off them.</li>
        <li><strong>The battery is judged on what it adds</strong>, not on your whole bill: its
        cost is set against the extra solar it lets you keep instead of exporting. That makes
        the gap between your ${fmt.rate(m.econOpts.retailPrice)}/kWh purchase price and your
        ${fmt.rate(m.econOpts.feedInTariff)}/kWh export price the number that decides it.</li>
        <li><strong>Money:</strong> ${m.lifetimeYears}-year life, ${m.discountRatePct}% discount
        rate, panels losing 0.5% output per year, maintenance at 1% of system cost per year,
        electricity prices rising ${m.econOpts.tariffEscalationPct}% per year. All amounts are
        in the currency you selected; no exchange rates are applied. The money chart shows the
        plain running total, so it crosses zero at the payback year quoted above; the
        ${fmt.money(r.pvNpv)} headline is the same cash flow discounted back to today, which is
        why the two figures differ.</li>
      </ul>`;
  }

  // ---- charts ----------------------------------------------------------------
  function renderCharts(r) {
    const m = model;
    const monthly = r.chosen.buckets;

    Charts.monthly("chartMonthly", {
      labels: Aggregate.MONTH_LABELS,
      direct: monthly.map((b) => b.directSelfConsumed),
      battery: monthly.map((b) => b.batteryDischargeToLoad),
      grid: monthly.map((b) => b.imported),
      hasBattery: r.hasBattery,
      kwhFmt: fmt.kwh,
    });

    // Without a battery the split is two slices — "used" and "exported" — and a two-slice
    // doughnut says less than the one percentage already printed above it.
    $("card-split").hidden = !r.hasBattery;
    if (r.hasBattery) {
      Charts.split("chartSplit", {
        direct: r.chosen.directSelfConsumed,
        throughBattery: batteryThroughput(r.chosen),
        exported: r.chosen.exported,
        kwhFmt: fmt.kwh,
      });
    }

    Charts.cashFlow("chartCash", {
      years: r.cashFlow.years,
      solar: r.cashFlow.solar,
      battery: r.cashFlow.battery,
      moneyFmt: fmt.money,
    });

    const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
    [["chartSummer", "summerTitle", 0], ["chartWinter", "winterTitle", 1]].forEach(
      ([canvasId, titleId, slot]) => {
        $(titleId).textContent = Aggregate.DAY_PROFILES[slot].label;
        Charts.dayProfile(canvasId, {
          hours,
          production: Aggregate.dayProfile(r.dayFlows.buckets, slot, "production"),
          load: Aggregate.dayProfile(r.dayFlows.buckets, slot, "load"),
          kwhFmt: fmt.kwhFine,
        });
      }
    );

  }

  render();
});
