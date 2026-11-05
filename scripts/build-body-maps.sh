#!/usr/bin/env bash
# Builds the GPU-compressed body maps (tides-0oi.14): a mipmapped UASTC KTX2
# beside each planet's and moon's shipped JPEG, which three's KTX2Loader
# transcodes to ASTC 4x4 (phones, Apple), BC7 (other desktops) or ETC2, a
# quarter of the JPEG's GPU memory or less. The JPEGs stay: they are the
# maps for devices with none of those formats and for a failed load.
#
# Input: the shipped JPEGs, so a KTX2 holds the same texels the JPEG
# decodes to. Output:
#   src/assets/<planet>-2k.jpg      -> src/assets/bodies/<planet>-2k.ktx2
#   src/assets/moons/<key>-<n>k.jpg -> src/assets/moons/<key>-<n>k.ktx2
# Earth and Earth's Moon are not in the set; Saturn's ring stays PNG.
#
# Every map carries its full chain down to 1 × 1, filtered in linear light
# (-mip_srgb, as the GPU builds the JPEG's chain): ship mode's proxy is the
# file's own small levels (ship/body-map-residency.ts), so a short chain
# would leave the body on its full map.
# -y_flip: three never flips compressed textures on upload.
#
# Needs ImageMagick and basisu (brew install imagemagick basis_universal).
# usage: scripts/build-body-maps.sh [work_dir]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT_DIR/src/assets"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK" "$ASSETS/bodies"

for tool in magick basisu; do
  command -v "$tool" >/dev/null || { echo "$tool not found: brew install imagemagick basis_universal" >&2; exit 1; }
done

UASTC=(-uastc -uastc_level 2 -uastc_rdo_l 3 -mipmap -mip_srgb -y_flip -srgb)

encode() {
  local src="$1" out="$2"
  local png
  png="$WORK/$(basename "${src%.jpg}").png"
  magick "$src" -colorspace sRGB -type TrueColor "$png"
  basisu "${UASTC[@]}" "$png" -output_file "$out" >/dev/null
  echo "$out $(wc -c <"$src" | tr -d ' ') -> $(wc -c <"$out" | tr -d ' ') bytes"
}

for planet in mercury venus mars jupiter saturn uranus neptune; do
  encode "$ASSETS/$planet-2k.jpg" "$ASSETS/bodies/$planet-2k.ktx2"
done

for src in "$ASSETS"/moons/*-[12]k.jpg; do
  encode "$src" "${src%.jpg}.ktx2"
done
