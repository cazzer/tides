#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS_DIR="$ROOT_DIR/src/assets"

if command -v magick >/dev/null 2>&1; then
  IM_CMD=(magick)
elif command -v convert >/dev/null 2>&1; then
  IM_CMD=(convert)
else
  echo "ImageMagick not found. Install with: brew install imagemagick" >&2
  exit 1
fi

INPUTS=(
  "earth-day.jpg"
  "earth-night.jpg"
  "earth-normal.jpg"
  "earth-specular.jpg"
  "earth-clouds.jpg"
  "earth-clouds-alpha.jpg"
  "earth-bump.jpg"
  "moon.jpg"
  "sun-8k.jpg"
)

for filename in "${INPUTS[@]}"; do
  src="$ASSETS_DIR/$filename"
  if [[ ! -f "$src" ]]; then
    echo "Missing source: $src" >&2
    continue
  fi

  base="${filename%.jpg}"
  if [[ "$base" == "sun-8k" ]]; then
    out="$ASSETS_DIR/sun-2k.jpg"
  else
    out="$ASSETS_DIR/${base}-2k.jpg"
  fi

  "${IM_CMD[@]}" "$src" -resize 2048x2048\> -filter Lanczos -strip -quality 85 "$out"
  echo "Wrote: $out"
done
