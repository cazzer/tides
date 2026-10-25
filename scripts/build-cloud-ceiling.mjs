// Build src/assets/earth-cloud-ceiling.bin, the cloud ceiling the march from
// inside Earth's cloud shell skips empty steps under (tides-01v.8.10,
// tides-01v.8.22; src/renderers/cloudShaders.ts).
//
// Each byte is cloudCeiling() (src/cloud-layer.ts, the source of truth, whose
// test checks this file against it) of earth-dem-max.bin: 512 × 256 texels,
// rows north to south, columns from longitude −180° east, in grey levels with
// its CEILING_GREY_MARGIN already added. Built here rather than in the
// browser, where it held the main thread ~14 ms as the ship neared Earth.
//
// Run scripts/build-earth-dem.mjs first when the elevation map changes.
// usage: node scripts/build-cloud-ceiling.mjs

import fs from "node:fs";
import path from "node:path";
import { runnerImport } from "vite";

const root = process.cwd();
const assets = path.join(root, "src", "assets");
const input = path.join(assets, "earth-dem-max.bin");
const output = path.join(assets, "earth-cloud-ceiling.bin");
const WIDTH = 512;
const HEIGHT = 256;

// cloud-layer.ts and earth-dem.ts are TypeScript; Vite (6.1 or later) transforms them for Node.
const options = { configFile: false, logLevel: "error" };
const [{ module: layer }, { module: dem }] = await Promise.all([
  runnerImport("/src/cloud-layer.ts", options),
  runnerImport("/src/earth-dem.ts", options),
]);
const pooled = dem.demLevel(await dem.decodeEarthDem(fs.readFileSync(input)));
if (pooled.width !== WIDTH || pooled.height !== HEIGHT) {
  throw new Error(`${path.relative(root, input)}: ${pooled.width}×${pooled.height}, expected ${WIDTH}×${HEIGHT}`);
}
const ceiling = layer.cloudCeiling(pooled.data, WIDTH, HEIGHT);
fs.writeFileSync(output, ceiling);
console.log(`Wrote ${path.relative(root, output)} (${WIDTH}×${HEIGHT})`);
