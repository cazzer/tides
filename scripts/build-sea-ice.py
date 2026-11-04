"""Build the seasons tour's sea ice (tides-zec.19; format: src/demo/sea-ice.ts).

- src/assets/sea-ice-2025.bin: a year of sea ice, both hemispheres, every
  7 days from 1 January 2025 (53 frames, the last 31 December), on the
  source's own 25 km polar grids, plus the year's daily extents.
- src/assets/sea-ice-mask.png: where the globe's ice layer may draw, 0.1 deg
  equirectangular over 35-90 N and 45-90 S: red is sea (the shipped
  elevation map's 0 m), green is sea the day map paints as ice all year
  (its Arctic Ocean), which the layer repaints as open water where the
  year's ice is gone.

Source: NSIDC Sea Ice Index, Version 4 (G02135; Fetterer et al., NSIDC,
doi:10.7265/a98x-0f50), daily concentration GeoTIFFs
N_YYYYMMDD_concentration_v4.0.tif / S_... (25 km NSIDC polar stereographic,
EPSG:3411 / 3412, Hughes 1980 ellipsoid, true scale at 70 N / 70 S; values
concentration x 10, 2510 the pole hole, 2530 coast, 2540 land, 2550
missing) and the daily extent tables N_seaice_extent_daily_v4.0.csv /
S_...csv, from https://noaadata.apps.nsidc.org/NOAA/G02135/{north,south}/.
Nothing at runtime fetches them.

Each grid: cells under 15% are open water (the index's own extent edge),
the rest kept to the nearest 5%; the north's pole hole (never seen by the
satellites) is full ice, as the index counts it; coast, land and missing
cells take the mean of their sea neighbours, FILL_PASSES times, so the ice
reaches the elevation map's coast; what is left is open water. Stored as
bytes (0-255 for 0-100%), frame after frame, then gzip (storing each frame
less the one before compressed worse: the 5% steps flicker week to week).

usage: uv run --no-project --with numpy --with pillow python -I scripts/build-sea-ice.py <grid_dir> <csv_dir> [preview_dir]
  <grid_dir> holds the 106 GeoTIFFs (2025-01-01 + 7k days, k = 0..52, N and S),
  <csv_dir> the two extent tables.
"""
import datetime
import gzip
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path.cwd()
ASSETS = ROOT / "src" / "assets"
GRIDS = Path(sys.argv[1])
CSVS = Path(sys.argv[2])
PREVIEW = Path(sys.argv[3]) if len(sys.argv) > 3 else None

YEAR = 2025
STEP_DAYS = 7
FRAMES = 53
FILL_PASSES = 4
EXTENT_EDGE = 150  # 15%, x10
QUANT = 20  # 5% steps

# The mask's bands (deg) and its texels per degree.
MASK_PER_DEG = 10
NORTH_BAND = (35, 90)
SOUTH_BAND = (-90, -45)


def read_tiff(path):
    """An uncompressed little-endian strip TIFF's first image, as uint16."""
    b = path.read_bytes()
    assert b[:2] == b"II", path
    off = struct.unpack("<I", b[4:8])[0]
    n = struct.unpack("<H", b[off : off + 2])[0]
    sizes = {1: ("B", 1), 3: ("H", 2), 4: ("I", 4)}
    tags = {}
    for i in range(n):
        e = b[off + 2 + 12 * i : off + 14 + 12 * i]
        tag, typ, cnt = struct.unpack("<HHI", e[:8])
        if typ not in sizes:
            continue
        fmt, sz = sizes[typ]
        data = e[8:12] if sz * cnt <= 4 else b[struct.unpack("<I", e[8:12])[0] :][: sz * cnt]
        tags[tag] = struct.unpack("<" + fmt * cnt, data[: sz * cnt])
    w, h, bits = tags[256][0], tags[257][0], tags[258][0]
    assert tags.get(259, (1,))[0] == 1, f"{path}: compressed"
    raw = b"".join(b[o : o + c] for o, c in zip(tags[273], tags[279]))
    return np.frombuffer(raw, dtype=np.uint16 if bits == 16 else np.uint8)[: w * h].reshape(h, w)


def grid_fraction(raw):
    """0..1 ice, or NaN where the grid has no sea reading."""
    out = np.full(raw.shape, np.nan, dtype=np.float64)
    sea = raw <= 1000
    conc = np.where(raw >= EXTENT_EDGE, raw, 0) / 1000.0
    out[sea] = np.round(conc[sea] * QUANT) / QUANT
    out[raw == 2510] = 1.0
    for _ in range(FILL_PASSES):
        gaps = np.isnan(out)
        if not gaps.any():
            break
        padded = np.pad(out, 1, constant_values=np.nan)
        stack = np.stack([padded[1 + dy : 1 + dy + out.shape[0], 1 + dx : 1 + dx + out.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx])
        have = ~np.isnan(stack)
        total = np.where(have, stack, 0).sum(0)
        count = have.sum(0)
        fill = gaps & (count > 0)
        out[fill] = np.round(total[fill] / count[fill] * QUANT) / QUANT
    return np.nan_to_num(out, nan=0.0)


def frame_dates():
    start = datetime.date(YEAR, 1, 1)
    return [start + datetime.timedelta(days=STEP_DAYS * k) for k in range(FRAMES)]


def read_extents(path):
    """The year's daily extents (million km^2), one per day of YEAR, gaps interpolated."""
    days = (datetime.date(YEAR + 1, 1, 1) - datetime.date(YEAR, 1, 1)).days
    values = np.full(days, np.nan)
    for line in path.read_text().splitlines()[2:]:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4 or not parts[0].isdigit() or int(parts[0]) != YEAR:
            continue
        d = datetime.date(int(parts[0]), int(parts[1]), int(parts[2]))
        values[(d - datetime.date(YEAR, 1, 1)).days] = float(parts[3])
    idx = np.arange(days)
    ok = ~np.isnan(values)
    return np.interp(idx, idx[ok], values[ok])


def build_frames():
    north, south = [], []
    for d in frame_dates():
        stamp = d.strftime("%Y%m%d")
        north.append(grid_fraction(read_tiff(GRIDS / f"N_{stamp}_concentration_v4.0.tif")))
        south.append(grid_fraction(read_tiff(GRIDS / f"S_{stamp}_concentration_v4.0.tif")))
    return north, south


def to_bytes(fraction):
    return np.round(fraction * 255).astype(np.uint8)


def write_bin(north, south, extent_n, extent_s):
    nh, nw = north[0].shape
    sh, sw = south[0].shape
    days = len(extent_n)
    header = b"SIC1" + struct.pack("<HHHHHHHH", YEAR, STEP_DAYS, FRAMES, nw, nh, sw, sh, days)
    extents = np.round(np.concatenate([extent_n, extent_s]) * 1000).astype("<u2").tobytes()
    body = bytearray()
    for n, s in zip(north, south):
        body += to_bytes(n).tobytes() + to_bytes(s).tobytes()
    data = gzip.compress(header + extents + bytes(body), compresslevel=9, mtime=0)
    (ASSETS / "sea-ice-2025.bin").write_bytes(data)
    print(f"sea-ice-2025.bin: {len(data)} bytes ({FRAMES} frames, N {nw}x{nh}, S {sw}x{sh})")


def read_dem():
    b = gzip.decompress((ASSETS / "earth-dem-4k.bin").read_bytes())
    w, h = struct.unpack("<HH", b[4:8])
    n = w * h
    hi = np.frombuffer(b[8 : 8 + n], dtype=np.uint8).reshape(h, w).astype(np.uint16)
    lo = np.frombuffer(b[8 + n : 8 + 2 * n], dtype=np.uint8).reshape(h, w).astype(np.uint16)
    delta = (hi << 8) | lo
    return np.cumsum(delta, axis=1, dtype=np.uint64).astype(np.uint16)


def band_lats(band):
    """Texel-centre latitudes, north first."""
    lo, hi = band
    rows = (hi - lo) * MASK_PER_DEG
    return hi - (np.arange(rows) + 0.5) / MASK_PER_DEG


def sample_rows(image, band):
    """Box means of an equirect image (rows north first, columns from -180 east)
    over the mask's texels in `band`, as float."""
    h, w = image.shape[:2]
    lo, hi = band
    top = (90 - hi) / 180 * h
    bottom = (90 - lo) / 180 * h
    size = (360 * MASK_PER_DEG, (hi - lo) * MASK_PER_DEG)
    box = (0, top, w, bottom)
    channels = image[..., None] if image.ndim == 2 else image
    out = [np.asarray(Image.fromarray(channels[..., c].astype(np.float32), "F").resize(size, Image.BOX, box=box)) for c in range(channels.shape[-1])]
    out = np.stack(out, -1).astype(np.float64)
    return out[..., 0] if image.ndim == 2 else out


def write_mask():
    dem = read_dem()
    day = np.asarray(Image.open(ASSETS / "earth-day.jpg").convert("RGB"))
    out_rows = []
    ocean_samples = []
    for band in (NORTH_BAND, SOUTH_BAND):
        lats = band_lats(band)
        sea = sample_rows((dem == 0).astype(np.float32), band)
        rgb = sample_rows(day, band) / 255.0
        lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
        # The day map's all-year Arctic ice: bright sea, north only (the
        # south's white is the continent and its shelves), past 60 N (the
        # Caspian's and Hudson Bay's southern white are kept as drawn).
        baked = np.clip((lum - 0.3) / 0.3, 0, 1) * sea * (lats[:, None] > 60) if band is NORTH_BAND else np.zeros_like(sea)
        if band is NORTH_BAND:
            pick = (lats[:, None] > 55) & (lats[:, None] < 68) & (sea > 0.99) & (lum < 0.2)
            ocean_samples.append(rgb[pick])
        out_rows.append(np.stack([sea, baked, np.zeros_like(sea)], -1))
    mask = np.concatenate(out_rows)
    Image.fromarray(np.round(mask * 255).astype(np.uint8), "RGB").save(ASSETS / "sea-ice-mask.png", optimize=True)
    ocean = np.concatenate(ocean_samples).mean(0)
    print(f"sea-ice-mask.png: {mask.shape[1]}x{mask.shape[0]}, {(ASSETS / 'sea-ice-mask.png').stat().st_size} bytes")
    print("open-water colour (sRGB 0-1, the day map's 55-68N sea):", np.round(ocean, 4))
    return mask


def main():
    north, south = build_frames()
    extent_n = read_extents(CSVS / "N_extent_daily.csv")
    extent_s = read_extents(CSVS / "S_extent_daily.csv")
    write_bin(north, south, extent_n, extent_s)
    write_mask()
    for k in (11, 37):
        d = frame_dates()[k]
        print(d, "extent N", round(extent_n[(d - datetime.date(YEAR, 1, 1)).days], 2), "S", round(extent_s[(d - datetime.date(YEAR, 1, 1)).days], 2))
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        for k in (11, 37):
            Image.fromarray(to_bytes(north[k])).save(PREVIEW / f"n{k}.png")
            Image.fromarray(to_bytes(south[k])).save(PREVIEW / f"s{k}.png")


main()
