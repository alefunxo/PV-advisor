// Multilingual support (milestone 9): English, German, French, Spanish and Italian — the
// languages that cover most of the tool's geographic scope.
//
// In keeping with the rest of the site there is no framework and no build step: one flat
// JSON catalogue per language under js/i18n/, a t(key, vars) lookup, and English as the
// fallback for any key a translation has not reached yet.
//
// The active language rides in the URL (?lang=de), which is the same URL-encoded state the
// wizard already uses to hand a scenario to comparison mode. That is what makes a shared link
// arrive in the language it was sent in. localStorage only supplies the default for a fresh
// visit with no ?lang= on it, and the browser's own languages supply the default for a first
// visit with nothing stored. Internal links are rewritten as the page is translated, so moving
// between the wizard, comparison mode and the methodology page keeps the language without
// every href having to know about it.
//
// Catalogues are flat, dotted-key objects rather than nested ones. A translator diffing two
// files wants one line per string, and a missing key should be visible as a missing line.
//
// Long-form pages load an extra bundle: methodology.html asks for "methodology", which fetches
// js/i18n/methodology.<lang>.json on top of the base catalogue. Keeping that prose out of the
// catalogue every page loads means the wizard does not pay for text it never shows.

const I18n = (() => {
  const DEFAULT = "en";

  // Endonyms: a language picker that names languages in the reader's own language is a picker
  // only people who already read the current one can use.
  const SUPPORTED = [
    { code: "en", name: "English", locale: "en-GB" },
    { code: "de", name: "Deutsch", locale: "de-DE" },
    { code: "fr", name: "Français", locale: "fr-FR" },
    { code: "es", name: "Español", locale: "es-ES" },
    { code: "it", name: "Italiano", locale: "it-IT" },
  ];
  const CODES = SUPPORTED.map((l) => l.code);
  const LOCALES = Object.fromEntries(SUPPORTED.map((l) => [l.code, l.locale]));

  const STORAGE_KEY = "advisor.lang";
  const URL_KEY = "lang";

  let lang = DEFAULT;
  let extraBundles = [];
  const catalogues = {}; // code -> flat { key: string }
  const listeners = [];

  // ---- loading ---------------------------------------------------------------
  const bundleUrl = (name, code) =>
    name ? `js/i18n/${name}.${code}.json` : `js/i18n/${code}.json`;

  async function fetchBundle(name, code) {
    const res = await fetch(bundleUrl(name, code));
    if (!res.ok) throw new Error(`i18n: ${bundleUrl(name, code)} → ${res.status}`);
    return res.json();
  }

  // Every bundle a language needs, merged into one flat map. Loaded once per language.
  const loaded = new Set();
  async function ensure(code) {
    const want = ["", ...extraBundles].filter((n) => !loaded.has(`${code}:${n}`));
    if (!want.length) return;
    const parts = await Promise.all(want.map((n) => fetchBundle(n, code)));
    catalogues[code] = catalogues[code] || {};
    parts.forEach((part, i) => {
      Object.assign(catalogues[code], part);
      loaded.add(`${code}:${want[i]}`);
    });
  }

  // ---- lookup ----------------------------------------------------------------
  const has = (code, key) =>
    catalogues[code] && Object.prototype.hasOwnProperty.call(catalogues[code], key);

  function interpolate(str, vars) {
    return str.replace(/\{(\w+)\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
    );
  }

  // A missing key falls back to English, then to the key itself — a visible "results.verdict.pv"
  // in the page is a bug report, which is better than an empty element that looks deliberate.
  const resolve = (key) =>
    has(lang, key) ? catalogues[lang][key] : has(DEFAULT, key) ? catalogues[DEFAULT][key] : undefined;

  function t(key, vars) {
    const str = resolve(key);
    if (str === undefined) return key;
    return vars ? interpolate(str, vars) : str;
  }

  // ---- applying to the DOM ---------------------------------------------------
  // data-i18n           → textContent
  // data-i18n-html      → innerHTML, for strings that carry their own <strong> or <a>
  // data-i18n-attr      → "attr:key; attr:key", for placeholders, titles and aria-labels
  //
  // A key with no entry anywhere leaves the element alone rather than writing the key into it:
  // the inline English is already there and is the better fallback. Generated prose still gets
  // the visible key from t(), where there is no markup standing behind it.
  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      const str = resolve(el.dataset.i18n);
      if (str !== undefined) el.textContent = str;
    });
    root.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const str = resolve(el.dataset.i18nHtml);
      if (str !== undefined) el.innerHTML = str;
    });
    root.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      el.dataset.i18nAttr.split(";").forEach((pair) => {
        const cut = pair.indexOf(":");
        if (cut < 0) return;
        const attr = pair.slice(0, cut).trim();
        const key = pair.slice(cut + 1).trim();
        const str = key ? resolve(key) : undefined;
        if (attr && str !== undefined) el.setAttribute(attr, str);
      });
    });
    decorateLinks(root);
    document.documentElement.lang = lang;
  }

  // Carry the language across every internal hop. Doing it here rather than in each href keeps
  // the markup honest — the pages link to "compare.html", not to a language-tagged variant.
  function decorateLinks(root) {
    root.querySelectorAll("a[href]").forEach((a) => {
      const raw = a.getAttribute("href");
      if (!raw || raw.startsWith("#")) return;
      let url;
      try {
        url = new URL(raw, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (!url.pathname.endsWith(".html")) return;
      if (lang === DEFAULT) url.searchParams.delete(URL_KEY);
      else url.searchParams.set(URL_KEY, lang);
      a.setAttribute("href", `${url.pathname}${url.search}${url.hash}`);
    });
  }

  // ---- choosing the language -------------------------------------------------
  function detect() {
    const fromUrl = new URLSearchParams(window.location.search).get(URL_KEY);
    if (CODES.includes(fromUrl)) return fromUrl;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (CODES.includes(stored)) return stored;
    } catch {
      // Private browsing, or storage disabled. The browser's own preference still works.
    }
    const preferences = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || ""];
    for (const pref of preferences) {
      const base = String(pref).slice(0, 2).toLowerCase();
      if (CODES.includes(base)) return base;
    }
    return DEFAULT;
  }

  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Nothing to do; the URL still carries it for this page and every link off it.
    }
    const url = new URL(window.location.href);
    // English is the fallback, so it needs no marker — a plain URL stays plain.
    if (lang === DEFAULT) url.searchParams.delete(URL_KEY);
    else url.searchParams.set(URL_KEY, lang);
    if (url.toString() !== window.location.href) {
      window.history.replaceState(null, "", url.toString());
    }
  }

  async function setLang(code) {
    if (!CODES.includes(code) || code === lang) return;
    await ensure(code);
    lang = code;
    persist();
    apply();
    listeners.forEach((fn) => fn(lang));
  }

  function mountSelector() {
    const select = document.getElementById("langSelect");
    if (!select) return;
    select.innerHTML = SUPPORTED.map(
      (l) => `<option value="${l.code}"${l.code === lang ? " selected" : ""}>${l.name}</option>`
    ).join("");
    select.addEventListener("change", () => setLang(select.value));
  }

  // ---- formatting ------------------------------------------------------------
  // Intl carries the locale, so grouping and decimal marks follow the language. Currency does
  // not: a French speaker in Switzerland still wants CHF, so it stays user-selected and no
  // exchange rate is ever applied.
  const locale = () => LOCALES[lang] || LOCALES[DEFAULT];

  // Country names arrive from cities.json in English, keyed by ISO code. Intl already knows
  // them in every language the tool speaks, so they are looked up rather than translated —
  // thirty names that would otherwise have to be kept in step across five files. City names
  // are the opposite case and stay exactly as GeoNames wrote them: a town is called what it
  // is called, and translating Zürich would make it harder to find, not easier.
  let regionNames = null;
  let regionNamesFor = null;
  function country(code, fallback) {
    if (typeof Intl.DisplayNames !== "function") return fallback || code;
    if (regionNamesFor !== lang) {
      try {
        regionNames = new Intl.DisplayNames([locale()], { type: "region" });
        regionNamesFor = lang;
      } catch {
        return fallback || code;
      }
    }
    // DisplayNames echoes the code back for anything it does not recognise.
    const name = regionNames.of(code);
    return !name || name === code ? fallback || code : name;
  }

  const collator = () => new Intl.Collator(locale());

  // "a heat pump, an electric car and air conditioning" — the conjunction and the commas are
  // language-specific, so they come from Intl rather than from a hand-rolled join.
  function list(items, type = "conjunction") {
    const clean = items.filter(Boolean);
    if (clean.length <= 1) return clean[0] || "";
    if (typeof Intl.ListFormat === "function") {
      return new Intl.ListFormat(locale(), { style: "long", type }).format(clean);
    }
    return clean.join(", ");
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  async function init(options = {}) {
    extraBundles = options.bundles || [];
    lang = detect();
    // Even English is non-fatal: the same text is inline in every page as the static fallback,
    // so a catalogue that does not arrive costs nothing visible. Letting it reject here would
    // take down a wizard whose site data loaded perfectly well.
    try {
      await ensure(DEFAULT);
    } catch {
      // Inline English stands in. Nothing further to load.
    }
    if (lang !== DEFAULT) {
      try {
        await ensure(lang);
      } catch {
        // A missing or broken catalogue must not take the page down with it.
        lang = DEFAULT;
      }
    }
    persist();
    mountSelector();
    apply();
  }

  return {
    init,
    t,
    apply,
    list,
    country,
    collator,
    setLang,
    onChange,
    SUPPORTED,
    CODES,
    get lang() {
      return lang;
    },
    get locale() {
      return locale();
    },
  };
})();
