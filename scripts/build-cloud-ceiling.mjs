// Build src/assets/earth-cloud-ceiling.bin, the cloud ceiling the march from
// inside Earth's cloud shell skips empty steps under (tides-01v.8.10,
// tides-01v.8.22; src/renderers/cloudShaders.ts).
//
// Each byte is cloudCeiling() (src/cloud-layer.ts, the source of truth, whose
// test checks this file against it) of earth-terrain-max.bin: 512 × 256
// texels, rows north to south, columns from longitude −180° east, with its
// CEILING_GREY_MARGIN already added. Built here rather than in the browser,
// where it held the main thread ~14 ms as the ship neared Earth.
//
// Run scripts/build-earth-dem.mjs first when the elevation map changes.
// usage: node scripts/build-cloud-ceiling.mjs

import fs from "node:fs";
import path from "node:path";
import { runnerImport } from "vite";

const root = process.cwd();
const assets = path.join(root, "src", "assets");
const input = path.join(assets, "earth-terrain-max.bin");
const output = path.join(assets, "earth-cloud-ceiling.bin");
const WIDTH = 512;
const HEIGHT = 256;

const pooled = new Uint8Array(fs.readFileSync(input));
if (pooled.length !== WIDTH * HEIGHT) {
  throw new Error(`${path.relative(root, input)}: ${pooled.length} bytes, expected ${WIDTH * HEIGHT}`);
}

// cloud-layer.ts is TypeScript; Vite (6.1 or later) transforms it for Node.
const { module } = await runnerImport("/src/cloud-layer.ts", { configFile: false, logLevel: "error" });
const ceiling = module.cloudCeiling(pooled, WIDTH, HEIGHT);
fs.writeFileSync(output, ceiling);
console.log(`Wrote ${path.relative(root, output)} (${WIDTH}×${HEIGHT})`);
