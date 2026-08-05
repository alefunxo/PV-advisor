#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regenerate the two static data files from PVGIS v5.2.

The deployed app can never call PVGIS itself: the API sends no CORS headers, so a static
GitHub Pages site cannot reach it. Running this script offline and committing the result is
therefore the only path to updating irradiance or temperature data.

Two outputs, and the split between them matters:

  js/data/cities.json          per-city measured values, fetched at that city's own
                               coordinates: annual specific yield, the 12-month shape of that
                               yield, and 12 monthly mean air temperatures.

  js/data/regional-yield.json  tilt/azimuth correction factors only, by reference latitude
                               band. These depend on sun angle, which varies with latitude
                               rather than with local terrain, so interpolating them is safe.

Nothing temperature-sensitive may ever be read from a grid. An earlier version snapped each
city to the nearest point of a 1 degree grid; in the Alps that put Zurich on a cell reading
-7.6 C in January against the city's actual +1.2 C, which inverted the heat pump estimate and
silently zeroed air conditioning for every city near mountains. Every value in cities.json is
measured at the city.

Usage
-----
    python scripts/fetch_pvgis.py cities          # refresh every city (~15 min for 1210)
    python scripts/fetch_pvgis.py cities --only Zurich,Madrid,Oslo --out -
    python scripts/fetch_pvgis.py grids           # refresh the tilt/azimuth tables (~4 min)
    python scripts/fetch_pvgis.py grids --compare # diff against the committed table, write nothing
    python scripts/fetch_pvgis.py both

The cities path is verified: refetching Zurich, Madrid and Oslo reproduces the committed
records exactly -- same annual yield, same monthly shape to 5 dp, same temperatures to 0.1 K.

The grids path does NOT reproduce the committed regional-yield.json, and the difference is
not a bug in this script. The committed table recorded no provenance -- no sample points, no
horizon setting -- so there is nothing to reproduce it from. Bands 40 and 50 come back within
0.4%; band 60 differs by up to 6.8% on steep east-facing cells. `grids --compare` reports
exactly this and writes nothing, so the discrepancy is visible before anyone overwrites the
file. Regenerating shifts every non-south, non-35-degree roof estimate in the tool, so it is
a decision to take deliberately rather than a refresh to run.

The city run is resumable. Every city that comes back is appended to a checkpoint file as it
arrives, and a rerun skips whatever is already in there, so a dropped connection twelve
minutes in costs twelve seconds rather than twelve minutes. Delete the checkpoint to force a
full refetch.

Only the standard library is used, so this runs against a bare Python with no install step.
Python, not PowerShell: PowerShell 5.1 reads as the system ANSI codepage and would
double-encode every accented city name (Zurich, Walbrzych, Bacau) on the way through. Output
is written UTF-8 without a BOM for the same reason.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

API = "https://re.jrc.ec.europa.eu/api/v5_2"

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CITIES_PATH = os.path.join(REPO, "js", "data", "cities.json")
GRIDS_PATH = os.path.join(REPO, "js", "data", "regional-yield.json")
CHECKPOINT = os.path.join(REPO, "scripts", ".pvgis-checkpoint.jsonl")

# The reference system every stored figure is relative to. The methodology page quotes these
# and its smoke suite reads them straight out of the meta blocks, so they are the definition,
# not a comment: change one here and the prose has to change with it.
REF_TILT = 35
REF_ASPECT = 0          # PVGIS convention: 0 = south, -90 = east, 90 = west
REF_LOSS_PCT = 14
REF_PR = 0.86
# Free-standing, which is PVGIS's own default and what the committed data was measured with.
# "building" models a roof-integrated module running hotter and comes back 3.4-4.4% lower --
# enough to look like a plausible refresh while silently rebasing every figure in the tool.
REF_MOUNTING = "free"
TEMP_START_YEAR = 2016
TEMP_END_YEAR = 2020

# Grid dimensions. Tilt 0 is a flat roof, where azimuth cannot matter — it is fetched once and
# copied across the aspects rather than fetched five times.
TILTS = [0, 15, 20, 30, 35, 40, 45, 60, 90]
ASPECTS = [-90, -45, 0, 45, 90]
ASPECT_LABELS = ["East", "South-East", "South", "South-West", "West"]

# Several land points per band, averaged — not one representative point.
#
# A single point was tried first and is wrong in a way that is easy to miss. The factors are
# ratios, so a point's overall sunniness cancels; its *asymmetry* does not. At (60.0, 10.8)
# outside Oslo the terrain to the east depresses every east-facing cell, and a table built
# there hands one Norwegian hillside's horizon to every roof in Scandinavia: east-facing 60
# degree cells came out 6.8% below the committed table while the west-facing ones matched.
# Averaging four points spread across the band's longitudes cancels that. It does not cancel
# latitude, which is the one thing the table is supposed to depend on.
#
# Every point has to be on land — PVGIS answers 400 for a sea coordinate, which is how the
# city list was filtered in the first place. Points inside the tool's geographic scope only:
# a Turkish point at 40N is a fine sun-angle sample and a poor answer to "what is this table
# for". Sea points are skipped at runtime rather than trusted, so a wrong coordinate here
# costs a warning and not a silently lopsided band.
MIN_BAND_POINTS = 3
BAND_POINTS = {
    40: [(40.0, -3.7),    # central Spain
         (39.5, -8.0),    # central Portugal
         (40.4, 16.6),    # Basilicata, Italy
         (40.6, 22.95)],  # Thessaloniki, Greece
    50: [(50.0, 8.7),     # Hesse, Germany
         (50.0, 19.9),    # Lesser Poland
         (50.1, 14.4),    # Prague, Czechia
         (50.0, 4.4)],    # Hainaut, Belgium
    60: [(60.0, 10.8),    # Oslo area, Norway
         (60.0, 17.6),    # Uppland, Sweden
         (60.2, 24.9),    # Helsinki, Finland
         (59.4, 24.7)],   # Tallinn, Estonia
}

# The grids are a sun-angle table, so they are fetched with the local horizon switched off.
# It is a small effect once the points are averaged (under 0.003 on any cell) but it is the
# difference between a table that means "geometry at this latitude" and one that means
# "geometry at this latitude, plus whatever hills these four points happen to have".
# cities.json is the opposite case and keeps PVGIS's default: there the terrain is the point.
GRID_USE_HORIZON = 0

CITIES_META = {
    "license": "Place names CC BY 4.0 - https://creativecommons.org/licenses/by/4.0/",
    "source": (
        "GeoNames cities15000 (CC BY 4.0) for place names; PVGIS v5.2 PVcalc and MRcalc for "
        "yield, monthly shape and temperature, fetched at each city's own coordinates"
    ),
    "referencePerformanceRatio": REF_PR,
    "referenceAzimuth": REF_ASPECT,
    "temperatureYears": "%d-%d mean" % (TEMP_START_YEAR, TEMP_END_YEAR),
    "referenceSystemLossPct": REF_LOSS_PCT,
    "referenceTilt": REF_TILT,
    "referenceMounting": REF_MOUNTING,
    "usage": (
        "specificYield35S is kWh/kWp/year at tilt=35/south incl. 14% system loss. monthlyShape "
        "holds 12 fractions of the annual yield (Jan..Dec). monthlyMeanTempC holds 12 monthly "
        "mean air temperatures. All three are measured at the city's own coordinates, so "
        "altitude is reflected -- do not substitute a coarse grid lookup, which misplaced "
        "alpine cities by 8 K."
    ),
}

GRIDS_META = {
    "source": "PVGIS v5.2 PVcalc API, fetched offline once and committed as a static table",
    "usage": (
        "Multiply a city's specificYield35S by the interpolated factor for the roof's tilt and "
        "azimuth, and by (userPR / referencePerformanceRatio) for a non-default performance "
        "ratio."
    ),
    "referenceAzimuth": REF_ASPECT,
    "aspectConvention": "PVGIS aspect: 0 = south, -90 = east, 90 = west, 180 = north",
    "referencePerformanceRatio": REF_PR,
    "contents": (
        "Tilt/azimuth correction factors by reference latitude band. Per-location yield, "
        "seasonal shape and temperature live in cities.json, measured at each city's own "
        "coordinates."
    ),
    "referenceTilt": REF_TILT,
    "referenceMounting": REF_MOUNTING,
    "historyNote": (
        "A 1-degree grid of 828 measured points was removed: nearest-point lookup placed Zurich "
        "on an alpine cell 8 K colder than the city, which invalidated heat pump and cooling "
        "estimates. Do not reintroduce grid lookup for temperature-sensitive values."
    ),
    "referenceSystemLossPct": REF_LOSS_PCT,
}


# --------------------------------------------------------------------------- HTTP


class SeaPoint(Exception):
    """PVGIS answers HTTP 400 for a coordinate with no radiation data — i.e. open sea.

    This is how land points were filtered in the first place, so it is an expected outcome
    for a city record with bad coordinates, not a failure of the run.
    """


def get_json(endpoint, params, retries=4, pause=0.25):
    """One PVGIS call, with backoff. Raises SeaPoint on 400."""
    url = "%s/%s?%s" % (API, endpoint, urllib.parse.urlencode(params))
    delay = 1.0
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=60) as res:
                body = res.read().decode("utf-8")
            time.sleep(pause)          # ~0.3 s per call; do not hammer a public API
            return json.loads(body)
        except urllib.error.HTTPError as err:
            if err.code == 400:
                raise SeaPoint(url)
            # 429 and the 5xx family are worth waiting out; anything else is not.
            if err.code not in (429, 500, 502, 503, 504) or attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries - 1:
                raise
        time.sleep(delay)
        delay *= 2
    raise RuntimeError("unreachable")


def pvcalc(lat, lon, tilt=REF_TILT, aspect=REF_ASPECT, usehorizon=None):
    """Annual specific yield (kWh/kWp/yr) and the 12 monthly totals, for a 1 kWp system.

    usehorizon=None leaves PVGIS's own default in place, which is what every value in
    cities.json was measured with; the grids pass 0 explicitly (see GRID_USE_HORIZON).
    """
    params = {
        "lat": round(lat, 4),
        "lon": round(lon, 4),
        "peakpower": 1,
        "loss": REF_LOSS_PCT,
        "angle": tilt,
        "aspect": aspect,
        "pvtechchoice": "crystSi",
        "mountingplace": REF_MOUNTING,
        "outputformat": "json",
    }
    if usehorizon is not None:
        params["usehorizon"] = usehorizon
    data = get_json("PVcalc", params)
    outputs = data["outputs"]
    annual = float(outputs["totals"]["fixed"]["E_y"])
    monthly = [0.0] * 12
    for row in outputs["monthly"]["fixed"]:
        monthly[int(row["month"]) - 1] = float(row["E_m"])
    return annual, monthly


def monthly_mean_temps(lat, lon):
    """12 monthly mean air temperatures, averaged over TEMP_START_YEAR..TEMP_END_YEAR."""
    data = get_json(
        "MRcalc",
        {
            "lat": round(lat, 4),
            "lon": round(lon, 4),
            "horirrad": 0,
            "avtemp": 1,
            "startyear": TEMP_START_YEAR,
            "endyear": TEMP_END_YEAR,
            "outputformat": "json",
        },
    )
    buckets = defaultdict(list)
    for row in data["outputs"]["monthly"]:
        # MRcalc returns one row per year+month; the key is "month" as 1..12 and the
        # temperature column is T2m.
        buckets[int(row["month"])].append(float(row["T2m"]))
    if sorted(buckets) != list(range(1, 13)):
        raise ValueError("MRcalc returned %d months, expected 12" % len(buckets))
    return [round(sum(buckets[m]) / len(buckets[m]), 1) for m in range(1, 13)]


# --------------------------------------------------------------------------- files


def read_json(path):
    with io.open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, data):
    """UTF-8, no BOM, LF endings, non-ASCII left as itself.

    ensure_ascii=False keeps city names readable in the committed diff; the BOM and the
    codepage are the two things that have historically mangled this file.
    """
    text = json.dumps(data, ensure_ascii=False, indent=None, separators=(",", ":"))
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
        fh.write("\n")


# --------------------------------------------------------------------------- cities


def load_checkpoint():
    done = {}
    if not os.path.exists(CHECKPOINT):
        return done
    with io.open(CHECKPOINT, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue          # a half-written last line after a hard kill
            done[rec["_key"]] = rec
    return done


def append_checkpoint(rec):
    with io.open(CHECKPOINT, "a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def fetch_city(name, lat, lon):
    """Everything cities.json stores for one city, measured at its own coordinates."""
    annual, monthly = pvcalc(lat, lon)
    total = sum(monthly)
    if total <= 0:
        raise ValueError("PVcalc returned no monthly energy for %s" % name)
    # The shape is stored as fractions rather than absolute kWh so it survives a change of
    # reference system, and so the hourly model can rescale it onto the measured annual total.
    shape = [round(m / total, 5) for m in monthly]
    return {
        "name": name,
        "lat": lat,
        "lon": lon,
        "specificYield35S": round(annual, 1),
        "monthlyShape": shape,
        "monthlyMeanTempC": monthly_mean_temps(lat, lon),
    }


def cmd_cities(args):
    existing = read_json(CITIES_PATH)
    countries = existing["countries"]
    wanted = args.only.split(",") if args.only else None

    targets = []
    for code in sorted(existing["cities"]):
        for city in existing["cities"][code]:
            if wanted and city["name"] not in wanted:
                continue
            targets.append((code, city))

    if not targets:
        print("nothing selected", file=sys.stderr)
        return 1

    done = {} if args.fresh else load_checkpoint()
    if args.fresh and os.path.exists(CHECKPOINT):
        os.remove(CHECKPOINT)
    print("%d cities selected, %d already in the checkpoint" % (len(targets), len(done)))

    started = time.time()
    sea, failed = [], []
    for i, (code, city) in enumerate(targets, 1):
        key = "%s/%s" % (code, city["name"])
        if key in done:
            continue
        try:
            rec = fetch_city(city["name"], city["lat"], city["lon"])
        except SeaPoint:
            # Expected for a coordinate in open water. The city is dropped rather than the
            # run, exactly as when the list was first filtered.
            sea.append(key)
            continue
        except Exception as err:                      # noqa: BLE001 - reported, not swallowed
            failed.append("%s: %s" % (key, err))
            print("  ! %s %s" % (key, err), file=sys.stderr)
            continue
        rec["_key"] = key
        append_checkpoint(rec)
        done[key] = rec
        if i % 25 == 0 or i == len(targets):
            rate = (time.time() - started) / max(1, len(done))
            left = (len(targets) - i) * rate
            print("  %4d/%d  %-28s  ~%d min left" % (i, len(targets), key[:28], left / 60))

    # Rebuild in the original country order, keeping only what came back.
    out_cities = {}
    for code in sorted(existing["cities"]):
        rows = []
        for city in existing["cities"][code]:
            rec = done.get("%s/%s" % (code, city["name"]))
            if not rec:
                continue
            rows.append({k: v for k, v in rec.items() if k != "_key"})
        if rows:
            out_cities[code] = rows

    total = sum(len(v) for v in out_cities.values())
    payload = {"cities": out_cities, "countries": countries, "meta": dict(CITIES_META)}

    if args.out == "-":
        print(json.dumps(payload, ensure_ascii=False, indent=2)[:4000])
    else:
        target = args.out or CITIES_PATH
        # Refuse to shrink the file by accident: a partial run must not quietly delete towns.
        before = sum(len(v) for v in existing["cities"].values())
        if not wanted and total < before * 0.98 and not args.allow_shrink:
            print(
                "refusing to write: %d cities in, %d out. Rerun to fill the gaps, or pass "
                "--allow-shrink if the loss is intended." % (before, total),
                file=sys.stderr,
            )
            return 1
        write_json(target, payload)
        print("wrote %s (%d cities)" % (target, total))

    if sea:
        print("%d sea coordinates skipped: %s" % (len(sea), ", ".join(sea[:8])))
    if failed:
        print("%d failed: %s" % (len(failed), "; ".join(failed[:8])), file=sys.stderr)
        return 1
    return 0


# ---------------------------------------------------------------------------- grids


def band_points(band):
    """The band's land points, with sea coordinates dropped and reported."""
    points = []
    for lat, lon in BAND_POINTS[band]:
        try:
            reference, _ = pvcalc(lat, lon, REF_TILT, REF_ASPECT, GRID_USE_HORIZON)
        except SeaPoint:
            print("  ! (%.2f, %.2f) is sea, skipped" % (lat, lon), file=sys.stderr)
            continue
        points.append((lat, lon, reference))
    if len(points) < MIN_BAND_POINTS:
        raise RuntimeError(
            "band %d has %d usable points, need %d: too few longitudes left to cancel local "
            "terrain, which is the whole reason these are averaged"
            % (band, len(points), MIN_BAND_POINTS)
        )
    return points


def cell(points, tilt, aspect):
    """Mean of the per-point ratios for one tilt/aspect cell.

    The mean of the ratios, not the ratio of the means: a sunnier point would otherwise get a
    heavier vote in what is meant to be a pure sun-angle correction.
    """
    ratios = [
        pvcalc(lat, lon, tilt, aspect, GRID_USE_HORIZON)[0] / reference
        for lat, lon, reference in points
    ]
    return round(sum(ratios) / len(ratios), 4), max(ratios) - min(ratios)


def build_grids():
    bands = {}
    provenance = {}
    for band in sorted(BAND_POINTS):
        print("band %d" % band)
        points = band_points(band)
        provenance[str(band)] = [[lat, lon] for lat, lon, _ in points]
        print("  %d land points: %s" % (len(points), ", ".join("(%.2f, %.2f)" % (a, b) for a, b, _ in points)))
        factors = {}
        worst_spread = 0.0
        for tilt in TILTS:
            row = {}
            if tilt == 0:
                # A flat roof has no azimuth. One value, copied across, rather than five
                # fetches that would differ only by PVGIS rounding noise.
                value, spread = cell(points, 0, 0)
                for aspect in ASPECTS:
                    row[str(aspect)] = value
            else:
                for aspect in ASPECTS:
                    row[str(aspect)], spread = cell(points, tilt, aspect)
                    worst_spread = max(worst_spread, spread)
            factors[str(tilt)] = row
            print("  tilt %2d  %s" % (tilt, row))
        # The reference cell is 1 by construction; make it exactly 1 rather than 0.9999.
        factors[str(REF_TILT)][str(REF_ASPECT)] = 1
        # How far apart the points were on the worst cell. Large here means the band's
        # longitudes disagree more than the averaging can hide, and the table is thinner
        # evidence than it looks.
        print("  widest disagreement between points on any cell: %.4f" % worst_spread)
        bands[str(band)] = {
            "factors": factors,
            "aspectLabels": list(ASPECT_LABELS),
            "aspects": list(ASPECTS),
            "tilts": list(TILTS),
        }

    meta = dict(GRIDS_META)
    # Provenance in the file itself. The committed table recorded none, so when the fetcher
    # was finally run against it there was no way to tell a bug from a different sample point.
    meta["referenceBandPoints"] = provenance
    meta["referenceHorizon"] = (
        "local horizon disabled (usehorizon=0): these are sun-angle factors, so the terrain "
        "around the sample points must not travel with them"
    )
    return {"meta": meta, "tiltAzimuthGridsByLatBand": bands}


def compare_grids(fresh):
    """Diff a fresh run against the committed table, cell by cell. Writes nothing."""
    old = read_json(GRIDS_PATH)
    ob = old["tiltAzimuthGridsByLatBand"]
    nb = fresh["tiltAzimuthGridsByLatBand"]
    worst = (0.0, None)
    for band in sorted(ob, key=int):
        if band not in nb:
            print("band %s is missing from the fresh run" % band, file=sys.stderr)
            continue
        for tilt in ob[band]["factors"]:
            for aspect in ob[band]["factors"][tilt]:
                a = float(ob[band]["factors"][tilt][aspect])
                b = float(nb[band]["factors"][tilt][aspect])
                if abs(a - b) > worst[0]:
                    worst = (abs(a - b), "band %s tilt %s aspect %s: %.4f -> %.4f" % (band, tilt, aspect, a, b))
    print("\nlargest drift against the committed table: %.4f" % worst[0])
    if worst[1]:
        print("  at %s" % worst[1])
    # 0.0001 is the stored precision, so anything above one unit in the last place is a real
    # change to somebody's yield estimate rather than rounding.
    if worst[0] > 1.0001e-4:
        print("this run does NOT reproduce the committed table", file=sys.stderr)
        return 1
    print("reproduces the committed table")
    return 0


def cmd_grids(args):
    fresh = build_grids()
    if args.compare:
        return compare_grids(fresh)
    if args.out == "-":
        print(json.dumps(fresh, ensure_ascii=False, indent=2))
    else:
        write_json(args.out or GRIDS_PATH, fresh)
        print("wrote %s (%d bands)" % (args.out or GRIDS_PATH, len(fresh["tiltAzimuthGridsByLatBand"])))
    return 0


# ----------------------------------------------------------------------------- cli


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_cities = sub.add_parser("cities", help="refresh per-city yield, shape and temperature")
    p_cities.add_argument("--only", help="comma-separated city names, for a spot check")
    p_cities.add_argument("--out", help='output path, or "-" to print instead of writing')
    p_cities.add_argument("--fresh", action="store_true", help="ignore and delete the checkpoint")
    p_cities.add_argument("--allow-shrink", action="store_true", help="permit writing fewer cities than went in")
    p_cities.set_defaults(func=cmd_cities)

    p_grids = sub.add_parser("grids", help="refresh the tilt/azimuth correction tables")
    p_grids.add_argument("--out", help='output path, or "-" to print instead of writing')
    p_grids.add_argument("--compare", action="store_true",
                         help="diff against the committed table and write nothing")
    p_grids.set_defaults(func=cmd_grids)

    p_both = sub.add_parser("both", help="grids, then cities")
    p_both.add_argument("--out", help=argparse.SUPPRESS)
    p_both.add_argument("--only", help=argparse.SUPPRESS)
    p_both.add_argument("--fresh", action="store_true", help=argparse.SUPPRESS)
    p_both.add_argument("--allow-shrink", action="store_true", help=argparse.SUPPRESS)
    p_both.set_defaults(compare=False)
    p_both.set_defaults(func=lambda a: cmd_grids(a) or cmd_cities(a))

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
