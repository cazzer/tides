#!/usr/bin/env bash
# Builds the flight-only high-res planet maps in src/assets/flight
# (tides-01v.6): mipmapped KTX2, fetched lazily in ship mode.
#
# Sources: Solar System Scope, CC BY 4.0 (credited in Credits.tsx), the
# same maps the 2k JPEGs were cut from. Mars and Mercury ship 8k (desktop)
# and 4k (phones and tablets). Their "8k" Jupiter and Saturn are 4096 × 2048
# and Venus's cloud deck tops out at 4k, so those ship one 4k file. Uranus and
# Neptune have nothing above 2k.
#
# Codecs, judged at the ship's 1.02 R stop:
# - Mars, Mercury: Basis ETC1S at -q 255, ~6 MB per 8k map (UASTC was 30 MB),
#   ~0.5–1 B per texel on the GPU. Its per-block colour error tints a grey
#   map, so Mercury (grey, saturation 0.007) is encoded from greyscale.
# - Jupiter, Saturn, Venus: UASTC with RDO (~4 MB at 4k). ETC1S left visible
#   hue patches in their smooth bands.
# - Earth's static clouds (tides-01v.12): ETC1S from greyscale, ~6 MB at 8k
#   (UASTC was 8 MB at 4k). The map is data, the cloud shader's opacity, so
#   it is tagged linear, and toned to match earth-clouds.jpg, the 2k map it
#   replaces up close (fit by least squares on the 8k map cut to 2k).
# -y_flip: three never flips compressed textures on upload.
#
# Needs ImageMagick and basisu (brew install imagemagick basis_universal).
# usage: scripts/build-flight-textures.sh <download_dir> [out_dir]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DL="${1:?usage: $0 <download_dir> [out_dir]}"
OUT="${2:-$ROOT_DIR/src/assets/flight}"
BASE_URL="https://www.solarsystemscope.com/textures/download"
mkdir -p "$DL" "$OUT"

for tool in magick basisu; do
  command -v "$tool" >/dev/null || { echo "$tool not found: brew install imagemagick basis_universal" >&2; exit 1; }
done

ETC1S=(-etc1s -q 255)
UASTC=(-uastc -uastc_level 2 -uastc_rdo_l 3)

# key | source | sizes | codec | transfer | extra magick options
BODIES=(
  "mars|8k_mars.jpg|8k 4k|etc1s|srgb|"
  "mercury|8k_mercury.jpg|8k 4k|etc1s|srgb|-colorspace gray"
  "jupiter|8k_jupiter.jpg|4k|uastc|srgb|"
  "saturn|8k_saturn.jpg|4k|uastc|srgb|"
  "venus|4k_venus_atmosphere.jpg|4k|uastc|srgb|"
  "earth-clouds|8k_earth_clouds.jpg|8k 4k|etc1s|linear|-function Polynomial 1.031,0.0117"
)

for row in "${BODIES[@]}"; do
  IFS='|' read -r key source sizes codec transfer extra <<<"$row"
  src="$DL/$source"
  if [[ ! -s "$src" ]]; then
    echo "Downloading $source"
    curl -fsSL -o "$src.part" "$BASE_URL/$source"
    mv "$src.part" "$src"
  fi
  # A missing map comes back as an HTML page with status 200.
  if ! file -b "$src" | grep -q '^JPEG image'; then
    echo "Not a JPEG: $src" >&2
    exit 1
  fi
  if [[ "$codec" == etc1s ]]; then options=("${ETC1S[@]}"); else options=("${UASTC[@]}"); fi
  for size in $sizes; do
    width=$(( ${size%k} * 1024 ))
    png="$DL/$key-$size.png"
    # shellcheck disable=SC2086 # $extra is a list of magick options
    magick "$src" -resize "${width}x$(( width / 2 ))!" $extra -colorspace sRGB -type TrueColor "$png"
    basisu "${options[@]}" -mipmap -y_flip "-$transfer" "$png" -output_file "$OUT/$key-$size.ktx2" >/dev/null
    echo "$OUT/$key-$size.ktx2 $(wc -c <"$OUT/$key-$size.ktx2" | tr -d ' ') bytes"
  done
done
