// Time groupings for the results dashboard (milestone 5).
//
// The charts need the 8760-step simulation collapsed into shapes a person can read: months
// across the year, and an average day in the two extreme months. Nothing here models
// anything — it only supplies the per-hour group indices that Dispatch buckets its flows
// with, so the dashboard never re-derives energy flows the simulation already produced.

const Aggregate = (() => {
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  // Month names are the one bit of language this module used to hold. Intl knows them in every
  // locale the tool speaks, so they are derived rather than translated — a catalogue entry for
  // "Feb" would be four more chances to get a month abbreviation wrong.
  function monthLabels(locale = "en-GB") {
    const format = new Intl.DateTimeFormat(locale, { month: "short" });
    // 2021 was not a leap year; any non-leap year gives the twelve months at day 1.
    return Array.from({ length: 12 }, (_, m) => format.format(new Date(Date.UTC(2021, m, 1))));
  }

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
  // The heading is a catalogue key rather than a sentence: this module stays language-free,
  // and the UI layer turns the key into words.
  const DAY_PROFILES = [
    { month: 6, labelKey: "chart.day.summer", days: DAYS_IN_MONTH[6] },
    { month: 0, labelKey: "chart.day.winter", days: DAYS_IN_MONTH[0] },
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
    monthLabels,
    MONTH_OF_HOUR,
    DAY_PROFILES,
    DAY_PROFILE_OF_HOUR,
    dayProfile,
  };
})();
