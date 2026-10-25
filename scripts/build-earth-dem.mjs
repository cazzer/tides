// Build Earth's 16-bit elevation maps (tides-zmw.1; format: src/earth-dem.ts):
//
// - src/assets/earth-dem-4k.bin: 4096 × 2048, the ground's displacement and
//   relief on the high tier, and the cloud march's ground.
// - src/assets/earth-dem-2k.bin: 2048 × 1024, the same on the low tier: the
//   4k map's 2 × 2 means (its first mip).
// - src/assets/earth-dem-max.bin: 512 × 256, the 4k map's 8 × 8 maxima, so
//   at or above every texel of either map: the terrain floor's source
//   (src/ship/terrain-floor.ts).
// - src/assets/earth-terrain-max.bin: the max map in 8-bit grey levels,
//   rounded up, for scripts/build-cloud-ceiling.mjs (run it next).
//
// Source: Mapterhorn's Terrarium tiles at zoom 4 (512 px lossless WebP,
// Web Mercator; Copernicus GLO-30 and national DEMs; no key), about 2 source
// pixels per texel at the equator and more toward the poles. Each texel is
// the mean of the pixels whose centres fall in it, each clamped to sea level
// first (no bathymetry; the Dead Sea reads 0). A tile that 404s is open
// ocean. Web Mercator stops at 85.05°: north of it is Arctic Ocean (0), and
// south of 85°S the old earth-bump.jpg (8-bit, ~25 m a level) fills the
// polar cap, feathered in over 83–85°S. AWS Terrain Tiles
// (s3.amazonaws.com/elevation-tiles-prod/terrarium, 256 px) are the same
// encoding, if Mapterhorn goes away.
//
// Fetches 256 tiles (~40 MB) once into the cache directory, at most 4 at a
// time; reruns read the cache. Requires ImageMagick (magick) to decode WebP.
// usage: node scripts/build-earth-dem.mjs <cache_dir>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { runnerImport } from "vite";

const root = process.cwd();
const assets = path.join(root, "src", "assets");
const cache = process.argv[2];
if (!cache) {
  console.error("usage: node scripts/build-earth-dem.mjs <cache_dir>");
  process.exit(1);
}

const ZOOM = 4;
const TILES = 2 ** ZOOM;
const TILE = 512;
const SOURCE = TILES * TILE;
const TILE_URL = (x, y) => `https://tiles.mapterhorn.com/${ZOOM}/${x}/${y}.webp`;
const CONCURRENCY = 4;
// The z4 tiles (x/y) Mapterhorn 404s on, open ocean, as of October 2026.
const OCEAN_TILES = new Set(
  "0/0 0/1 0/2 0/11 1/0 1/1 1/2 1/10 1/11 2/0 2/1 2/10 2/11 3/10 3/11 6/5 7/11 8/0 8/11 9/0 9/11 10/0 11/0 12/0 12/10 13/0 13/1 13/10 14/0 14/1 15/0 15/1 15/6".split(" ")
);
const WIDTH = 4096;
const HEIGHT = 2048;
const MAX_POOL = 8;
const MERCATOR_LAT = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;
// The polar cap: the old bump map from FEATHER_TO south, blended in from FEATHER_FROM.
const FEATHER_FROM = -83;
const FEATHER_TO = -85;

// src/earth-dem.ts is TypeScript; Vite (6.1 or later) transforms it for Node.
const { module: dem } = await runnerImport("/src/earth-dem.ts", { configFile: false, logLevel: "error" });

const tilePath = (x, y, ext) => path.join(cache, String(ZOOM), String(x), `${y}.${ext}`);

/** The tile's WebP path, or null for open ocean (a 404), fetching it if not cached. */
async function fetchTile(x, y) {
  const webp = tilePath(x, y, "webp");
  const missing = tilePath(x, y, "404");
  if (fs.existsSync(webp)) return webp;
  if (fs.existsSync(missing)) return null;
  fs.mkdirSync(path.dirname(webp), { recursive: true });
  const response = await fetch(TILE_URL(x, y), { headers: { "User-Agent": "tides build-earth-dem (one-off offline build)" } });
  if (response.status === 404) {
    fs.writeFileSync(missing, "");
    return null;
  }
  if (!response.ok) throw new Error(`${TILE_URL(x, y)}: ${response.status} ${response.statusText}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.subarray(0, 4).toString() !== "RIFF" || body.subarray(8, 12).toString() !== "WEBP") {
    throw new Error(`${TILE_URL(x, y)}: not a WebP`);
  }
  fs.writeFileSync(`${webp}.part`, body);
  fs.renameSync(`${webp}.part`, webp);
  return webp;
}

const jobs = [];
for (let x = 0; x < TILES; x++) for (let y = 0; y < TILES; y++) jobs.push([x, y]);
const tiles = new Map();
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      tiles.set(`${x}/${y}`, await fetchTile(x, y));
    }
  })
);
const ocean = [...tiles].filter(([, file]) => !file).map(([key]) => key);
console.log(`Tiles: ${jobs.length - ocean.length} of ${jobs.length}; open ocean (404): ${ocean.length}`);
// A land tile that 404s (an outage, a bad cache) would silently become sea:
// only these, all open ocean when this map was built, may.
const unexpected = ocean.filter((key) => !OCEAN_TILES.has(key));
const nowLand = [...OCEAN_TILES].filter((key) => tiles.get(key));
if (unexpected.length || nowLand.length) {
  throw new Error(
    `z${ZOOM} tiles differ from OCEAN_TILES: 404 but expected land ${unexpected.join(" ") || "none"}; ` +
      `expected 404 but found ${nowLand.join(" ") || "none"}. Check them, then update OCEAN_TILES.`
  );
}

// Which output texel each source pixel's centre falls in.
const rowOf = new Int32Array(SOURCE);
for (let Y = 0; Y < SOURCE; Y++) {
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (Y + 0.5)) / SOURCE))) * 180) / Math.PI;
  rowOf[Y] = Math.min(HEIGHT - 1, Math.floor(((90 - lat) / 180) * HEIGHT));
}
const columnOf = (X) => Math.floor((X * WIDTH) / SOURCE);

const sum = new Float64Array(WIDTH * HEIGHT);
const count = new Uint32Array(WIDTH * HEIGHT);
for (const [key, file] of tiles) {
  const [tx, ty] = key.split("/").map(Number);
  const rgb = file
    ? execFileSync("magick", [`webp:${file}`, "-depth", "8", "rgb:-"], { maxBuffer: TILE * TILE * 3 + 1024 })
    : null;
  if (rgb && rgb.length !== TILE * TILE * 3) throw new Error(`${file}: decoded ${rgb.length} bytes`);
  for (let py = 0; py < TILE; py++) {
    const row = rowOf[ty * TILE + py] * WIDTH;
    for (let px = 0; px < TILE; px++) {
      const k = row + columnOf(tx * TILE + px);
      if (rgb) {
        const p = 3 * (py * TILE + px);
        const metres = rgb[p] * 256 + rgb[p + 1] + rgb[p + 2] / 256 - 32768;
        sum[k] += Math.max(0, metres);
      }
      count[k]++;
    }
  }
}

// The old bump map, for the polar cap.
const bumpFile = path.join(assets, "earth-bump.jpg");
const bump = execFileSync("magick", [bumpFile, "-colorspace", "Gray", "-depth", "8", "gray:-"], {
  maxBuffer: WIDTH * HEIGHT + 1024,
});
if (bump.length !== WIDTH * HEIGHT) throw new Error(`${bumpFile}: expected ${WIDTH}×${HEIGHT}`);
const bumpMetres = (k) => (bump[k] / 255) * dem.DEM_METRES_PER_UNIT;
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const metres = new Uint16Array(WIDTH * HEIGHT);
let capError = 0;
let capCount = 0;
for (let j = 0; j < HEIGHT; j++) {
  const lat = 90 - ((j + 0.5) / HEIGHT) * 180;
  const cap = smoothstep(FEATHER_FROM, FEATHER_TO, lat);
  for (let i = 0; i < WIDTH; i++) {
    const k = j * WIDTH + i;
    const measured = count[k] ? sum[k] / count[k] : null;
    if (measured === null && lat > -MERCATOR_LAT && lat < MERCATOR_LAT) {
      throw new Error(`No source pixel in texel ${i}, ${j} (lat ${lat.toFixed(3)})`);
    }
    if (lat <= -80 && lat >= FEATHER_TO && measured !== null) {
      capError += Math.abs(bumpMetres(k) - measured);
      capCount++;
    }
    let value;
    if (lat >= 0) value = measured ?? 0;
    else if (measured === null) value = bumpMetres(k);
    else value = measured * (1 - cap) + bumpMetres(k) * cap;
    metres[k] = Math.round(value);
  }
}
console.log(`Old bump map vs the DEM over 80–85°S: mean absolute difference ${(capError / capCount).toFixed(0)} m`);

const full = { width: WIDTH, height: HEIGHT, metres };
const outputs = [
  ["earth-dem-4k.bin", full],
  ["earth-dem-2k.bin", dem.halveDem(full)],
  ["earth-dem-max.bin", dem.maxPoolDem(full, MAX_POOL)],
];
for (const [name, map] of outputs) {
  const file = path.join(assets, name);
  const packed = dem.packEarthDem(map);
  const gz = zlib.gzipSync(packed, { level: 9 });
  fs.writeFileSync(file, gz);
  console.log(
    `Wrote ${path.relative(root, file)}: ${map.width}×${map.height}, ${packed.length} B raw, ${gz.length} B gzip, max ${map.metres.reduce((a, b) => Math.max(a, b), 0)} m`
  );
}

// The cloud ceiling's source stays 8-bit until the cloud layer reads the DEM
// (tides-zmw.1's second step): the max map in grey levels (255 =
// DEM_METRES_PER_UNIT), rounded up, so the ceiling stands over this ground.
const maxMap = outputs[2][1];
const terrainMax = Uint8Array.from(maxMap.metres, (m) => Math.min(255, Math.ceil((m / dem.DEM_METRES_PER_UNIT) * 255)));
const terrainMaxFile = path.join(assets, "earth-terrain-max.bin");
fs.writeFileSync(terrainMaxFile, terrainMax);
console.log(`Wrote ${path.relative(root, terrainMaxFile)}: then run scripts/build-cloud-ceiling.mjs`);

const at = (lat, lon) =>
  metres[Math.min(HEIGHT - 1, Math.floor(((90 - lat) / 180) * HEIGHT)) * WIDTH + Math.min(WIDTH - 1, Math.floor(((lon + 180) / 360) * WIDTH))];
const SPOTS = {
  Everest: [27.988, 86.925],
  K2: [35.881, 76.513],
  Aconcagua: [-32.653, -70.011],
  Altiplano: [-17.5, -67.5],
  "Grand Canyon": [36.1, -112.1],
  "Dead Sea": [31.5, 35.5],
  "Mid-Pacific": [0, -150],
  "South pole": [-89.9, 0],
};
for (const [name, [lat, lon]] of Object.entries(SPOTS)) {
  const m = at(lat, lon);
  console.log(`  ${name.padEnd(13)} ${String(m).padStart(5)} m  (${(m / dem.DEM_METRES_PER_UNIT).toFixed(3)} of the displacement)`);
}
let seam = 0;
for (let j = 0; j < HEIGHT; j++) seam = Math.max(seam, Math.abs(metres[j * WIDTH] - metres[j * WIDTH + WIDTH - 1]));
console.log(`Date line: largest step between the first and last columns ${seam} m`);
