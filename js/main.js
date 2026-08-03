// Wizard shell + results rendering (Section 7 of the build plan).
//
// Step 3 (HP/EV/AC toggles) is scaffolded but not implemented — milestone 4. Charts land in
// milestone 5; results are currently text and simple CSS bars so the numbers can be checked
// before any visual layer is added on top of them.

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (id) => document.getElementById(id);
  const num = (id) => Number($(id).value);

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

  // ---- calculation + results -------------------------------------------------
  function calculate() {
    // The city record itself is the site: it carries measured yield, seasonal shape and
    // temperatures for its own coordinates.
    const site = selectedCity();
    const tilt = num("tilt");
    const aspect = num("orientation");
    const kwp = systemKwp();
    const consumption = num("consumption");

    const retailPrice = num("retailPrice");
    const feedInTariff = num("feedInTariff");
    const capexPerKwp = num("capexPerKwp");
    const batteryCapexPerKwh = num("batteryCapexPerKwh");
    const batteryKwh = num("batteryKwh");
    const discountRatePct = num("discountRate");
    const lifetimeYears = num("lifetime");
    const batteryLifetimeYears = num("batteryLifetime");
    const roundTripEfficiency = num("roundTrip");
    const performanceRatio = num("performanceRatio");
    const tariffEscalationPct = num("tariffEscalation");

    const production = PV.hourlyProduction({ site, kwp, tilt, aspect, performanceRatio });
    const baseLoad = LoadProfiles.baseLoad({ annualKwh: consumption });
    const temps = Climate.hourlyTemperature({ site });

    // Each asset is an independent series added on top of the base household load. The
    // PV and battery configuration stays fixed across every combination (Section 2), so the
    // deltas below are attributable to the asset rather than to a resized system.
    const assets = [];
    if ($("hpEnabled").checked) {
      const mode = document.querySelector('input[name="hpMode"]:checked').value;
      const hp = LoadProfiles.heatPumpLoad({
        temps,
        annualHeatKwh: mode === "kwh" ? num("hpHeatKwh") : null,
        floorAreaM2: num("hpArea"),
        standard: $("hpStandard").value,
        supplyTempC: num("hpSupply"),
      });
      assets.push({
        key: "hp",
        name: "Heat pump",
        series: hp.series,
        electricityKwh: hp.electricityKwh,
        detail: `${fmtInt(hp.heatDemandKwh)} kWh of heat at an average efficiency of ${hp.seasonalCOP.toFixed(1)}`,
      });
    }
    if ($("evEnabled").checked) {
      const ev = LoadProfiles.evLoad({
        annualKm: num("evKm"),
        kwhPer100km: num("evEfficiency"),
        chargingStrategy: $("evStrategy").value,
      });
      assets.push({
        key: "ev",
        name: "Electric car",
        series: ev.series,
        electricityKwh: ev.electricityKwh,
        detail:
          $("evStrategy").value === "solar"
            ? `${fmtInt(num("evKm"))} km a year, charged during the day`
            : `${fmtInt(num("evKm"))} km a year, charged on arrival home`,
      });
    }
    if ($("acEnabled").checked) {
      const ac = LoadProfiles.acLoad({
        temps,
        floorAreaM2: num("acArea"),
        seer: num("acSeer"),
      });
      assets.push({
        key: "ac",
        name: "Air conditioning",
        series: ac.series,
        electricityKwh: ac.electricityKwh,
        detail:
          ac.electricityKwh < 50
            ? "barely used at this location's summer temperatures"
            : `${fmtInt(ac.coolingDemandKwh)} kWh of cooling`,
      });
    }

    const load = assets.length
      ? LoadProfiles.add(baseLoad, ...assets.map((a) => a.series))
      : baseLoad;
    const totalConsumption = LoadProfiles.sum(load);

    const noPv = { selfConsumed: 0, exported: 0, imported: totalConsumption };
    const pvOnly = Dispatch.simulate({ production, load, usableCapacityKwh: 0 });
    const withBattery = Dispatch.simulate({
      production,
      load,
      usableCapacityKwh: batteryKwh,
      roundTripEfficiency,
    });

    // Per-asset effect: base household load plus this one asset, against the same system.
    const baselineFlows = Dispatch.simulate({
      production,
      load: baseLoad,
      usableCapacityKwh: batteryKwh,
      roundTripEfficiency,
    });
    const assetDeltas = assets.map((asset) => {
      const withAsset = Dispatch.simulate({
        production,
        load: LoadProfiles.add(baseLoad, asset.series),
        usableCapacityKwh: batteryKwh,
        roundTripEfficiency,
      });
      return {
        ...asset,
        selfSufficiencyFrom: baselineFlows.selfSufficiencyRate,
        selfSufficiencyTo: withAsset.selfSufficiencyRate,
        extraImport: withAsset.imported - baselineFlows.imported,
        extraSelfConsumed: withAsset.selfConsumed - baselineFlows.selfConsumed,
      };
    });

    const pvCapex = kwp * capexPerKwp;
    const batteryCapex = batteryKwh * batteryCapexPerKwh;
    const econOpts = { retailPrice, feedInTariff, tariffEscalationPct };

    const pvNpv = Economics.npv({
      capex: pvCapex,
      flows: pvOnly,
      discountRatePct,
      lifetimeYears,
      ...econOpts,
    });
    const pvPayback = Economics.simplePaybackYears({
      capex: pvCapex,
      flows: pvOnly,
      lifetimeYears,
      ...econOpts,
    });

    buildFormatters($("currency").value);

    const battery = batteryKwh > 0
      ? Economics.batteryIncrement({
          flowsWithout: pvOnly,
          flowsWith: withBattery,
          batteryCapex,
          discountRatePct,
          lifetimeYears,
          batteryLifetimeYears,
          ...econOpts,
        })
      : null;

    const billNow = Economics.annualBill({ flows: noPv, ...econOpts });
    const billPv = Economics.annualBill({ flows: pvOnly, ...econOpts });
    const billBattery = Economics.annualBill({ flows: withBattery, ...econOpts });

    renderResults({
      city: site,
      country: countrySelect.options[countrySelect.selectedIndex].text,
      kwp,
      consumption,
      totalConsumption,
      assetDeltas,
      pvOnly,
      withBattery,
      batteryKwh,
      pvCapex,
      batteryCapex,
      pvNpv,
      pvPayback,
      battery,
      billNow,
      billPv,
      billBattery,
      lifetimeYears,
      batteryLifetimeYears,
      retailPrice,
      feedInTariff,
      tariffEscalationPct,
    });
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
    const plain = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
    fmt = {
      money: (v) => money.format(Math.round(v)),
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

  function renderResults(r) {
    const pvSaving = r.billNow - r.billPv;
    const pvWorthIt = r.pvNpv > 0;
    const batteryWorthIt = r.battery && r.battery.npv > 0;

    let verdict;
    if (pvWorthIt) {
      verdict = `<h3>Solar looks worthwhile here.</h3>
        <p>A ${r.kwp.toFixed(1)} kWp system in ${r.city.name} should save about
        <strong>${fmt.money(pvSaving)} per year</strong> and pay for itself in about
        <strong>${fmt.years(r.pvPayback)}</strong>.</p>`;
    } else {
      verdict = `<h3>Solar is marginal at these numbers.</h3>
        <p>At the costs and tariffs you entered, a ${r.kwp.toFixed(1)} kWp system does not fully
        pay back over ${r.lifetimeYears} years. It may still be worth it for other reasons, and a
        lower installed price or higher electricity price would change the answer.</p>`;
    }
    $("verdict").innerHTML = verdict;

    const batterySection = r.batteryKwh > 0
      ? `<div class="result-block">
          <h3>Adding ${article(r.batteryKwh)} ${r.batteryKwh} kWh battery</h3>
          <p class="headline ${batteryWorthIt ? "good" : "bad"}">
            ${batteryWorthIt ? "+" : ""}${fmt.money(r.battery.npv)} over ${r.batteryLifetimeYears} years
          </p>
          <p class="hint headline-note">
            ${batteryWorthIt
              ? "The battery pays for itself on top of the solar system."
              : "The battery does not pay for itself — it buys independence, not savings."}
          </p>
          <dl class="kv">
            <dt>Self-sufficiency</dt><dd>${fmt.pct(r.pvOnly.selfSufficiencyRate)} &rarr; ${fmt.pct(r.withBattery.selfSufficiencyRate)}</dd>
            <dt>Extra solar you use yourself</dt><dd>${fmt.kwh(r.battery.extraSelfConsumed)}</dd>
            <dt>Battery cost</dt><dd>${fmt.money(r.batteryCapex)}</dd>
            <dt>Saving in year 1</dt><dd>${fmt.money(r.battery.year1Benefit)}</dd>
            <dt>Pays back in</dt><dd>${fmt.years(r.battery.paybackYears)}</dd>
            <dt>Yearly bill</dt><dd>${fmt.money(r.billBattery)}</dd>
          </dl>
        </div>`
      : `<div class="result-block">
          <h3>Battery</h3>
          <p class="hint">You set the battery size to 0, so we only looked at solar on its own.</p>
        </div>`;

    // Each asset is shown against the same solar+battery system, so the figures answer
    // "what does adding this do to me?" rather than "what system should I buy instead?".
    const assetSection = r.assetDeltas.length
      ? `<div class="result-block">
          <h3>What your extras change</h3>
          <p class="hint">
            Each line adds that one item to your household on top of the same
            ${r.kwp.toFixed(1)} kWp system${r.batteryKwh > 0 ? ` and ${r.batteryKwh} kWh battery` : ""}.
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
                    <span class="name">${a.name}</span>
                    <span class="figure">+${fmt.kwh(a.electricityKwh)}/yr</span>
                    <span class="note">
                      ${a.detail}. Of that, ${fmt.kwh(a.extraSelfConsumed)} comes from your own
                      roof and ${fmt.kwh(a.extraImport)} from the grid — ${direction}.
                    </span>
                  </div>`;
              })
              .join("")}
          </div>
        </div>`
      : "";

    $("results-body").innerHTML = `
      ${assetSection}
      <div class="result-block">
        <h3>Solar on its own (${r.kwp.toFixed(1)} kWp)</h3>
        <p class="headline ${pvWorthIt ? "good" : "bad"}">
          ${pvWorthIt ? "+" : ""}${fmt.money(r.pvNpv)} over ${r.lifetimeYears} years
        </p>
        <dl class="kv">
          <dt>Yearly bill now</dt><dd>${fmt.money(r.billNow)}</dd>
          <dt>Yearly bill with solar</dt><dd>${fmt.money(r.billPv)}</dd>
          <dt>Yearly saving</dt><dd>${fmt.money(pvSaving)}</dd>
          <dt>System cost</dt><dd>${fmt.money(r.pvCapex)}</dd>
          <dt>Pays back in</dt><dd>${fmt.years(r.pvPayback)}</dd>
        </dl>
      </div>

      <div class="result-block">
        <h3>Where your solar energy goes</h3>
        <dl class="kv">
          <dt>Produced per year</dt><dd>${fmt.kwh(r.pvOnly.totalProduction)}</dd>
          <dt>You use directly</dt><dd>${fmt.pct(r.pvOnly.selfConsumptionRate)}</dd>
        </dl>
        ${bar(r.pvOnly.selfConsumptionRate)}
        <dl class="kv">
          <dt>Sent to the grid</dt><dd>${fmt.kwh(r.pvOnly.exported)}</dd>
          <dt>Still bought from the grid</dt><dd>${fmt.kwh(r.pvOnly.imported)}</dd>
          <dt>Share of your use covered by solar</dt><dd>${fmt.pct(r.pvOnly.selfSufficiencyRate)}</dd>
        </dl>
        ${bar(r.pvOnly.selfSufficiencyRate)}
      </div>

      ${batterySection}
    `;

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
        indication, not an engineering study or a financial promise.</li>
        <li><strong>Sunlight and temperature</strong> are PVGIS measurements for
        ${r.city.name} (${r.country}) itself. If you live well above or below the town —
        common in valleys and hill country — your own conditions will differ.</li>
        ${assetAssumptions.join("\n")}
        <li><strong>Your electricity use</strong> is spread over the year using a typical
        household pattern scaled to the ${fmt.kwh(r.consumption)} you entered — not your real
        meter data. A household that is out all day will see less benefit than this;
        one at home during the day will see more.${
          r.assetDeltas.length
            ? ` With your extras added, total use comes to ${fmt.kwh(r.totalConsumption)} a year.`
            : ""
        }</li>
        <li><strong>No shading</strong> from trees, chimneys or neighbouring buildings is
        modelled.</li>
        <li><strong>Battery control</strong> is a simple rule: store surplus, use it when short.
        It does not trade on prices or plan ahead, so a smart system could do slightly better.</li>
        <li><strong>Weather variability</strong> between days is smoothed out, which makes the
        battery look slightly better than it would be in a real year.</li>
        <li><strong>Money:</strong> ${r.lifetimeYears}-year life, ${num("discountRate")}% discount
        rate, panels losing 0.5% output per year, maintenance at 1% of system cost per year,
        electricity prices rising ${r.tariffEscalationPct}% per year. All amounts are in the
        currency you selected; no exchange rates are applied.</li>
      </ul>`;
  }

  render();
});
