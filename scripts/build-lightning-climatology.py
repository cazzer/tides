"""Build the lightning climatology (tides-ufyr.14.1; format: src/lightning-climatology.ts).

src/assets/earth-lightning.bin: 209,952 bytes, no header, 15 planes back to
back, each bottom (southernmost) row first, columns from 180 W eastward:
  planes 1-12: each calendar month's mean flash density at 144 x 72 (2.5 deg),
    byte = round(255 ln(1 + F / 0.001) / ln(1 + 2 / 0.001)), F in
    flashes / km^2 / day, clamped to 2;
  plane 13: land fraction, 144 x 72, byte = round(255 land);
  plane 14: LIS's coverage, 144 x 72: the share of the cell's area inside
    LIS's 38 S-38 N (255 inside, 0 beyond, the 37.5-40 rows between);
  plane 15: the static clouds' cover, 360 x 180 (1 deg), byte = round(255 alpha).
Beyond LIS's coverage the app guesses the density from the season, the
hemisphere and land or sea, and places storms by cloud cover and forecast
showers (the user's decision in tides-ufyr.14.2); this asset holds no guess.

Source: NASA GHRC's LIS 0.1 Degree Very High Resolution Gridded Lightning
Monthly Climatology (VHRMC) V1, read through its no-login NASA GIBS layer
LIS_Very_High_Resolution_Lightning_Monthly_Climatology_LIS_Mean_Flash_Rate
(EPSG:4326, PNG, Time 1998-01-01/2013-12-01/P1M), with its colormap
https://gibs.earthdata.nasa.gov/colormaps/v1.3/LIS_Very_High_Resolution_Lightning_Monthly_Climatology_LIS_Mean_Flash_Rate.xml
(101 classes, Flashes/km^2/day: [0.001, 0.005), then 0.005 wide to 0.5, then
>= 0.5; black is "No Data" and also [0, 0.001)). Accessed 2026-11-13. Citation
(CMR collection C1979883359-GHRC_DAAC, which the GIBS layer metadata names):
  Albrecht, R. I., Goodman, S., Buechler, D., Blakeslee, R. J. & Christian, H.
  (2016). LIS 0.1 Degree Very High Resolution Gridded Lightning Monthly
  Climatology (VHRMC). NASA Global Hydrometeorology Resource Center DAAC,
  Huntsville, Alabama, U.S.A. doi:10.5067/LIS/LIS/DATA302
  (subset used: the 12 monthly mean flash rates, as GIBS renders them).
Nothing at runtime fetches any of it.

What GIBS serves, and so what this does:
- The layer is a true monthly climatology: its 192 times repeat the same 12
  images every year (checked: each month of 1998, 2005 and 2013 is the same
  image), so one year's 12 are read.
- WMS GetMap at GIBS's finest 2km-set level (0.5625 / 32 deg a pixel), in four
  90 x 90 deg requests a month over 45 S-45 N aligned to its tiles, returns
  the stored pixels unresampled (checked against a WMTS tile: identical).
- The stored pixels use 101 colours plus black, one per class, but not the
  colormap's: each is the colormap's colour two classes lower, hue-turned a
  degree or two, and the two lowest classes have colours the colormap lacks.
  Matched to the colormap by nearest colour, a pixel would read two classes
  (0.01 fl/km^2/day) low. So the classes are recovered from the data: the
  colours that match a hue-turned colormap entry (within L1 3, one to one)
  take that entry's class plus the count of those that don't; those that
  don't take the lowest classes, in the order they neighbour black and each
  other on the map. Checked: the result is one colour per class, neighbouring
  pixels differ by a class or two, black's main neighbour is the lowest
  class, and LIS's band totals about 41 fl/s, which leaves the global
  46 fl/s of the LIS/OTD climatology (Cecil, Buechler & Blakeslee 2014) a
  few fl/s poleward of 38 deg; read the colormap's way the band would total
  about 32.
- A class reads as its interval's middle; in-band black as 0.0005; the open
  top class (>= 0.5) as 0.5 plus the e-folding width of an exponential fitted
  to the area in the classes from 0.25 to 0.5 (its mean, were the tail to
  carry on that way).
- Each 2.5 deg cell is the area-weighted mean over the pixels whose centres
  are in it and inside 38 S-38 N; its coverage is that area over the cell's.

Land: 1 - the green of src/assets/earth-specular-2k.jpg (water bright), the
mask the app's cloud pipeline uses; the static cover: the green of
src/assets/earth-clouds-2k.jpg, the channel getStaticAlpha
(src/renderers/cloudPipeline.ts) takes as the clouds' alpha. Both
area-weighted over the texels whose centres fall in each cell.

Downloads (~85 requests, one at a time, User-Agent "tides-build") are cached
in <cache_dir>; reruns read the cache. They are parsed only as PNG, XML and
JSON.

usage: uv run --no-project --with numpy --with pillow python -I scripts/build-lightning-climatology.py <cache_dir>
"""
import colorsys
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path.cwd()
ASSETS = ROOT / "src" / "assets"
OUT = ASSETS / "earth-lightning.bin"
DECODER = ROOT / "src" / "lightning-climatology.ts"

LAYER = "LIS_Very_High_Resolution_Lightning_Monthly_Climatology_LIS_Mean_Flash_Rate"
WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
WMTS_CAPS = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0"
COLORMAP = f"https://gibs.earthdata.nasa.gov/colormaps/v1.3/{LAYER}.xml"
LAYER_METADATA = f"https://gibs.earthdata.nasa.gov/layer-metadata/v1.0/{LAYER}.json"
USER_AGENT = "tides-build"
TIME_RANGE = "1998-01-01/2013-12-01/P1M"
YEAR = 1998
CHECK_YEARS = (2005, 2013)

# The layout (src/lightning-climatology.ts; checked against it below).
CLIM_W, CLIM_H = 144, 72
COVER_W, COVER_H = 360, 180
MONTHS = 12
DENSITY_F0 = 0.001
DENSITY_FMAX = 2
LIGHTNING_BYTES = (MONTHS + 2) * CLIM_W * CLIM_H + COVER_W * COVER_H
CELL_DEG = 360 / CLIM_W
EARTH_RADIUS_KM = 6371.0088

# GIBS's 2km EPSG:4326 matrix set at its finest level (5): 9 deg tiles of 512.
NATIVE_DEG = 0.5625 / 32
QUAD_DEG = 90
QUAD_PX = round(QUAD_DEG / NATIVE_DEG)  # 5120
FETCH_LAT = 45
LIS_LAT = 38  # VHRMC's bounding box (CMR): 38 S-38 N
BLACK_IN_BAND = 0.0005  # [0, 0.001)'s middle
TAIL_FIT = (0.25, 0.5)
MATCH_L1 = 3


def fetch(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                if res.status != 200:
                    raise RuntimeError(f"HTTP {res.status} for {url}")
                data = res.read()
            break
        except Exception:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.rename(dest)
    print(f"fetched {dest.name} ({len(data)} B)", flush=True)
    return dest


def wms_url(time_iso, bbox, w, h):
    return (
        f"{WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS={LAYER}&STYLES=&SRS=EPSG:4326"
        f"&BBOX={bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}&WIDTH={w}&HEIGHT={h}&FORMAT=image/png&TIME={time_iso}"
    )


def check_decoder_constants():
    """The layout's constants as the decoder has them."""
    src = DECODER.read_text()

    def const(name):
        m = re.search(rf"export const {name} = ([0-9.]+)\b", src)
        assert m, f"{name} not found in {DECODER}"
        return float(m.group(1))

    for name, value in (("CLIM_W", CLIM_W), ("CLIM_H", CLIM_H), ("COVER_W", COVER_W), ("COVER_H", COVER_H),
                        ("MONTHS", MONTHS), ("DENSITY_F0", DENSITY_F0), ("DENSITY_FMAX", DENSITY_FMAX)):
        assert const(name) == value, f"{name}: decoder {const(name)}, script {value}"
    return {name: const(name) for name in ("GUESS_BASE", "SEASON_AMP", "GUESS_LAND_RATIO")}


def check_layer(cache):
    """The layer is the one named, monthly over 1998-2013, in fl/km^2/day."""
    meta = json.loads(fetch(LAYER_METADATA, cache / "layer-metadata.json").read_text())
    concept = meta["conceptIds"][0]
    assert concept["shortName"] == "lisvhrmc" and concept["value"] == "C1979883359-GHRC_DAAC", concept
    assert meta["layerPeriod"] == "Monthly", meta

    W, O, X = "{http://www.opengis.net/wmts/1.0}", "{http://www.opengis.net/ows/1.1}", "{http://www.w3.org/1999/xlink}"
    caps = ET.parse(fetch(WMTS_CAPS, cache / "wmts-caps.xml")).getroot()
    layer = next(l for l in caps.iter(W + "Layer") if l.find(O + "Identifier").text == LAYER)
    dim = layer.find(W + "Dimension")
    assert dim.find(O + "Identifier").text == "Time" and dim.find(W + "Value").text == TIME_RANGE, ET.tostring(dim)
    assert layer.find(W + "TileMatrixSetLink/" + W + "TileMatrixSet").text == "2km"
    assert any(m.get(X + "href") == COLORMAP for m in layer.findall(O + "Metadata"))
    tms = next(t for t in caps.iter(W + "TileMatrixSet") if t.find(O + "Identifier") is not None and t.find(O + "Identifier").text == "2km")
    finest = tms.findall(W + "TileMatrix")[-1]
    assert finest.find(O + "Identifier").text == "5" and finest.find(W + "TileWidth").text == "512"
    assert finest.find(W + "MatrixWidth").text == "40", "level 5 is 40 tiles of 9 deg"

    cmap = ET.parse(fetch(COLORMAP, cache / "colormap.xml")).getroot()
    maps = cmap.findall("ColorMap")
    nodata = maps[0].findall("Entries/ColorMapEntry")
    assert len(nodata) == 1 and nodata[0].get("nodata") == "true" and nodata[0].get("rgb") == "0,0,0"
    data = maps[1]
    assert data.get("title") == "Lightning Flashes" and data.get("units") == "Flashes/km²/day", data.attrib
    rgb, mids = [(0, 0, 0)], [0.0]
    for e in data.findall("Entries/ColorMapEntry"):
        lo, hi = e.get("sourceValue").strip("[)").split(",")
        rgb.append(tuple(int(v) for v in e.get("rgb").split(",")))
        mids.append((float(lo) + float(hi)) / 2 if hi != "+INF" else float("inf"))
    assert len(rgb) == 102 and mids[-1] == float("inf") and mids[1] == 0.003, (len(rgb), mids[:2])
    return np.array(rgb), np.array(mids)


def check_climatology(cache):
    """Each month is the same image in every year, so one year is the climatology."""
    for m in range(1, MONTHS + 1):
        imgs = []
        for y in (YEAR, *CHECK_YEARS):
            path = fetch(wms_url(f"{y}-{m:02d}-01", (-180, -90, 180, 90), 720, 360), cache / f"check-{y}-{m:02d}.png")
            imgs.append(np.asarray(Image.open(path).convert("RGB")))
        for other in imgs[1:]:
            assert np.array_equal(imgs[0], other), f"month {m} differs between years: a series, not a climatology"


def native_quads(cache):
    out = {}
    for m in range(MONTHS):
        for q in range(4):
            west = -180 + q * QUAD_DEG
            bbox = (west, -FETCH_LAT, west + QUAD_DEG, FETCH_LAT)
            out[m, q] = fetch(wms_url(f"{YEAR}-{m + 1:02d}-01", bbox, QUAD_PX, QUAD_PX), cache / f"native-{YEAR}-{m + 1:02d}-q{q}.png")
    return out


def rgb_code(img):
    return (img[..., 0].astype(np.int64) << 16) | (img[..., 1].astype(np.int64) << 8) | img[..., 2]


def pixel_cells(px, deg, top_lat, west, cell_deg, cells_w):
    """Each pixel's cell (bottom row first, from 180 W) and area weight (km^2),
    for a px x px image from (west, top_lat) at deg a pixel."""
    lat = top_lat - (np.arange(px) + 0.5) * deg
    lon = west + (np.arange(px) + 0.5) * deg
    row = np.floor((lat + 90) / cell_deg).astype(np.int64)
    col = np.floor((lon + 180) / cell_deg).astype(np.int64)
    cell = row[:, None] * cells_w + col[None, :]
    area = (np.cos(np.radians(lat)) * np.radians(deg) ** 2 * EARTH_RADIUS_KM**2)[:, None]
    return cell, np.broadcast_to(area, (px, px)), lat


def read_quads(quads):
    """Per month, the area (km^2) of each colour in each cell inside LIS's band;
    and the colours, their total areas and their neighbour counts."""
    colours = {0: 0}
    n_cells = CLIM_W * CLIM_H
    max_colours = 128
    hist = np.zeros((MONTHS, n_cells, max_colours))
    adjacency = np.zeros((max_colours, max_colours))
    for (m, q), path in sorted(quads.items()):
        img = np.asarray(Image.open(path).convert("RGB"))
        assert img.shape == (QUAD_PX, QUAD_PX, 3), (path, img.shape)
        u, inv = np.unique(rgb_code(img), return_inverse=True)
        for c in u.tolist():
            colours.setdefault(c, len(colours))
        assert len(colours) <= max_colours, f"{len(colours)} colours"
        ids = np.array([colours[c] for c in u.tolist()])[inv.reshape(QUAD_PX, QUAD_PX)]
        cell, area, lat = pixel_cells(QUAD_PX, NATIVE_DEG, FETCH_LAT, -180 + q * QUAD_DEG, CELL_DEG, CLIM_W)
        # Its last pixels, a pixel or so either side of 38 deg, are dropped.
        assert (ids[np.abs(lat) > LIS_LAT + 4 * NATIVE_DEG] == 0).all(), f"{path.name}: data poleward of {LIS_LAT} deg"
        inside = np.broadcast_to((np.abs(lat) < LIS_LAT)[:, None], ids.shape)
        k = cell[inside] * max_colours + ids[inside]
        hist[m] += np.bincount(k.ravel(), weights=area[inside].ravel(), minlength=n_cells * max_colours).reshape(n_cells, max_colours)
        for a, b in ((ids[:, 1:], ids[:, :-1]), (ids[1:], ids[:-1])):
            diff = a != b
            adjacency += np.bincount((a[diff] * max_colours + b[diff]), minlength=max_colours**2).reshape(max_colours, max_colours)
    adjacency = adjacency + adjacency.T
    codes = np.array(sorted(colours, key=colours.get))
    n = len(codes)
    return hist[:, :, :n], codes, adjacency[:n, :n]


def hue_turned(rgb, deg):
    out = []
    for r, g, b in rgb:
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        out.append([round(x * 255) for x in colorsys.hsv_to_rgb((h + deg / 360) % 1, s, v)])
    return np.array(out)


def colour_classes(codes, weight, adjacency, palette):
    """Each stored colour's class (0 black, 1..101), recovered as the docstring says."""
    rgb = np.stack([codes >> 16, (codes >> 8) & 255, codes & 255], axis=1)
    data = np.arange(len(codes))[codes != 0]
    best = None
    for deg in np.arange(0, 4.001, 0.05):
        turned = hue_turned(palette[1:], deg)
        d = np.abs(rgb[data, None, :] - turned[None, :, :]).sum(axis=2).min(axis=1)
        score = weight[data][d <= 1].sum() / weight[data].sum()
        if best is None or score > best[0]:
            best = (score, deg, turned)
    score, deg, turned = best
    dist = np.abs(rgb[data, None, :] - turned[None, :, :]).sum(axis=2)
    # One to one, nearest pairs first.
    entry = {}
    taken = set()
    for flat in np.argsort(dist, axis=None, kind="stable"):
        i, j = divmod(int(flat), dist.shape[1])
        if dist[i, j] > MATCH_L1:
            break
        if data[i] in entry or j in taken:
            continue
        entry[data[i]] = j + 1
        taken.add(j)
    unmatched = [c for c in data if c not in entry]
    # The unmatched in the order they neighbour black, then each other.
    order, cur = [], 0
    while len(order) < len(unmatched):
        nxt = max((c for c in unmatched if c not in order), key=lambda c: adjacency[cur, c])
        order.append(nxt)
        cur = nxt
    offset = len(order)
    cls = np.zeros(len(codes), dtype=np.int64)
    for k, c in enumerate(order):
        cls[c] = k + 1
    for c, j in entry.items():
        cls[c] = j + offset
    print(f"stored colours: {len(data)} + black; hue turn {deg:.2f} deg matches {score:.1%} of the area within L1 1; "
          f"{offset} unmatched, the lowest classes: {[tuple(int(v) for v in rgb[c]) for c in order]}")
    assert offset == 2, offset
    assert sorted(cls[data].tolist()) == list(range(1, len(palette))), "not one colour per class"
    # Neighbouring pixels of different colours are mostly a class apart (the
    # data's 1 deg boxcar smooths it), a few a class or two more at storms.
    a, b = np.nonzero(adjacency)
    gap = np.abs(cls[a] - cls[b])
    share = lambda most: adjacency[a, b][gap <= most].sum() / adjacency[a, b].sum()
    print(f"neighbouring colours 1 class apart: {share(1):.1%}, within 3: {share(3):.1%}")
    assert share(1) > 0.85 and share(3) > 0.98, (share(1), share(3))
    assert cls[int(np.argmax(adjacency[0]))] == 1, "black's main neighbour isn't the lowest class"
    return cls


def class_values(mids, area_by_class):
    """Each class's density: its middle, in-band black 0.0005, the open top a
    fitted tail's mean."""
    values = mids.copy()
    values[0] = BLACK_IN_BAND
    fit = (mids >= TAIL_FIT[0]) & (mids < TAIL_FIT[1]) & (area_by_class > 0)
    slope, _ = np.polyfit(mids[fit], np.log(area_by_class[fit]), 1)
    width = -1 / slope
    assert 0 < width < 0.5, width
    values[-1] = TAIL_FIT[1] + width
    print(f"open top class (>= 0.5): {area_by_class[-1] / area_by_class[1:].sum():.2e} of the band's data area, "
          f"read as {values[-1]:.3f} (tail e-folding {width:.3f} from {fit.sum()} classes)")
    return values


def block_mean(texels, w, h):
    """An equirectangular image (top row north, from 180 W) as w x h cell
    means, bottom row first, area-weighted over the texels centred in each."""
    th, tw = texels.shape
    lat = 90 - (np.arange(th) + 0.5) * 180 / th
    lon = -180 + (np.arange(tw) + 0.5) * 360 / tw
    row = np.minimum(h - 1, np.floor((lat + 90) / (180 / h)).astype(np.int64))
    col = np.minimum(w - 1, np.floor((lon + 180) / (360 / w)).astype(np.int64))
    cell = (row[:, None] * w + col[None, :]).ravel()
    weight = np.broadcast_to(np.cos(np.radians(lat))[:, None], texels.shape).ravel()
    num = np.bincount(cell, weights=weight * texels.ravel(), minlength=w * h)
    den = np.bincount(cell, weights=weight, minlength=w * h)
    assert (den > 0).all()
    return (num / den).reshape(h, w)


def green(path):
    return np.asarray(Image.open(path).convert("RGB"))[..., 1].astype(np.float64) / 255


def to_byte(x):
    """round(255 x), half up as Math.round, for x in 0..1."""
    return np.floor(255 * np.clip(x, 0, 1) + 0.5).astype(np.uint8)


def encode_density(f):
    f = np.clip(f, 0, DENSITY_FMAX)
    return np.floor(255 * np.log1p(f / DENSITY_F0) / np.log1p(DENSITY_FMAX / DENSITY_F0) + 0.5).astype(np.uint8)


def decode_density(b):
    return DENSITY_F0 * np.expm1(b / 255 * np.log1p(DENSITY_FMAX / DENSITY_F0))


def cell_areas():
    edges = np.radians(-90 + np.arange(CLIM_H + 1) * CELL_DEG)
    row = EARTH_RADIUS_KM**2 * np.radians(CELL_DEG) * np.diff(np.sin(edges))
    return np.broadcast_to(row[:, None], (CLIM_H, CLIM_W))


def band_share():
    """The share of each row's area inside LIS's band."""
    edges = np.radians(np.clip(-90 + np.arange(CLIM_H + 1) * CELL_DEG, -LIS_LAT, LIS_LAT))
    full = np.diff(np.sin(np.radians(-90 + np.arange(CLIM_H + 1) * CELL_DEG)))
    return np.diff(np.sin(edges)) / full


def cell_at(lat, lon):
    return int((lat + 90) // CELL_DEG), int((lon + 180) // CELL_DEG)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: uv run --no-project --with numpy --with pillow python -I scripts/build-lightning-climatology.py <cache_dir>")
    cache = Path(sys.argv[1])
    cache.mkdir(parents=True, exist_ok=True)
    guess = check_decoder_constants()
    palette, mids = check_layer(cache)
    check_climatology(cache)
    hist, codes, adjacency = read_quads(native_quads(cache))

    weight = hist.sum(axis=(0, 1))
    cls = colour_classes(codes, weight, adjacency, palette)
    area_by_class = np.bincount(cls, weights=weight, minlength=len(palette))
    values = class_values(mids, area_by_class)

    area = cell_areas()
    covered = hist.sum(axis=2)[0].reshape(CLIM_H, CLIM_W)
    assert np.allclose(hist.sum(axis=2), hist.sum(axis=2)[0])
    coverage = np.broadcast_to(band_share()[:, None], (CLIM_H, CLIM_W))
    density = (hist @ values[cls]).reshape(MONTHS, CLIM_H, CLIM_W) / np.where(covered > 0, covered, 1)

    land = block_mean(1 - green(ASSETS / "earth-specular-2k.jpg"), CLIM_W, CLIM_H)
    cover = block_mean(green(ASSETS / "earth-clouds-2k.jpg"), COVER_W, COVER_H)

    density_bytes = encode_density(density)
    coverage_bytes = to_byte(coverage)
    blob = b"".join([density_bytes.tobytes(), to_byte(land).tobytes(), coverage_bytes.tobytes(), to_byte(cover).tobytes()])
    assert len(blob) == LIGHTNING_BYTES, len(blob)
    assert ((coverage_bytes > 0) <= (covered > 0)).all(), "coverage without LIS density"

    # Checks and the report, from the bytes as the app decodes them.
    f = decode_density(density_bytes.astype(np.float64))
    cov = coverage_bytes / 255
    rate = lambda d: (d * cov * area).sum(axis=(-2, -1)) / 86_400
    band_raw = (density * coverage * area).sum(axis=(1, 2)).mean() / 86_400
    band = rate(f)
    rows = np.nonzero(coverage_bytes.max(axis=1))[0]
    full = np.nonzero(coverage_bytes.min(axis=1) == 255)[0]
    print(f"coverage: rows {rows[0]}-{rows[-1]} ({-90 + rows[0] * CELL_DEG:g} to {-90 + (rows[-1] + 1) * CELL_DEG:g} deg), "
          f"full {-90 + full[0] * CELL_DEG:g} to {-90 + (full[-1] + 1) * CELL_DEG:g}, edge rows' byte {sorted(int(v) for v in set(coverage_bytes[rows].ravel()) - {0, 255})}")
    print(f"LIS band rate: {band.mean():.2f} fl/s over 12 months (before encoding {band_raw:.2f}), "
          f"months {band.min():.1f}-{band.max():.1f}")

    yearly = f.mean(axis=0)
    flat = yearly[cov == 1]
    top1 = np.quantile(flat, 0.99)
    peak = np.unravel_index(np.argmax(yearly), yearly.shape)
    print(f"max cell: {yearly.max():.3f} fl/km^2/day ({yearly.max() * 365.25:.0f} /yr) at "
          f"{-90 + (peak[0] + 0.5) * CELL_DEG:g}, {-180 + (peak[1] + 0.5) * CELL_DEG:g}; max month cell {f.max():.3f}; "
          f"top 1% above {top1:.3f}")
    places = {"Lake Maracaibo": (9.75, -71.5), "eastern Congo": (-1.25, 28.75), "Sahara": (25, 10), "mid-South-Pacific": (-20, -130)}
    for name, (lat, lon) in places.items():
        r, c = cell_at(lat, lon)
        print(f"  {name}: year {yearly[r, c]:.4f}, January {f[0, r, c]:.4f}, land {land[r, c]:.2f}")
    for name in ("Lake Maracaibo", "eastern Congo"):
        assert yearly[cell_at(*places[name])] >= top1, name
    assert f[0][cell_at(*places["Sahara"])] < 0.003
    assert land[cell_at(*places["Sahara"])] > 0.95 and land[cell_at(0, -150)] < 0.05

    # The guess, as densityOf blends it (src/lightning-climatology.ts), at each month's middle.
    lat_c = -90 + (np.arange(CLIM_H) + 0.5) * CELL_DEG
    hemi = np.clip(lat_c / 20, -1, 1)[:, None]
    total = []
    for m in range(MONTHS):
        season = 1 - guess["SEASON_AMP"] * hemi * np.cos(2 * np.pi * m / MONTHS)
        g = guess["GUESS_BASE"] * season * (1 + (guess["GUESS_LAND_RATIO"] - 1) * to_byte(land) / 255)
        total.append(((cov * f[m] + (1 - cov) * g) * area).sum() / 86_400)
    print(f"global rate with the guess beyond LIS (GUESS_BASE {guess['GUESS_BASE']}): {np.mean(total):.1f} fl/s")
    edge = (np.abs(lat_c) >= 30) & (np.abs(lat_c) < 37.5)
    for hemisphere, sel, months in (("north", lat_c > 0, (5, 6, 7)), ("south", lat_c < 0, (11, 0, 1))):
        rows_sel = edge & sel
        landy = (land[rows_sel] > 0.5)
        lis = f[list(months)][:, rows_sel][:, landy].mean()
        season = 1 + guess["SEASON_AMP"] * np.mean([-np.cos(2 * np.pi * m / MONTHS) for m in months]) * (1 if hemisphere == "north" else -1)
        g = guess["GUESS_BASE"] * season * guess["GUESS_LAND_RATIO"]
        print(f"  over land at 30-37.5 deg {hemisphere} in its summer: LIS {lis:.4f}, the guess {g:.4f} fl/km^2/day (x{g / lis:.2f})")

    assert 34 < band.mean() < 46, band.mean()
    OUT.write_bytes(blob)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(blob)} B)")


if __name__ == "__main__":
    main()
