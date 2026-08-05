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
//
// Milestone 9: every string here comes from js/i18n/<lang>.json as a whole sentence with
// {named} slots. The language arrives in the same URL that carries the scenario, so a link
// pasted to a neighbour opens in the language it was sent in.

document.addEventListener("DOMContentLoaded", async () => {
  const $ = (id) => document.getElementById(id);
  const num = (id) => Number($(id).value);
  const COLUMNS = ["a", "b"];
  // Translated once per render rather than held in a constant: the label moves with the
  // language, the letter does not.
  const systemName = (col) => I18n.t(`compare.system.${col}`);
  const t = (key, vars) => I18n.t(key, vars);
  // Modules are roughly 200 W/m² and installers rarely fill every square metre — the same
  // pair of assumptions the wizard sizes with, kept here so the two pages agree.
  const KWP_PER_USABLE_M2 = 0.2 * 0.8;

  const state = { a: { model: null, scenario: null }, b: { model: null, scenario: null } };

  // The catalogue comes first: the no-scenario fallback below is a dead end, and it has to be
  // legible in the reader's language when they hit it.
  await I18n.init();

  // ---- the handed-over scenario ---------------------------------------------
  const shared = ShareState.decode();
  if (!shared) {
    // Opened directly. A locked house needs a house to lock.
    $("noStatePanel").hidden = false;
    return;
  }

  // fetch() only rejects on a network failure: a 404 arrives as an HTML body and would fail
  // much later as a syntax error, so the status is checked where it is still legible.
  const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  };

  let cities;
  try {
    [, cities] = await Promise.all([PV.load(), fetchJson("js/data/cities.json")]);
  } catch (err) {
    // There is a house; the data behind it did not arrive. Distinct from the panel above,
    // which is the case of no house at all.
    console.error("Site data failed to load:", err);
    $("dataErrorPanel").hidden = false;
    $("dataErrorRetry").addEventListener("click", () => window.location.reload());
    return;
  }

  const countryList = cities.cities[shared.country] || [];
  const city = countryList.find((c) => c.name === shared.cityName) || countryList[0];
  const countryFallback = (cities.countries.find((c) => c.code === shared.country) || {}).name || "";

  if (!city) {
    $("noStatePanel").hidden = false;
    return;
  }

  // The house: fixed for the life of this page. The country's *name* is not part of it —
  // that follows the language, so it is resolved at render time rather than frozen here.
  const countryName = () => I18n.country(shared.country, countryFallback);

  const house = {
    city,
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

  // The wizard's dropdown wording is longer than a one-line summary wants ("South — best"), so
  // the read-only house summary has its own short forms.
  const ASPECT_KEYS = { "0": "s", "-45": "se", "45": "sw", "-90": "e", "90": "w" };
  const TILT_KEYS = { "0": "tilt.flat", "15": "tilt.shallow", "30": "tilt.typical", "45": "tilt.steep" };

  // ---- column markup --------------------------------------------------------
  // Generated from one template so the two columns cannot drift apart. Ids are suffixed with
  // the column key. Both start from the kit the user already chose. It is rebuilt on a language
  // change, which is why the current input values are read back first.
  function columnMarkup(col) {
    const on = (v) => (ShareState.isOn(v) ? " checked" : "");
    const v = (key, fallback) => (shared[key] !== undefined ? shared[key] : fallback);
    return `
      <section class="compare-col" data-col="${col}">
        <h2>${systemName(col)}</h2>

        <div class="col-inputs">
          <div class="row">
            <div class="field">
              <label for="kwp-${col}">${t("compare.col.kwp")}</label>
              <input type="number" id="kwp-${col}" min="0" max="100" step="0.5" value="${v("kwp", 6)}" />
            </div>
            <div class="field">
              <label for="battery-${col}">${t("compare.col.battery")}</label>
              <input type="number" id="battery-${col}" min="0" max="100" step="0.5" value="${v("batteryKwh", 0)}" />
            </div>
          </div>

          <p class="scenario-bar-label">${t("compare.col.extras")}</p>
          <div class="scenario-toggles">
            <label class="chip"><input type="checkbox" id="hp-${col}"${on(shared.hp)} /> <span>${t("asset.hp.name")}</span></label>
            <label class="chip"><input type="checkbox" id="ev-${col}"${on(shared.ev)} /> <span>${t("asset.ev.name")}</span></label>
            <label class="chip"><input type="checkbox" id="ac-${col}"${on(shared.ac)} /> <span>${t("asset.ac.name")}</span></label>
          </div>

          <details class="advanced" data-asset-details="${col}">
            <summary>${t("compare.col.extrasSettings")}</summary>
            <div class="row">
              <div class="field">
                <label for="hpArea-${col}">${t("hp.area")}</label>
                <input type="number" id="hpArea-${col}" min="10" max="1000" step="5" value="${v("hpArea", 140)}" />
              </div>
              <div class="field">
                <label for="hpStandard-${col}">${t("hp.standard")}</label>
                <select id="hpStandard-${col}"></select>
              </div>
            </div>
            <div class="field">
              <label for="hpSupply-${col}">${t("hp.supply")}</label>
              <select id="hpSupply-${col}">
                <option value="35">${t("hpSupply.35")}</option>
                <option value="45">${t("hpSupply.45")}</option>
                <option value="55">${t("hpSupply.55")}</option>
              </select>
            </div>
            <div class="row">
              <div class="field">
                <label for="evKm-${col}">${t("ev.km")}</label>
                <input type="number" id="evKm-${col}" min="0" max="60000" step="500" value="${v("evKm", 12000)}" />
              </div>
              <div class="field">
                <label for="evEfficiency-${col}">${t("ev.efficiency")}</label>
                <input type="number" id="evEfficiency-${col}" min="5" max="60" step="0.5" value="${v("evEfficiency", 18)}" />
              </div>
            </div>
            <div class="field">
              <label for="evStrategy-${col}">${t("ev.strategy")}</label>
              <select id="evStrategy-${col}">
                <option value="dumb">${t("evStrategy.dumb")}</option>
                <option value="solar">${t("evStrategy.solar")}</option>
              </select>
            </div>
            <div class="row">
              <div class="field">
                <label for="acArea-${col}">${t("ac.area")}</label>
                <input type="number" id="acArea-${col}" min="5" max="1000" step="5" value="${v("acArea", 80)}" />
              </div>
              <div class="field">
                <label for="acSeer-${col}">${t("ac.seer")}</label>
                <input type="number" id="acSeer-${col}" min="1.5" max="10" step="0.1" value="${v("acSeer", 3)}" />
              </div>
            </div>
          </details>
        </div>

        <div class="col-result" id="result-${col}"></div>

        <figure class="chart-card">
          <figcaption>
            <h3>${t("compare.chart.title")}</h3>
            <p class="hint">${t("compare.chart.hint")}</p>
          </figcaption>
          <!-- Hidden from assistive tech rather than announced as an unlabelled graphic:
               every number in it is written out in the energy block just below. -->
          <div class="chart-frame"><canvas id="chartMonthly-${col}" aria-hidden="true"></canvas></div>
        </figure>

        <div class="col-energy" id="energy-${col}"></div>
        <div class="col-summary" id="summary-${col}"></div>
      </section>`;
  }

  // The inputs are the state of this page, so rebuilding the markup on a language change has
  // to carry them across rather than reset the user to what the wizard handed over.
  const COLUMN_INPUTS = ["kwp", "battery", "hpArea", "hpStandard", "hpSupply", "evKm",
    "evEfficiency", "evStrategy", "acArea", "acSeer"];

  function readColumnInputs() {
    if (!$("kwp-a")) return null;
    const snapshot = {};
    COLUMNS.forEach((col) => {
      snapshot[col] = { values: {}, checked: {} };
      COLUMN_INPUTS.forEach((name) => {
        snapshot[col].values[name] = $(`${name}-${col}`).value;
      });
      Scenario.ASSET_KEYS.forEach((k) => {
        snapshot[col].checked[k] = $(`${k}-${col}`).checked;
      });
    });
    return snapshot;
  }

  function buildColumns(snapshot) {
    $("compareGrid").innerHTML = COLUMNS.map(columnMarkup).join("");

    COLUMNS.forEach((col) => {
      $(`hpStandard-${col}`).innerHTML = Object.entries(LoadProfiles.BUILDING_STANDARDS)
        .map(([k, def]) => `<option value="${k}">${t(def.labelKey)}</option>`)
        .join("");
      // Selects cannot be prefilled through the template's value attribute.
      if (shared.hpStandard) $(`hpStandard-${col}`).value = shared.hpStandard;
      if (shared.hpSupply) $(`hpSupply-${col}`).value = shared.hpSupply;
      if (shared.evStrategy) $(`evStrategy-${col}`).value = shared.evStrategy;
    });

    if (!snapshot) return;
    COLUMNS.forEach((col) => {
      COLUMN_INPUTS.forEach((name) => {
        $(`${name}-${col}`).value = snapshot[col].values[name];
      });
      Scenario.ASSET_KEYS.forEach((k) => {
        $(`${k}-${col}`).checked = snapshot[col].checked[k];
      });
    });
  }

  buildColumns(null);

  // ---- reading the form -----------------------------------------------------
  const numOr = (id, fallback) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };

  function paramsFor(col) {
    return {
      site: house.city,
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
  // Grouping and decimal marks follow the language; the currency does not, and no exchange
  // rate is applied anywhere.
  const integer = (v) =>
    new Intl.NumberFormat(I18n.locale, { maximumFractionDigits: 0 }).format(Math.round(v));
  const compact = (v) =>
    new Intl.NumberFormat(I18n.locale, { maximumFractionDigits: 1 }).format(v);
  const decimal = (v, digits) =>
    new Intl.NumberFormat(I18n.locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v);

  let fmt;
  function buildFormatters(currency) {
    const money = new Intl.NumberFormat(I18n.locale, {
      style: "currency", currency, maximumFractionDigits: 0,
    });
    const percent = new Intl.NumberFormat(I18n.locale, {
      style: "percent", maximumFractionDigits: 0,
    });
    fmt = {
      money: (v) => money.format(Math.round(v)),
      signedMoney: (v) => (v > 0 ? `+${money.format(Math.round(v))}` : money.format(Math.round(v))),
      kwh: (v) => t("unit.kwh", { value: integer(v) }),
      signedKwh: (v) => t("unit.kwh", { value: `${v > 0 ? "+" : ""}${integer(v)}` }),
      pct: (v) => percent.format(v),
      // Percentage *points*, not percent: the difference between two rates. The minus sign is
      // the typographic one, to match the "B − A" column header.
      pts: (v) =>
        t("unit.points", {
          value: `${v > 0 ? "+" : v < 0 ? "−" : ""}${integer(Math.abs(v * 100))}`,
        }),
      years: (v) => (isFinite(v) ? t("unit.years", { value: decimal(v, 1) }) : t("unit.never")),
      kwp: (v) => decimal(v, 1),
      num: (v) => compact(v),
    };
  }

  const share = (v, total) =>
    total > 0
      ? `${fmt.kwh(v)} <span class="share">(${fmt.pct(v / total)})</span>`
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
        ${fmt.signedMoney(s.totalNpv)}
      </p>
      <p class="hint headline-note">${t("compare.result.note", { years: m.lifetimeYears })}</p>
      <dl class="kv">
        <dt>${t("compare.result.upfront")}</dt><dd>${fmt.money(s.totalCapex)}</dd>
        <dt class="sub">${t("compare.result.panels")}</dt><dd>${fmt.money(m.pvCapex)}</dd>
        <dt class="sub">${t("compare.result.battery")}</dt><dd>${s.hasBattery ? fmt.money(m.batteryCapex) : dash}</dd>
        <dt>${t("compare.result.billBefore")}</dt><dd>${fmt.money(s.billNow)}</dd>
        <dt>${t("compare.result.billNow")}</dt><dd>${fmt.money(s.hasBattery ? s.billBattery : s.billPv)}</dd>
        <dt>${t("compare.result.saving")}</dt><dd>${fmt.money(s.billNow - (s.hasBattery ? s.billBattery : s.billPv))}</dd>
        <dt>${t("compare.result.pvPayback")}</dt><dd>${fmt.years(s.pvPayback)}</dd>
        <dt>${t("compare.result.batteryPayback")}</dt><dd>${s.hasBattery ? fmt.years(s.battery.paybackYears) : dash}</dd>
        <dt>${t("compare.result.pvValue")}</dt><dd>${fmt.money(s.pvNpv)}</dd>
        <dt>${t("compare.result.batteryValue")}</dt><dd>${s.hasBattery ? fmt.money(s.battery.npv) : dash}</dd>
      </dl>`;

    const monthly = s.chosen.buckets;
    Charts.monthly(`chartMonthly-${col}`, {
      labels: Aggregate.monthLabels(I18n.locale),
      direct: monthly.map((b) => b.directSelfConsumed),
      battery: monthly.map((b) => b.batteryDischargeToLoad),
      grid: monthly.map((b) => b.imported),
      hasBattery: s.hasBattery,
      kwhFmt: fmt.kwh,
      yMax,
    });

    const throughput = Scenario.batteryThroughput(s.chosen);
    $(`energy-${col}`).innerHTML = `
      <h3>${t("compare.energy.h3")}</h3>
      <dl class="kv">
        <dt>${t("compare.energy.used")}</dt><dd>${fmt.kwh(s.totalConsumption)}</dd>
        <dt>${t("compare.energy.produced")}</dt><dd>${fmt.kwh(produced)}</dd>
        <dt>${t("compare.energy.direct")}</dt><dd>${share(s.chosen.directSelfConsumed, produced)}</dd>
        <dt>${t("compare.energy.stored")}</dt><dd>${s.hasBattery ? share(throughput, produced) : dash}</dd>
        <dt class="sub">${t("compare.energy.storedOut")}</dt>
        <dd>${s.hasBattery ? fmt.kwh(s.chosen.batteryDischargeToLoad) : dash}</dd>
        <dt class="sub">${t("compare.energy.storedLost")}</dt>
        <dd>${s.hasBattery ? share(s.chosen.chargeLosses + s.chosen.dischargeLosses, produced) : dash}</dd>
        <dt>${t("compare.energy.exported")}</dt><dd>${share(s.chosen.exported, produced)}</dd>
        <dt>${t("compare.energy.imported")}</dt><dd>${fmt.kwh(s.chosen.imported)}</dd>
        <dt>${t("compare.energy.selfSufficiency")}</dt><dd>${fmt.pct(s.chosen.selfSufficiencyRate)}</dd>
        <dt>${t("compare.energy.selfConsumption")}</dt><dd>${fmt.pct(s.chosen.selfConsumptionRate)}</dd>
        <dt>${t("compare.energy.cycles")}</dt>
        <dd>${s.hasBattery ? integer(s.chosen.equivalentFullCycles) : dash}</dd>
      </dl>`;

    // The "initial situation" summary: what this column actually is, in words, so a reader
    // scrolled down to the charts does not have to scroll back up to remember.
    const extras = Scenario.ASSET_KEYS.filter((k) => s.enabled[k]).map((k) => t(`asset.${k}.name`));
    $(`summary-${col}`).innerHTML = `
      <h3>${t("compare.summary.h3", { system: systemName(col) })}</h3>
      <ul class="summary-list">
        <li>${t("compare.summary.panels", {
          kwp: fmt.kwp(m.kwp),
          area: integer(m.kwp / KWP_PER_USABLE_M2),
        })}</li>
        <li>${m.batteryKwh > 0
          ? t("compare.summary.battery", { kwh: fmt.num(m.batteryKwh) })
          : t("compare.summary.noBattery")}</li>
        <li>${extras.length
          ? t("compare.summary.extras", { extras: I18n.list(extras) })
          : t("compare.summary.noExtras")}</li>
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

    const names = [...missing].map((k) => t(`uncosted.${k}`));
    $("costNotice").hidden = false;
    $("costNotice").innerHTML = t("compare.notice.uncosted", { items: I18n.list(names) });
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
      ["value", fmt.money(a.totalNpv), fmt.money(b.totalNpv),
       fmt.signedMoney(b.totalNpv - a.totalNpv)],
      ["upfront", fmt.money(a.totalCapex), fmt.money(b.totalCapex),
       fmt.signedMoney(b.totalCapex - a.totalCapex)],
      ["bill", fmt.money(billOf(a)), fmt.money(billOf(b)),
       fmt.signedMoney(billOf(b) - billOf(a))],
      ["saving",
       fmt.money(a.billNow - billOf(a)), fmt.money(b.billNow - billOf(b)),
       fmt.signedMoney((b.billNow - billOf(b)) - (a.billNow - billOf(a)))],
      ["produced", fmt.kwh(a.chosen.totalProduction), fmt.kwh(b.chosen.totalProduction),
       fmt.signedKwh(b.chosen.totalProduction - a.chosen.totalProduction)],
      ["selfSufficiency", fmt.pct(a.chosen.selfSufficiencyRate), fmt.pct(b.chosen.selfSufficiencyRate),
       fmt.pts(b.chosen.selfSufficiencyRate - a.chosen.selfSufficiencyRate)],
      ["selfConsumption",
       fmt.pct(a.chosen.selfConsumptionRate), fmt.pct(b.chosen.selfConsumptionRate),
       fmt.pts(b.chosen.selfConsumptionRate - a.chosen.selfConsumptionRate)],
      ["imported", fmt.kwh(a.chosen.imported), fmt.kwh(b.chosen.imported),
       fmt.signedKwh(b.chosen.imported - a.chosen.imported)],
      ["consumption", fmt.kwh(a.totalConsumption), fmt.kwh(b.totalConsumption),
       fmt.signedKwh(b.totalConsumption - a.totalConsumption)],
    ];

    // Three whole verdicts rather than a stem with an optional clause bolted on: the "close
    // enough" case is its own sentence in every language.
    const verdict = identical
      ? t("compare.delta.identical")
      : t(gap < 500 ? "compare.delta.betterClose" : "compare.delta.better", {
          system: systemName(better),
          gap: fmt.money(gap),
        });

    $("deltaBody").innerHTML = `
      <p class="verdict-line">${verdict}</p>
      <div class="delta-table" role="table">
        <div class="delta-row head" role="row">
          <span role="columnheader"></span>
          <span role="columnheader">${systemName("a")}</span>
          <span role="columnheader">${systemName("b")}</span>
          <span role="columnheader">${t("compare.delta.diff")}</span>
        </div>
        ${rows
          .map(
            ([key, av, bv, dv]) => `
          <div class="delta-row" role="row">
            <span role="cell">${t(`compare.delta.row.${key}`)}</span>
            <span role="cell">${av}</span>
            <span role="cell">${bv}</span>
            <span role="cell" class="delta-cell">${dv}</span>
          </div>`
          )
          .join("")}
      </div>
      <p class="hint">${t("compare.delta.footnote")}</p>`;

    $("verdictBlock").hidden = false;
  }

  function renderHouse() {
    const aspectKey = ASPECT_KEYS[String(house.orientation)];
    const aspect = aspectKey ? t(`roof.aspect.${aspectKey}`) : `${house.orientation}°`;
    const tiltKey = TILT_KEYS[String(house.tilt)];
    const tilt = tiltKey ? t(tiltKey) : `${house.tilt}°`;
    $("houseSummary").innerHTML = `
      <dt>${t("compare.house.town")}</dt><dd>${house.city.name}, ${countryName()}</dd>
      <dt>${t("compare.house.roof")}</dt><dd>${t("compare.house.roofValue", { aspect, tilt })}</dd>
      <dt>${t("compare.house.consumption")}</dt>
      <dd>${t("compare.house.consumptionValue", { kwh: fmt.kwh(house.consumption) })}</dd>`;
  }

  function renderAssumptions() {
    const m = state.a.model;
    $("assumptions-body").innerHTML = `
      <ul>
        <li>${t("compare.assump.screening")}</li>
        <li>${t("compare.assump.uncosted")}</li>
        <li>${t("compare.assump.data", { city: m.site.name, country: countryName() })}</li>
        <li>${t("compare.assump.kitOnly")}</li>
        <li>${t("compare.assump.extras")}</li>
        <li>${t("compare.assump.dispatch")}</li>
        <li>${t("compare.assump.weather")}</li>
        <li>${t("compare.assump.money", { years: m.lifetimeYears, rate: m.discountRatePct })}</li>
      </ul>
      <p class="hint">${t("assump.methodLink")}</p>`;
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
        err.textContent = t("error.checkFields", { fields: I18n.list(problems.slice(0, 4)) });
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

  // The column labels and input captions are generated markup, not translated DOM, so they are
  // rebuilt here. The model is language-independent and survives.
  I18n.onChange(() => {
    buildColumns(readColumnInputs());
    refresh();
  });

  refresh();
});
