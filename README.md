# PV-advisor

A static, backend-free web app that lets homeowners screen whether solar PV (with/without
battery) pays off, and how adding a heat pump, EV, or AC changes that — built with Europe-wide
precomputed irradiance data.

It is a **screening tool**, not an optimiser: everything is closed-form or simple rule-based
logic, and the results page says so.

Source: <https://github.com/alefunxo/PV-advisor>. Vibe-coded by Alejandro Pena-Bello.

## The advanced version

Where this tool stops — greedy dispatch, no foresight, no search for the best system size —
a solver-based tool takes over: <https://gitlab.hevs.ch/ted/screen_project>. It will be open
sourced shortly.

## Running it

There is no build step. Serve the directory and open it:

```
python -m http.server 8123
```

Then browse to <http://localhost:8123>. Opening `index.html` directly from the filesystem will
not work — the data files are loaded with `fetch`, which needs an HTTP origin.

## Coverage

EU-27 plus the UK, Switzerland and Norway: 1 210 towns and cities, each with its own measured
solar yield, seasonal distribution and monthly temperatures.

## Layout

```
index.html              wizard markup
compare.html            two-system comparison, reached from the end of the wizard
methodology.html        the whole method written out, linked from every page header
css/style.css
js/main.js              wizard state, navigation, results rendering
js/compare.js           two-column comparison shell
js/state.js             scenario hand-off between the pages, via the URL
js/i18n.js              catalogue loading, t(key, vars), language selector
js/i18n/<lang>.json           one flat catalogue per language (en, de, fr, es, it)
js/i18n/methodology.<lang>.json   the methodology prose, loaded only by that page
js/calc/scenario.js     one scenario end to end: profiles -> dispatch -> economics
js/calc/pv.js           yield + hourly production profile
js/calc/climate.js      hourly temperature reconstruction
js/calc/dispatch.js     battery charge/discharge heuristic
js/calc/economics.js    NPV, payback, incremental battery case
js/data/cities.json           per-city yield, seasonal shape, temperatures (offline-generated)
js/data/regional-yield.json   tilt/azimuth correction factors by latitude band
js/data/load-profiles.js      synthetic household + heat pump / EV / AC load profiles
```

## Status

| Milestone | State |
|---|---|
| 1. Yield lookup + PV-only economics | done |
| 2. Battery dispatch + incremental economics | done |
| 3. Load profile + wizard UI | done |
| 4. Heat pump / EV / AC toggles | done |
| 5. Results dashboard + charts | done |
| 6. Two-scenario comparison mode | done |
| 7. Polish, validation, mobile | partial |
| 8. Methodology page | done |
| 9. Multilingual (DE / FR / ES / IT) | done |

The interface language follows `?lang=`, then a remembered choice, then the browser's own
preference, then English. Currency is chosen separately and is never tied to the language.

## Data sources

- Solar yield and temperature: [PVGIS](https://re.jrc.ec.europa.eu/pvg_tools/en/) v5.2
  (European Commission JRC), fetched once offline per city and committed as static data.
  PVGIS sends no CORS headers, so the deployed site cannot call it at runtime.
- Place names: [GeoNames](https://www.geonames.org/) `cities15000`, CC BY 4.0.
