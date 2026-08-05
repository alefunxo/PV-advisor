// The bits every suite in this directory needs, so that eight pages do not carry eight
// slightly different copies of "wait for the iframe" and drift apart.
//
// Results go into <pre id="out"> as one PASS/FAIL line each, and the run ends with either
// "ALL PASS (n)" or "n FAILURES". _tests/run.py reads that verdict out of the dumped DOM, so
// the format is a contract rather than a convenience — do not reformat it.

window.Harness = (() => {
  const results = [];

  function ok(name, cond, detail) {
    results.push((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  << " + fmt(detail)));
    return !!cond;
  }

  // An informational line: indented so it cannot be mistaken for an assertion, and ignored by
  // the runner's PASS/FAIL counting. Useful for recording the numbers behind a check.
  function note(text) {
    results.push("       " + text);
  }

  function fmt(detail) {
    if (detail === undefined || detail === null) return "(no detail)";
    if (typeof detail === "string") return detail;
    try {
      return JSON.stringify(detail);
    } catch (e) {
      return String(detail);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Wait on the `load` event, never on the URL: the previous document's href already matches
  // the new page's path, so polling it returns the stale document instantly and every
  // assertion afterwards reads the old page.
  function loadFrame(frame, url) {
    return new Promise((resolve) => {
      frame.addEventListener("load", function once() {
        frame.removeEventListener("load", once);
        resolve(frame.contentDocument);
      });
      frame.src = url;
    });
  }

  // Polls rather than waiting on a frame — an iframe's initial about:blank already reports
  // readyState "complete", so a suite that waits on that races the real navigation.
  //
  // requestAnimationFrame is deliberately not used anywhere here: under
  // --virtual-time-budget there is no compositor driving it, so a rAF-gated promise never
  // settles and hangs the whole suite.
  async function waitFor(fn, label, tries = 300) {
    for (let i = 0; i < tries; i++) {
      try {
        if (fn()) return true;
      } catch (e) {
        /* not ready yet */
      }
      await sleep(50);
    }
    ok("timed out waiting for " + label, false, `gave up after ${tries} polls`);
    return false;
  }

  const norm = (s) => String(s).replace(/\s+/g, " ").trim();

  // The modules are top-level `const`s in classic scripts: global bindings, but not properties
  // of window, so frame.contentWindow.PV is undefined. eval() runs inside that scope.
  const evaller = (frame) => (code) => frame.contentWindow.eval(code);

  function report() {
    const fails = results.filter((r) => r.startsWith("FAIL")).length;
    const asserts = results.filter((r) => /^(PASS|FAIL) /.test(r)).length;
    document.getElementById("out").textContent =
      results.join("\n") + "\n\n" + (fails ? fails + " FAILURES" : "ALL PASS (" + asserts + ")");
  }

  // Wraps the whole suite so a throw becomes a reported failure rather than a page that sits
  // on "running…" and looks to the runner exactly like a hang.
  function run(fn) {
    Promise.resolve()
      .then(fn)
      .catch((e) => ok("suite threw", false, (e && e.stack) || String(e)))
      .then(report);
  }

  return { ok, note, sleep, loadFrame, waitFor, norm, evaller, report, run, results };
})();
