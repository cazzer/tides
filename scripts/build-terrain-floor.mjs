// Build src/assets/earth-terrain-max.bin, the flight model's heightmap for
// Earth's terrain floor (tides-01v.8.3; src/ship/terrain-floor.ts).
//
// Each byte is the highest bump-map grey over a block of texels: 512 × 256
// blocks, rows north to south, columns from longitude −180° east, the bump
// maps' own layout. The ground mesh may load either map (EarthRenderer's high
// and low texture sets), and the 4k one keeps peaks the 2k one averages
// away, so each block takes the max over both.
//
// Requires ImageMagick (magick) to decode the JPEGs. Then rebuild the cloud
// ceiling from it: scripts/build-cloud-ceiling.mjs.
// usage: node scripts/build-terrain-floor.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const assets = path.join(root, "src", "assets");
const output = path.join(assets, "earth-terrain-max.bin");
const SOURCES = ["earth-bump.jpg", "earth-bump-2k.jpg"];
const WIDTH = 512;
const HEIGHT = 256;

function decodeGrey(file) {
  const [width, height] = execFileSync("magick", ["identify", "-format", "%w %h", file], {
    encoding: "utf8",
  })
    .trim()
    .split(" ")
    .map(Number);
  const grey = execFileSync("magick", [file, "-colorspace", "Gray", "-depth", "8", "gray:-"], {
    maxBuffer: width * height + 1024,
  });
  if (grey.length !== width * height) {
    throw new Error(`${file}: decoded ${grey.length} bytes, expected ${width * height}`);
  }
  return { width, height, grey };
}

const pooled = new Uint8Array(WIDTH * HEIGHT);
for (const name of SOURCES) {
  const { width, height, grey } = decodeGrey(path.join(assets, name));
  if (width % WIDTH !== 0 || height % HEIGHT !== 0) {
    throw new Error(`${name}: ${width}×${height} does not tile into ${WIDTH}×${HEIGHT} blocks`);
  }
  const bx = width / WIDTH;
  const by = height / HEIGHT;
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / by) * WIDTH;
    for (let x = 0; x < width; x++) {
      const i = row + Math.floor(x / bx);
      const g = grey[y * width + x];
      if (g > pooled[i]) pooled[i] = g;
    }
  }
  console.log(`${name}: ${width}×${height}, max grey ${grey.reduce((a, b) => Math.max(a, b), 0)}`);
}

fs.writeFileSync(output, pooled);
console.log(`Wrote ${path.relative(root, output)} (${WIDTH}×${HEIGHT})`);
