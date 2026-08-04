// Carrying a scenario from the wizard to comparison mode, through the URL.
//
// Comparison mode is only reachable from the last step of the wizard, and it inherits
// everything the user already answered — the house it will not let them change, and the costs
// and kit it uses as starting values. A static site has nowhere else to put that: no backend,
// no database, and sessionStorage would break the moment someone shared or bookmarked the
// link. So the state rides in the query string, which is the URL-encoded state the build plan
// left room for.
//
// Keys are short but readable rather than a packed blob: a comparison URL is something a
// person may well paste to a neighbour or an installer, and it should survive being looked at.
// The city travels as its *name*, not its index in the dropdown, so a future refresh of
// cities.json cannot silently move somebody's town.

const ShareState = (() => {
  // Long name -> query-string key. Anything not listed here does not travel.
  const KEYS = {
    country: "c",
    cityName: "town",
    orientation: "az",
    tilt: "tilt",
    consumption: "use",
    currency: "cur",
    retailPrice: "rp",
    feedInTariff: "fit",
    capexPerKwp: "cpk",
    batteryCapexPerKwh: "bpk",
    discountRate: "dr",
    lifetime: "life",
    batteryLifetime: "blife",
    roundTrip: "rt",
    performanceRatio: "pr",
    tariffEscalation: "esc",
    kwp: "kwp",
    batteryKwh: "bat",
    hp: "hp",
    ev: "ev",
    ac: "ac",
    hpArea: "hpa",
    hpStandard: "hps",
    hpSupply: "hpt",
    evKm: "evkm",
    evEfficiency: "eveff",
    evStrategy: "evs",
    acArea: "aca",
    acSeer: "seer",
  };

  function encode(state) {
    const params = new URLSearchParams();
    Object.entries(KEYS).forEach(([name, key]) => {
      const value = state[name];
      if (value === undefined || value === null || value === "") return;
      // Booleans travel as 1/0 rather than "true"/"false" — shorter, and unambiguous on the
      // way back in.
      params.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    });
    return params.toString();
  }

  // Returns null when there is no state to read, which is how comparison mode knows it was
  // opened directly rather than handed a scenario.
  function decode(search = window.location.search) {
    const params = new URLSearchParams(search);
    if (![...params.keys()].length) return null;

    const out = {};
    Object.entries(KEYS).forEach(([name, key]) => {
      if (params.has(key)) out[name] = params.get(key);
    });
    return Object.keys(out).length ? out : null;
  }

  const isOn = (v) => v === "1" || v === true;

  return { encode, decode, isOn };
})();
