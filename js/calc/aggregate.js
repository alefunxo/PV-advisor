// Time groupings for the results dashboard (milestone 5).
//
// The charts need the 8760-step simulation collapsed into shapes a person can read: months
// across the year, and an average day in the two extreme months. Nothing here models
// anything — it only supplies the per-hour group indices that Dispatch buckets its flows
// with, so the dashboard never re-derives energy flows the simulation already produced.

const Aggregate = (() => {
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  const MONTH_LABELS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  // Month index (0-11) for each of the 8760 hours. Precomputed once: rebuilding it on every
  // toggle re-render would be the most expensive thing on the results page.
  const MONTH_OF_HOUR = (() => {
    const out = new Array(8760);
    let h = 0;
    for (let m = 0; m < 12; m++) {
      for (let d = 0; d < DAYS_IN_MONTH[m]; d++) {
        for (let k = 0; k < 24; k++) out[h++] = m;
      }
    }
    return out;
  })();

  // The two day-profile charts. July and January are the extremes of both the solar and the
  // heating year everywhere in the covered latitude range, so they bracket the answer.
  const DAY_PROFILES = [
    { month: 6, label: "A typical July day", days: DAYS_IN_MONTH[6] },
    { month: 0, label: "A typical January day", days: DAYS_IN_MONTH[0] },
  ];

  // Group index laying both day profiles out end to end: profile 0 occupies buckets 0-23,
  // profile 1 occupies 24-47, and every hour outside those months lands in a discard bucket.
  // This lets one Dispatch pass produce the day profiles with the battery state carried
  // through the whole year, rather than simulating an isolated 24-hour slice with an empty
  // battery — which would understate what the battery does on a real July morning.
  const DISCARD_BUCKET = DAY_PROFILES.length * 24;

  const DAY_PROFILE_OF_HOUR = (() => {
    const out = new Array(8760).fill(DISCARD_BUCKET);
    for (let h = 0; h < 8760; h++) {
      const slot = DAY_PROFILES.findIndex((p) => p.month === MONTH_OF_HOUR[h]);
      if (slot >= 0) out[h] = slot * 24 + (h % 24);
    }
    return out;
  })();

  // Pulls one profile's 24 hourly means out of a bucketed Dispatch result.
  function dayProfile(buckets, slot, field) {
    const { days } = DAY_PROFILES[slot];
    const out = new Array(24);
    for (let k = 0; k < 24; k++) out[k] = buckets[slot * 24 + k][field] / days;
    return out;
  }

  return {
    MONTH_LABELS,
    MONTH_OF_HOUR,
    DAY_PROFILES,
    DAY_PROFILE_OF_HOUR,
    dayProfile,
  };
})();
