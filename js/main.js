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
//
// Milestone 9 made those sentences translatable. Every one of them is now a whole sentence in
// js/i18n/<lang>.json with {named} slots, never prose assembled from fragments: word order,
// grammatical gender and the position of a number inside a clause all move between languages,
// and a sentence glued together at run time cannot follow them. Only numbers are interpolated.

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (id) => document.getElementById(id);
  const num = (id) => Number($(id).value);
  // Detail fields inside a switched-off asset panel are skipped by validation, so they can
  // still hold something unusable when the results page reaches for them.
  const numOr = (id, fallback) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  const t = (key, vars) => I18n.t(key, vars);
  // fetch() only rejects on a network failure: a 404 arrives as an HTML body and would fail
  // much later as a syntax error, so the status is checked where it is still legible.
  const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
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
  // The catalogue is fetched alongside the site data rather than after it: the page holds its
  // English fallback text until this resolves, so there is nothing to hide in the meantime.
  // I18n.init() cannot reject — a missing catalogue leaves the inline English standing — so a
  // rejection here is always the site data, and the wizard is unusable without it.
  try {
    const [, citiesData] = await Promise.all([
      PV.load(),
      fetchJson("js/data/cities.json"),
      I18n.init(),
    ]);
    cities = citiesData;
  } catch (err) {
    showDataError(err);
    return;
  }

  function showDataError(err) {
    console.error("Site data failed to load:", err);
    $("wizard").hidden = true;
    $("stepper").hidden = true;
    $("dataErrorPanel").hidden = false;
    $("dataErrorRetry").addEventListener("click", () => window.location.reload());
  }

  // ---- step 1 population -----------------------------------------------------
  // Country names are resolved from their ISO code through Intl, so they follow the language;
  // city names are GeoNames endonyms and are never translated. Sorting has to follow the
  // language too — an alphabetical list is only alphabetical in the alphabet it was sorted in.
  const countrySelect = $("country");
  function populateCountries() {
    const chosen = countrySelect.value || "CH";
    const collator = I18n.collator();
    countrySelect.innerHTML = cities.countries
      .map((c) => ({ code: c.code, name: I18n.country(c.code, c.name) }))
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((c) => `<option value="${c.code}">${c.name}</option>`)
      .join("");
    countrySelect.value = chosen;
  }
  populateCountries();

  function populateCities() {
    const list = cities.cities[countrySelect.value] || [];
    $("city").innerHTML = list
      .map((c, i) => `<option value="${i}">${c.name}</option>`)
      .join("");
  }
  // Currency follows the country by default but stays user-editable — border regions and
  // expatriate billing do not always match the map. It is deliberately independent of the
  // language: a French speaker in Switzerland still wants CHF.
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

  // ---- number formatting -----------------------------------------------------
  // Grouping and decimal marks follow the language (1,234.5 / 1.234,5 / 1 234,5), so every
  // formatter is rebuilt when the language changes. The currency does not follow the language;
  // no exchange rate is applied anywhere.
  const decimal = (v, digits) =>
    new Intl.NumberFormat(I18n.locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v);
  const integer = (v) =>
    new Intl.NumberFormat(I18n.locale, { maximumFractionDigits: 0 }).format(Math.round(v));
  // "8.0 kWh battery" reads wrong and "8.5" must not become "9": show a decimal only when
  // there is one.
  const compact = (v) =>
    new Intl.NumberFormat(I18n.locale, { maximumFractionDigits: 1 }).format(v);

  let fmt;
  function buildFormatters(currency) {
    const money = new Intl.NumberFormat(I18n.locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    });
    // Tariffs are fractions of a unit, so they need their own formatter — the whole-unit one
    // rounds every per-kWh price to zero.
    const rate = new Intl.NumberFormat(I18n.locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    fmt = {
      money: (v) => money.format(Math.round(v)),
      signedMoney: (v) =>
        v > 0 ? `+${money.format(Math.round(v))}` : money.format(Math.round(v)),
      rate: (v) => rate.format(v),
      // A single hour of a single day is a kilowatt-hour or two, so whole-kWh rounding
      // collapses a day-profile axis into "2 kWh, 2 kWh, 1 kWh, 1 kWh".
      kwhFine: (v) => t("unit.kwh", { value: decimal(v, 1) }),
      kwh: (v) => t("unit.kwh", { value: integer(v) }),
      pct: (v) =>
        new Intl.NumberFormat(I18n.locale, { style: "percent", maximumFractionDigits: 0 })
          .format(v),
      years: (v) => (isFinite(v) ? t("unit.years", { value: decimal(v, 1) }) : t("unit.never")),
      kwp: (v) => decimal(v, 1),
      num: (v) => compact(v),
    };
  }
  buildFormatters($("currency").value);

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
        ? t("sizing.fromArea", { kwp: decimal(kwp, 1) })
        : t("sizing.fromKwp", { area: integer(kwp / (USABLE_AREA_FRACTION * KWP_PER_M2)) });
  }

  document
    .querySelectorAll('input[name="sizeMode"], #roofArea, #kwp')
    .forEach((el) => el.addEventListener("input", refreshSizing));

  // ---- step 3: assets --------------------------------------------------------
  // The building-standard list is data plus a catalogue key: js/data/load-profiles.js holds the
  // kWh/m² and the key, this turns the key into words.
  function populateBuildingStandards() {
    const select = $("hpStandard");
    const chosen = select.value || "mid";
    select.innerHTML = Object.entries(LoadProfiles.BUILDING_STANDARDS)
      .map(([key, def]) => `<option value="${key}">${t(def.labelKey)}</option>`)
      .join("");
    select.value = chosen;
  }
  populateBuildingStandards();

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
    let firstBad = null;

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
        if (!firstBad) firstBad = input;
        // The label is already in the reader's language — it is read out of the page, not out
        // of the catalogue a second time.
        const label = section.querySelector(`label[for="${input.id}"]`);
        problems.push(label ? label.textContent.trim() : input.id);
      }
    });

    // Naming the bad fields in an error message is only half an answer: it leaves a keyboard
    // user to go and find them. Focus the first one, so "Continue" always lands the caret on
    // the thing that has to change.
    if (firstBad) firstBad.focus({ preventScroll: false });
    return problems;
  }

  // ---- navigation ------------------------------------------------------------
  // Moving between steps swaps the whole form out from under the reader. Sighted users get
  // the scroll to the top; someone on a screen reader or a keyboard gets nothing unless focus
  // is moved with it — the old focus lands on a display:none element, focus falls back to
  // <body>, and the next Tab starts again from the top of the page. So focus goes to the new
  // step's heading, which also makes the reader announce where it now is.
  //
  // Not on the first render: stealing focus on page load would drop a keyboard user past the
  // header and the language picker, and a reader would start mid-page.
  let firstRender = true;

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
    $("nextBtn").textContent =
      step === RESULTS_STEP - 1 ? t("nav.seeResults") : t("nav.continue");
    $("formError").hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (firstRender) {
      firstRender = false;
      return;
    }
    // preventScroll because the smooth scroll above is already taking the page to the top;
    // letting focus scroll as well fights it and lands somewhere in between.
    const heading = document.querySelector(`.step[data-step="${step}"] h2`);
    if (heading) heading.focus({ preventScroll: true });
  }

  $("nextBtn").addEventListener("click", () => {
    const problems = validateStep(step);
    if (problems.length) {
      const err = $("formError");
      err.textContent = t("error.checkFields", { fields: I18n.list(problems) });
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

  // Nor can it relabel itself, and none of the generated prose is in the DOM that I18n.apply()
  // walks. The model is language-independent, so a language change costs a re-render and never
  // a rebuild.
  I18n.onChange(() => {
    populateCountries();
    populateBuildingStandards();
    buildFormatters($("currency").value);
    refreshSizing();
    render();
    if (step === RESULTS_STEP) refresh();
  });

  // ---- hand-off to comparison mode -------------------------------------------
  // Everything the user answered travels in the URL, so the comparison page opens on their
  // house and their kit rather than on a blank form. The extras taken across are the ones
  // showing on the results page right now, not the ones ticked back on step 3 — those are the
  // same thing, but the results page is what the user is looking at.
  $("compareBtn").addEventListener("click", () => {
    const enabled = enabledAssets();
    const query = ShareState.encode({
      // The language rides along with the scenario, so a link pasted to a neighbour arrives in
      // the language it was sent in.
      lang: I18n.lang,
      country: countrySelect.value,
      cityName: selectedCity().name,
      orientation: $("orientation").value,
      tilt: $("tilt").value,
      consumption: $("consumption").value,
      currency: $("currency").value,
      retailPrice: $("retailPrice").value,
      feedInTariff: $("feedInTariff").value,
      capexPerKwp: $("capexPerKwp").value,
      batteryCapexPerKwh: $("batteryCapexPerKwh").value,
      discountRate: $("discountRate").value,
      lifetime: $("lifetime").value,
      batteryLifetime: $("batteryLifetime").value,
      roundTrip: $("roundTrip").value,
      performanceRatio: $("performanceRatio").value,
      tariffEscalation: $("tariffEscalation").value,
      // The wizard can size by roof area, so send the kWp it actually worked from.
      kwp: systemKwp().toFixed(2),
      batteryKwh: $("batteryKwh").value,
      hp: enabled.hp,
      ev: enabled.ev,
      ac: enabled.ac,
      hpArea: $("hpArea").value,
      hpStandard: $("hpStandard").value,
      hpSupply: $("hpSupply").value,
      evKm: $("evKm").value,
      evEfficiency: $("evEfficiency").value,
      evStrategy: $("evStrategy").value,
      acArea: $("acArea").value,
      acSeer: $("acSeer").value,
    });
    window.location.href = `compare.html?${query}`;
  });

  function calculate() {
    buildFormatters($("currency").value);
    model = Scenario.build(readParams());
    ASSET_KEYS.forEach((k) => {
      $(RESULT_TOGGLE[k]).checked = $(STEP_TOGGLE[k]).checked;
    });
    refresh();
  }

  function bar(fraction) {
    const pct = Math.max(0, Math.min(100, fraction * 100));
    return `<div class="bar"><span style="width:${pct}%"></span></div>`;
  }

  // js/calc/scenario.js returns raw figures; the words are this layer's business.
  const assetName = (key) => t(`asset.${key}.name`);
  // The three whose purchase price the tool does not model.
  const uncostedName = (key) => t(`uncosted.${key}`);

  // One whole sentence per case per language, never a stem plus a suffix.
  function assetDetail(a) {
    if (a.key === "hp") {
      return t("results.extras.detail.hp", {
        heat: integer(a.heatDemandKwh),
        cop: decimal(a.seasonalCOP, 1),
      });
    }
    if (a.key === "ev") {
      const key =
        a.chargingStrategy === "solar"
          ? "results.extras.detail.ev.solar"
          : "results.extras.detail.ev.dumb";
      return t(key, { km: integer(a.annualKm) });
    }
    return a.electricityKwh < 50
      ? t("results.extras.detail.ac.negligible")
      : t("results.extras.detail.ac", { cooling: integer(a.coolingDemandKwh) });
  }

  const batteryThroughput = Scenario.batteryThroughput;

  const withShare = (v, total) =>
    total > 0
      ? `${fmt.kwh(v)} <span class="share">(${fmt.pct(v / total)})</span>`
      : fmt.kwh(v);

  function renderResults(r) {
    const m = model;
    const produced = r.chosen.totalProduction;
    const pvSaving = r.billNow - r.billPv;
    const pvWorthIt = r.pvNpv > 0;
    const batteryWorthIt = r.battery && r.battery.npv > 0;
    const kwp = fmt.kwp(m.kwp);
    const batteryKwh = fmt.num(m.batteryKwh);

    // The strip under the toggles: what this scenario is, and what switching the extras on
    // did to the size of the household.
    const activeNames = r.assetDeltas.map((a) => t(`asset.${a.key}.nameLower`));
    const extraKwh = r.totalConsumption - r.baselineConsumption;
    $("scenarioSummary").textContent = activeNames.length
      ? t("results.scenario.with", {
          extras: I18n.list(activeNames),
          total: fmt.kwh(r.totalConsumption),
          extra: fmt.kwh(extraKwh),
        })
      : t("results.scenario.none", { total: fmt.kwh(r.totalConsumption) });

    // Only the panels and the battery are costed. An extra changes the electricity bill, and
    // that change is in every figure below — but buying the thing is not, and a reader
    // comparing one money figure against another needs to be told that here, not in a panel
    // at the bottom of the page.
    const uncosted = r.assetDeltas.map((a) => uncostedName(a.key));
    $("costNotice").hidden = uncosted.length === 0;
    if (uncosted.length) {
      $("costNotice").innerHTML = t("notice.uncosted", { items: I18n.list(uncosted) });
    }

    $("verdict").innerHTML = pvWorthIt
      ? `<h3>${t("results.verdict.good.title")}</h3>
         <p>${t("results.verdict.good.body", {
           kwp,
           city: m.site.name,
           saving: fmt.money(pvSaving),
           payback: fmt.years(r.pvPayback),
         })}</p>`
      : `<h3>${t("results.verdict.marginal.title")}</h3>
         <p>${t("results.verdict.marginal.body", { kwp, years: m.lifetimeYears })}</p>`;

    const batterySection = r.hasBattery
      ? `<div class="result-block">
          <h3>${t("results.battery.title", { kwh: batteryKwh })}</h3>
          <p class="headline ${batteryWorthIt ? "good" : "bad"}">
            ${t("results.headline.npv", {
              npv: fmt.signedMoney(r.battery.npv),
              years: m.batteryLifetimeYears,
            })}
          </p>
          <p class="hint headline-note">
            ${batteryWorthIt ? t("results.battery.note.good") : t("results.battery.note.bad")}
          </p>
          <dl class="kv">
            <dt>${t("results.battery.selfSufficiency")}</dt><dd>${fmt.pct(r.pvOnly.selfSufficiencyRate)} &rarr; ${fmt.pct(r.withBattery.selfSufficiencyRate)}</dd>
            <dt>${t("results.battery.extraSelfConsumed")}</dt><dd>${fmt.kwh(r.battery.extraSelfConsumed)}</dd>
            <dt>${t("results.battery.cost")}</dt><dd>${fmt.money(m.batteryCapex)}</dd>
            <dt>${t("results.battery.year1")}</dt><dd>${fmt.money(r.battery.year1Benefit)}</dd>
            <dt>${t("results.battery.payback")}</dt><dd>${fmt.years(r.battery.paybackYears)}</dd>
            <dt>${t("results.battery.yearlyBill")}</dt><dd>${fmt.money(r.billBattery)}</dd>
          </dl>
        </div>`
      : `<div class="result-block">
          <h3>${t("results.battery.none.title")}</h3>
          <p class="hint">${t("results.battery.none.body")}</p>
        </div>`;

    // This list doubles as the table view for the charts: every figure a chart encodes with
    // colour is also written out here in words, which is what the light-mode contrast relief
    // on the aqua and yellow series requires.
    $("results-body").innerHTML = `
      <div class="result-block">
        <h3>${t("results.pv.title", { kwp })}</h3>
        <p class="headline ${pvWorthIt ? "good" : "bad"}">
          ${t("results.headline.npv", {
            npv: fmt.signedMoney(r.pvNpv),
            years: m.lifetimeYears,
          })}
        </p>
        <dl class="kv">
          <dt>${t("results.pv.billNow")}</dt><dd>${fmt.money(r.billNow)}</dd>
          <dt>${t("results.pv.billWithPv")}</dt><dd>${fmt.money(r.billPv)}</dd>
          <dt>${t("results.pv.yearlySaving")}</dt><dd>${fmt.money(pvSaving)}</dd>
          <dt>${t("results.pv.systemCost")}</dt><dd>${fmt.money(m.pvCapex)}</dd>
          <dt>${t("results.pv.payback")}</dt><dd>${fmt.years(r.pvPayback)}</dd>
        </dl>
      </div>

      ${batterySection}

      <div class="result-block">
        <h3>${t("results.output.title")}</h3>
        <dl class="kv">
          <dt>${t("results.output.produced")}</dt><dd>${fmt.kwh(r.chosen.totalProduction)}</dd>
          <dt>${t("results.output.direct")}</dt><dd>${withShare(r.chosen.directSelfConsumed, produced)}</dd>
          ${r.hasBattery
            ? `<dt>${t("results.output.stored")}</dt><dd>${withShare(batteryThroughput(r.chosen), produced)}</dd>
               <dt class="sub">${t("results.output.storedOut")}</dt><dd>${fmt.kwh(r.chosen.batteryDischargeToLoad)}</dd>
               <dt class="sub">${t("results.output.storedLost")}</dt><dd>${withShare(r.chosen.chargeLosses + r.chosen.dischargeLosses, produced)}</dd>`
            : ""}
          <dt>${t("results.output.exported")}</dt><dd>${withShare(r.chosen.exported, produced)}</dd>
          <dt>${t("results.output.selfConsumption")}</dt><dd>${fmt.pct(r.chosen.selfConsumptionRate)}</dd>
        </dl>
        ${bar(r.chosen.selfConsumptionRate)}
        <dl class="kv">
          <dt>${t("results.output.imported")}</dt><dd>${fmt.kwh(r.chosen.imported)}</dd>
          <dt>${t("results.output.selfSufficiency")}</dt><dd>${fmt.pct(r.chosen.selfSufficiencyRate)}</dd>
        </dl>
        ${bar(r.chosen.selfSufficiencyRate)}
      </div>
    `;

    // Each asset is shown against the same solar+battery system, so the figures answer
    // "what does adding this do to me?" rather than "what system should I buy instead?".
    $("results-extras").innerHTML = r.assetDeltas.length
      ? `<div class="result-block">
          <h3>${t("results.extras.title")}</h3>
          <p class="hint">
            ${r.hasBattery
              ? t("results.extras.hint.withBattery", { kwp, kwh: batteryKwh })
              : t("results.extras.hint.pvOnly", { kwp })}
          </p>
          <div class="delta-list">
            ${r.assetDeltas
              .map((a) => {
                const drop = a.selfSufficiencyFrom - a.selfSufficiencyTo;
                const from = fmt.pct(a.selfSufficiencyFrom);
                const to = fmt.pct(a.selfSufficiencyTo);
                const direction =
                  drop > 0.005
                    ? t("results.extras.dir.falls", { from, to })
                    : drop < -0.005
                    ? t("results.extras.dir.rises", { from, to })
                    : t("results.extras.dir.flat", { to });
                return `<div class="delta">
                    <span class="name">${assetName(a.key)}</span>
                    <span class="figure">${t("results.extras.figure", {
                      kwh: fmt.kwh(a.electricityKwh),
                    })}</span>
                    <span class="note">
                      ${t("results.extras.note", {
                        detail: assetDetail(a),
                        own: fmt.kwh(a.extraSelfConsumed),
                        grid: fmt.kwh(a.extraImport),
                        direction,
                      })}
                    </span>
                  </div>`;
              })
              .join("")}
          </div>
        </div>`
      : "";

    const assetAssumptions = ASSET_KEYS.filter((k) => r.assetDeltas.some((a) => a.key === k)).map(
      (k) =>
        `<li>${
          k === "ac"
            ? t("assump.ac", { base: LoadProfiles.COOLING_BASE_C })
            : t(`assump.${k}`)
        }</li>`
    );

    $("assumptions-body").innerHTML = `
      <ul>
        <li>${t("assump.screening")}</li>
        <li>${t("assump.uncosted")}</li>
        <li>${t("assump.data", {
          city: m.site.name,
          // Read off the (already localised) dropdown at render time rather than carried on
          // the model: the model outlives a language change, the country's name does not.
          country: countrySelect.options[countrySelect.selectedIndex].text,
        })}</li>
        ${assetAssumptions.join("\n")}
        <li>${
          r.assetDeltas.length
            ? t("assump.load.withExtras", {
                consumption: fmt.kwh(m.consumption),
                total: fmt.kwh(r.totalConsumption),
              })
            : t("assump.load", { consumption: fmt.kwh(m.consumption) })
        }</li>
        <li>${
          m.batteryKwh > 0
            ? t("assump.fixed.withBattery", { kwp, kwh: batteryKwh })
            : t("assump.fixed", { kwp })
        }</li>
        <li>${t("assump.shading")}</li>
        <li>${t("assump.dispatch")}</li>
        <li>${t("assump.weather")}</li>
        <li>${t("assump.batteryIncremental", {
          retail: fmt.rate(m.econOpts.retailPrice),
          feedIn: fmt.rate(m.econOpts.feedInTariff),
        })}</li>
        <li>${t("assump.money", {
          years: m.lifetimeYears,
          rate: m.discountRatePct,
          escalation: m.econOpts.tariffEscalationPct,
          npv: fmt.money(r.pvNpv),
        })}</li>
      </ul>
      <p class="hint">${t("assump.methodLink")}</p>`;
  }

  // ---- charts ----------------------------------------------------------------
  function renderCharts(r) {
    const monthly = r.chosen.buckets;

    Charts.monthly("chartMonthly", {
      labels: Aggregate.monthLabels(I18n.locale),
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
        $(titleId).textContent = t(Aggregate.DAY_PROFILES[slot].labelKey);
        Charts.dayProfile(canvasId, {
          hours,
          production: Aggregate.dayProfile(r.dayFlows.buckets, slot, "production"),
          load: Aggregate.dayProfile(r.dayFlows.buckets, slot, "load"),
          kwhFmt: fmt.kwhFine,
        });
      }
    );
  }

  refreshSizing();
  render();
});
