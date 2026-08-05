# The suites

Eight browser suites covering the calc engine, the wizard, comparison mode, the methodology
page, all five languages, the input bounds and failure handling, the mobile layout and
accessibility.

```
python _tests/run.py                 # all eight
python _tests/run.py engine wizard   # just these
python _tests/run.py --list
```

The runner serves the repo root on a free port, loads each suite in headless Chrome, reads the
verdict out of the dumped DOM, and exits non-zero if anything failed. It needs Python 3 and
Chrome, nothing else — no runner, no bundler, no package manager, which is the same constraint
the deployed site works under. Set `CHROME` if the binary is somewhere unusual.

`.github/workflows/suites.yml` runs exactly this on every push and pull request. That workflow
does not touch deployment: GitHub Pages still serves the repo root as-is.

## Why the directory starts with an underscore

The repo root **is** the published site. A directory named `_tests` is excluded from the Jekyll
build GitHub Pages runs, so the suites are not published alongside the tool. Keep the
underscore.

## How a suite is put together

Each one is a plain HTML page that drives the real pages in an iframe. `harness.js` holds the
shared parts — `ok()`, `waitFor()`, `loadFrame()` — and defines the output contract: one
PASS/FAIL line per assertion, then either `ALL PASS (n)` or `n FAILURES`. `run.py` parses that,
so it is a contract rather than a formatting choice.

Two suites push their heavy computation into a probe file that is fetched and `eval`ed inside
the page under test: `engine-probe.js` and `methodology-probe.js`. That is not indirection for
its own sake. The modules are top-level `const`s in classic scripts, so they are global
bindings but **not** properties of `window` — `frame.contentWindow.PV` is `undefined`, and
`eval` run in that scope is the only way to reach them. Keeping the probe in its own file also
means it is real JavaScript rather than several hundred lines escaped into a template literal.
The probes compute; the suites judge. A failure therefore names a claim, not a variable.

`suite-bounds.html` needs a page whose `cities.json` fetch fails and whose everything else
succeeds. `run.py` generates that from the real `index.html` at run time and deletes it
afterwards (`--keep` to hold on to it). A committed copy would rot the moment `index.html`
changed, which is the failure the fixture exists to catch.

## Traps that have already cost time

- **Wait on the `load` event, never on the URL.** The previous document's href already matches
  the new page's path, so polling it returns the stale document instantly and every assertion
  afterwards reads the old page.
- **An iframe's initial `about:blank` already reports `readyState` "complete"**, so waiting on
  that races the real navigation. Poll for a known element instead.
- **`requestAnimationFrame` never settles under `--virtual-time-budget`** — there is no
  compositor driving it, so a rAF-gated promise hangs the whole suite on "running…". Read a
  layout property to flush a resize, then `setTimeout`.
- **Never assert on a canvas's own width under `--dump-dom`.** Chart.js sizes its canvas from
  the rendering pipeline and `--dump-dom` runs layout without paint, so the number read back is
  whatever it was when the chart was built: a wizard chart that visibly renders at full width
  reports `0`. Layout — `.chart-frame`, `.chart-card`, grid track counts — is safe to measure.
  Where a canvas's size genuinely matters, load the page at that width rather than resizing
  into it, which is also what a phone does.
- **Always give a suite `<meta charset="utf-8">`.** Without it a literal `m²` or an accented
  city name in an assertion silently mis-decodes into a phantom failure.
- **Never round-trip one of these files through PowerShell.** `Get-Content -Raw` reads as the
  system ANSI codepage and `Set-Content -Encoding utf8` adds a BOM, so every `—`, `²`, `°` and
  accented name is mangled. Use Python or an editor. If it happens,
  `text.encode('cp1252').decode('utf-8')` undoes exactly one round.
- Headless Chrome cannot be told to report `prefers-color-scheme: dark`, so dark rendering has
  to be checked by stamping the dark token values onto the page and forcing a redraw.
