"""Build the moon surface maps in src/assets/moons (tides-2hv.17).

Per moon: read the source mosaic (black no-data pixels -> transparent), roll
so longitude 0 is at the centre (east to the right), downsample in linear
light with alpha weighting, fill gaps by push-pull, scale so the
area-weighted mean colour is the moon's catalog colour (moons.ts; contrast
eased on the bright moons, highlights through a shoulder), then write sRGB
JPEGs: <key>-1k.jpg always, <key>-2k.jpg where the source has the detail.

Sources and licences: src/moons/moon-textures.ts. Download into <dl_dir>:
  usgs/<name>.tif   from https://planetarymaps.usgs.gov/mosaic/<name>.tif
                    (Mimas: .../wms_basemaps/Saturn/Mimas/Cassini/)
  nasa3d/<name>.jpg from NASA-3D-Resources "Images and Textures"/<name>/

Which USGS maps need rolling: each ISIS label's UpperLeftCornerX /
EquatorialRadius gives the left edge's longitude (ISIS maps all run east to
the right); those starting at 0 are rolled half a turn.

usage: uv run --no-project --with numpy python -I scripts/build-moon-textures.py <dl_dir> <out_dir> [keys...]
"""
import subprocess
import sys
from pathlib import Path

import numpy as np

DL = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
TMP = DL / "tmp"
TMP.mkdir(exist_ok=True)

U = "usgs/"
N = "nasa3d/"
# key: (source, roll half a turn, write 2k, catalog colour, no-data fuzz %, contrast cap, blur px)
MOONS = {
    "phobos": (U + "Phobos_ME_SRC_Mosaic_Global_16ppd.tif", False, True, "#6e655c", 0, 1, 0),
    # NASA 3D maps have no labels. Checked by feature that the set runs lon 0
    # at the centre, east to the right: Herschel on its Mimas at 112° W,
    # Arden and Elsinore Coronae on Miranda at 74° E and 257° E. The rest of
    # the set is assumed to match.
    "deimos": (N + "Mars - Deimos.jpg", False, False, "#8a7d6e", 0, 1, 0),
    "io": (U + "Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif", False, True, "#e3cf6b", 0, 1, 0),
    "europa": (U + "Europa_Voyager_GalileoSSI_global_mosaic_500m.tif", True, True, "#cdbfa5", 0, 1, 0),
    "ganymede": (U + "Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif", True, True, "#9a8f80", 0, 1, 0),
    "callisto": (U + "Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif", True, True, "#5f5549", 0, 0.8, 0),
    "mimas": (U + "Mimas_PDS_8ppd_dd360.tif", True, True, "#bdb8b0", 0, 1, 0),
    "enceladus": (U + "Enceladus_Cassini_mosaic_global_110m.tif", False, True, "#f2f4f6", 0, 1, 0),
    "tethys": (U + "Tethys_Cassini_mosaic_global_293m.tif", False, True, "#dedad3", 0, 1, 0),
    "dione": (U + "Dione_Cassini_Voyager_mosaic_global_154m.tif", False, True, "#cfcac2", 0, 1, 0),
    "rhea": (U + "Rhea_Cassini_Voyager_mosaic_global_417m.tif", False, True, "#c6c0b6", 0, 1, 0),
    # Titan's surface is lost in its haze in visible light: a faint, soft
    # hint of the 938 nm map under the haze's orange.
    "titan": (U + "Titan_ISS_P19658_Mosaic_Global_4km.tif", True, False, "#d8a24a", 0, 0.12, 6),
    "iapetus": (U + "Iapetus_Cassini_Voyager_mosaic_global_783m.tif", False, True, "#8c7f6d", 0, 1, 0),
    "miranda": (N + "Uranus - Miranda.jpg", False, False, "#aaa69f", 4, 1, 0),
    "ariel": (N + "Uranus - Ariel.jpg", False, False, "#bbb6ae", 4, 1, 0),
    "umbriel": (N + "Uranus - Umbriel.jpg", False, False, "#6c6761", 4, 1, 0),
    "titania": (N + "Uranus - Titania.jpg", False, False, "#a9a095", 4, 1, 0),
    "oberon": (N + "Uranus - Oberon.jpg", False, False, "#988b80", 4, 1, 0),
    "triton": (U + "Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif", False, True, "#d4c3b8", 0, 1, 0),
}

W, H = 2048, 1024
MIN_CONTRAST = 0.5


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def hex_linear(h):
    return srgb_to_linear(np.array([int(h[i : i + 2], 16) / 255 for i in (1, 3, 5)]))


def read_pam(path):
    data = path.read_bytes()
    end = data.index(b"ENDHDR\n") + 7
    header = dict(
        line.split(" ", 1) for line in data[:end].decode().splitlines()[1:-1]
    )
    w, h, d = int(header["WIDTH"]), int(header["HEIGHT"]), int(header["DEPTH"])
    assert int(header["MAXVAL"]) == 65535, header
    a = np.frombuffer(data[end:], dtype=">u2").reshape(h, w, d).astype(np.float64)
    return a / 65535


def load(key, src, roll, fuzz):
    """Linear RGB and coverage alpha at W x H, lon 0 centred."""
    pam = TMP / f"{key}.pam"
    cmd = ["magick", f"{DL / src}[0]", "-depth", "16", "-colorspace", "sRGB", "-type", "TrueColor"]
    cmd += ["-alpha", "set", "-fuzz", f"{fuzz}%", "-transparent", "black"]
    cmd += ["-colorspace", "RGB", "-filter", "Box" if fuzz else "Lanczos", "-resize", f"{W}x{H}!"]
    cmd += [f"PAM:{pam}"]
    subprocess.run(cmd, check=True)
    a = read_pam(pam)
    if roll:
        a = np.roll(a, W // 2, axis=1)
    rgb, alpha = a[..., :3], a[..., 3]
    # magick's resize un-premultiplies; partially covered edge pixels keep
    # their colour, so treat low coverage as a gap.
    return rgb, alpha


def smooth(x):
    """[1 2 1] blur, wrapping in longitude, clamped at the poles."""
    x = (np.roll(x, 1, axis=1) + 2 * x + np.roll(x, -1, axis=1)) / 4
    up = np.concatenate([x[:1], x[:-1]], axis=0)
    down = np.concatenate([x[1:], x[-1:]], axis=0)
    return (up + 2 * x + down) / 4


def push_pull(rgb, alpha):
    """Fill alpha < 1 from coarser averages of the covered pixels."""
    if alpha.min() >= 1:
        return rgb
    ca = rgb * alpha[..., None]
    if ca.shape[0] == 1 or ca.shape[1] == 1:
        mean = ca.reshape(-1, 3).sum(0) / max(alpha.sum(), 1e-9)
        return np.broadcast_to(mean, rgb.shape).copy()
    h, w = alpha.shape
    ca2 = ca.reshape(h // 2, 2, w // 2, 2, 3).mean((1, 3))
    a2 = alpha.reshape(h // 2, 2, w // 2, 2).mean((1, 3))
    safe = np.where(a2 > 0, a2, 1)[..., None]
    coarse = push_pull(np.where(a2[..., None] > 0, ca2 / safe, 0), a2)
    up = smooth(np.repeat(np.repeat(coarse, 2, axis=0), 2, axis=1))
    return ca + (1 - alpha[..., None]) * up


def erode(a, r):
    for _ in range(r):
        a = np.minimum.reduce([a, np.roll(a, 1, 1), np.roll(a, -1, 1),
                               np.concatenate([a[:1], a[:-1]]), np.concatenate([a[1:], a[-1:]])])
    return a


def shoulder(x, k=0.7):
    """Identity below k, easing toward 1 above it."""
    return np.where(x < k, x, k + (1 - k) * (1 - np.exp(-(x - k) / (1 - k))))


def box_blur(x, r):
    for _ in range(r):
        x = smooth(x)
    return x


def build(key, src, roll, high, colour, fuzz, contrast_cap, blur):
    rgb, alpha = load(key, src, roll, fuzz)
    alpha = np.clip((alpha - 0.5) * 4, 0, 1)
    if fuzz:
        # Voyager's maps darken toward the terminator at their ragged edge:
        # pull the edge in and feather it.
        alpha = smooth(smooth(erode(alpha, 12)))
    rgb = push_pull(rgb, alpha)
    if blur:
        rgb = box_blur(rgb, blur)
    lat = (np.arange(H) + 0.5) / H * np.pi - np.pi / 2
    weight = np.cos(lat)[:, None] * np.ones(W)
    mean = (rgb * weight[..., None]).reshape(-1, 3).sum(0) / weight.sum()
    target = hex_linear(colour)
    ratio = rgb / mean
    lum = ratio.mean(-1)
    p99 = np.percentile(lum, 99.5)
    # Mosaics are stretched for legibility; keep at least half that stretch
    # on the bright moons and let the shoulder take the highlights.
    contrast = (0.98 / target.max() - 1) / (p99 - 1)
    contrast = min(contrast_cap, max(contrast, MIN_CONTRAST))
    # The shoulder darkens the brightest moons a little: rescale until the
    # output's mean is the catalog colour again.
    gain = np.ones(3)
    for _ in range(4):
        out = shoulder(np.maximum(gain * target * (1 + contrast * (ratio - 1)), 0))
        out_mean = (out * weight[..., None]).reshape(-1, 3).sum(0) / weight.sum()
        gain *= target / out_mean
    print(f"{key:10s} out {np.round(out_mean, 3)} target {np.round(target, 3)} p99.5 {p99:.2f} contrast {contrast:.2f} gaps {100 * (1 - alpha).mean():.1f}%")

    def write(img, size):
        ppm = TMP / f"{key}-{size}.ppm"
        s = np.round(linear_to_srgb(img) * 255).astype(np.uint8)
        h, w = s.shape[:2]
        ppm.write_bytes(f"P6 {w} {h} 255\n".encode() + s.tobytes())
        subprocess.run(
            ["magick", str(ppm), "-strip", "-sampling-factor", "4:2:0", "-quality", "84", "-interlace", "JPEG", str(OUT / f"{key}-{size}.jpg")],
            check=True,
        )

    if high:
        write(out, "2k")
    write(out.reshape(H // 2, 2, W // 2, 2, 3).mean((1, 3)), "1k")


only = sys.argv[3:]
for key, spec in MOONS.items():
    if not only or key in only:
        build(key, *spec)
