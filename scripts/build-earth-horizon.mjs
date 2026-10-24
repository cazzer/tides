// Build Earth's horizon map (tides-zmw.4; format: src/earth-horizon.ts):
// src/assets/earth-horizon-1k.bin, 1024 × 512 × 8 directions at 6 bits, for
// the ground's soft Sun shadows and sky occlusion (src/renderers/groundShadow.ts).
//
// Source: src/assets/earth-dem-4k.bin (scripts/build-earth-dem.mjs; run that
// first), box-filtered to 1024 × 512 (its second mip down, as the GPU's own
// mips would be). The angles are at the ground's exaggeration,
// TERRAIN_DISPLACEMENT over Earth's scene radius; the shader rescales them
// if that changes, so only a new DEM needs a rebuild. Deterministic, ~seconds.
// usage: node scripts/build-earth-horizon.mjs

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { runnerImport } from "vite";

const root = process.cwd();
const assets = path.join(root, "src", "assets");

// TypeScript sources; Vite (6.1 or later) transforms them for Node.
const load = async (file) => (await runnerImport(file, { configFile: false, logLevel: "error" })).module;
const dem = await load("/src/earth-dem.ts");
const horizon = await load("/src/earth-horizon.ts");
const { TERRAIN_DISPLACEMENT } = await load("/src/cloud-layer.ts");
const { sceneRadius } = await load("/src/planets.ts");

// The ground sphere's radius in scene units (solar-system.tsx EARTH_DIAMETER,
// which the renderer uses as a radius).
const eRef = TERRAIN_DISPLACEMENT / sceneRadius(12742000);

const source = await dem.decodeEarthDem(fs.readFileSync(path.join(assets, "earth-dem-4k.bin")));
const level = dem.boxMips(dem.demLevel(source)).find((l) => l.width === horizon.HORIZON_WIDTH);
const start = performance.now();
const map = horizon.bakeHorizon(level, { eRef });
const seconds = (performance.now() - start) / 1000;

const file = path.join(assets, "earth-horizon-1k.bin");
const packed = horizon.packEarthHorizon(map);
const gz = zlib.gzipSync(packed, { level: 9 });
fs.writeFileSync(file, gz);
console.log(
  `Wrote ${path.relative(root, file)}: ${map.width}×${map.height}×${map.directions} at ${map.bits} bits, eRef ${eRef.toFixed(5)}, ` +
    `${packed.length} B raw, ${gz.length} B gzip, baked in ${seconds.toFixed(1)} s`
);

const deg = (radians) => ((radians * 180) / Math.PI).toFixed(0).padStart(3);
const texel = (lat, lon) => [
  Math.min(map.width - 1, Math.floor(((lon + 180) / 360) * map.width)),
  Math.min(map.height - 1, Math.floor(((90 - lat) / 180) * map.height)),
];
const SPOTS = {
  Mendoza: [-32.89, -68.83],
  Santiago: [-33.45, -70.67],
  Kathmandu: [27.72, 85.32],
  Patna: [25.6, 85.1],
  "Grand Canyon": [36.1, -112.1],
  "Mid-Pacific": [0, -150],
};
console.log("  horizon N NE E SE S SW W NW (degrees), sky visibility");
for (const [name, [lat, lon]] of Object.entries(SPOTS)) {
  const angles = horizon.horizonAt(map, ...texel(lat, lon));
  console.log(`  ${name.padEnd(13)} ${angles.map(deg).join(" ")}   ${horizon.skyVisibility(angles, 1).toFixed(2)}`);
}
let seam = 0;
const n = map.width * map.height;
for (let d = 0; d < map.directions; d++) {
  for (let y = 0; y < map.height; y++) {
    const row = d * n + y * map.width;
    seam = Math.max(seam, Math.abs(map.angles[row] - map.angles[row + map.width - 1]));
  }
}
console.log(`Date line: largest step between the first and last columns ${seam} levels`);
