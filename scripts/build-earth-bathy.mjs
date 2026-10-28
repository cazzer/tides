// Build the sea's depth maps under the water's body (tides-d9f.6; format and
// model: src/renderers/waterDepth.ts):
//
// - src/assets/earth-bathy-4k.png: 4096 × 2048, the high tier's.
// - src/assets/earth-bathy-2k.png: 2048 × 1024, the low tier's: the 4k
//   map's 2 × 2 means, in metres, then encoded.
//
// Source: NOAA NCEI's ETOPO 2022, the 60 arc-second global relief model
// (ETOPO_2022_v1_60s_N90W180_surface.tif, 21600 × 10800 32-bit float
// metres, cell centred; a US Government work, public domain:
// https://www.ncei.noaa.gov/products/etopo-global-relief-model). The
// surface model, not the bedrock one: under the Antarctic and Greenland ice
// shelves the surface is the ice, not the sea floor a kilometre down, so the
// shelves don't read as deep water. Nothing at runtime reads ETOPO; it is
// never committed (~470 MB).
//
// The grid is the elevation map's (scripts/build-earth-dem.mjs, run it
// first): rows north to south, columns from longitude −180° east, each
// texel the mean depth of the ETOPO cells under the sea whose centres fall
// in it (the land's cells left out, so a coast texel mostly land reads the
// sea off it, not a few metres; none under the sea, 0 m). Wet or dry is the shipped elevation map's call, not ETOPO's,
// so the two agree texel for texel: a texel above 0 m there is dry (land,
// and the lakes above sea level, the Great Lakes among them). The Caspian,
// whose surface (−28 m) that map clamps to 0, is wet, and takes ETOPO's
// depth of its bed below sea level, 28 m more than the lake's own: it has
// shelves and a deep south basin as a sea does. Dry texels take the mean of
// their filled 8 neighbours (columns wrapping), FILL_PASSES times, so the
// coast the coarser water mask draws a texel off still has its sea's depth;
// the rest take WATER_DEPTH_NEUTRAL, whose floor is the open ocean's.
// Encoded with encodeWaterDepth (sqrt, 8 bits), lossless grey PNG.
//
// Converts the GeoTIFF once to raw float32 in the scratch directory
// (~930 MB); reruns read it. Requires ImageMagick (magick).
// usage: node scripts/build-earth-bathy.mjs <etopo_tif> <scratch_dir>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { runnerImport } from "vite";

const root = process.cwd();
const assets = path.join(root, "src", "assets");
const [tif, scratch] = process.argv.slice(2);
if (!tif || !scratch) {
  console.error("usage: node scripts/build-earth-bathy.mjs <etopo_tif> <scratch_dir>");
  process.exit(1);
}

const SOURCE_W = 21600;
const SOURCE_H = 10800;
const WIDTH = 4096;
const HEIGHT = 2048;
const FILL_PASSES = 3;
const PNG_BUDGET = 2.5e6;

// TypeScript; Vite (6.1 or later) transforms them for Node.
const options = { configFile: false, logLevel: "error" };
const [{ module: dem }, { module: depth }] = await Promise.all([
  runnerImport("/src/earth-dem.ts", options),
  runnerImport("/src/renderers/waterDepth.ts", options),
]);

// The GeoTIFF as raw little-endian float32 metres. ImageMagick's Q16-HDRI
// build keeps the floats as they are with quantum:format=floating-point;
// the spot checks below fail loudly if a build ever scales them.
fs.mkdirSync(scratch, { recursive: true });
const raw = path.join(scratch, "etopo.f32");
const RAW_BYTES = SOURCE_W * SOURCE_H * 4;
if (!fs.existsSync(raw) || fs.statSync(raw).size !== RAW_BYTES) {
  console.log(`Converting ${tif} to ${raw}`);
  execFileSync("magick", ["-limit", "memory", "2GiB", tif, "-define", "quantum:format=floating-point", "-depth", "32", "-endian", "LSB", `gray:${raw}.part`], {
    stdio: "inherit",
  });
  fs.renameSync(`${raw}.part`, raw);
}
if (fs.statSync(raw).size !== RAW_BYTES) throw new Error(`${raw}: expected ${RAW_BYTES} B`);
const fd = fs.openSync(raw, "r");

const sourceAt = (lat, lon) => {
  const r = Math.min(SOURCE_H - 1, Math.floor((90 - lat) * 60));
  const c = Math.min(SOURCE_W - 1, Math.floor((lon + 180) * 60));
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, (r * SOURCE_W + c) * 4);
  return b.readFloatLE(0);
};
const RAW_CHECKS = [
  ["Challenger Deep", 11.35, 142.2, (m) => m < -9500],
  ["Everest", 27.988, 86.925, (m) => m > 7000],
  ["Mid-Pacific", 0, -150, (m) => m >= -6000 && m <= -3500],
];
for (const [name, lat, lon, ok] of RAW_CHECKS) {
  const m = sourceAt(lat, lon);
  console.log(`  ETOPO ${name.padEnd(15)} ${m.toFixed(0).padStart(6)} m`);
  if (!ok(m)) throw new Error(`${raw}: ${name} reads ${m} m: the float data was scaled or misread`);
}

// Each ETOPO cell's centre to its texel.
const columnOf = new Int32Array(SOURCE_W);
for (let c = 0; c < SOURCE_W; c++) columnOf[c] = Math.floor(((c + 0.5) * WIDTH) / SOURCE_W);
const rowOf = (r) => Math.floor(((r + 0.5) * HEIGHT) / SOURCE_H);

const sum = new Float64Array(WIDTH * HEIGHT);
const count = new Uint32Array(WIDTH * HEIGHT);
const seaCount = new Uint32Array(WIDTH * HEIGHT);
const BLOCK = 200;
const buffer = Buffer.alloc(BLOCK * SOURCE_W * 4);
for (let r0 = 0; r0 < SOURCE_H; r0 += BLOCK) {
  const rows = Math.min(BLOCK, SOURCE_H - r0);
  const bytes = rows * SOURCE_W * 4;
  if (fs.readSync(fd, buffer, 0, bytes, r0 * SOURCE_W * 4) !== bytes) throw new Error(`${raw}: short read at row ${r0}`);
  const values = new Float32Array(buffer.buffer, buffer.byteOffset, rows * SOURCE_W);
  for (let i = 0; i < rows; i++) {
    const row = rowOf(r0 + i) * WIDTH;
    for (let c = 0; c < SOURCE_W; c++) {
      const k = row + columnOf[c];
      const elevationHere = values[i * SOURCE_W + c];
      count[k]++;
      if (elevationHere < 0) {
        sum[k] -= elevationHere;
        seaCount[k]++;
      }
    }
  }
}
fs.closeSync(fd);

// Wet or dry from the shipped elevation map.
const demFile = path.join(assets, "earth-dem-4k.bin");
const elevation = dem.unpackEarthDem(zlib.gunzipSync(fs.readFileSync(demFile)));
if (elevation.width !== WIDTH || elevation.height !== HEIGHT) {
  throw new Error(`${path.relative(root, demFile)}: ${elevation.width}×${elevation.height}, expected ${WIDTH}×${HEIGHT}`);
}

let metres = new Float64Array(WIDTH * HEIGHT);
let filled = new Uint8Array(WIDTH * HEIGHT);
let wet = 0;
for (let k = 0; k < WIDTH * HEIGHT; k++) {
  if (!count[k]) throw new Error(`No ETOPO cell in texel ${k % WIDTH}, ${Math.floor(k / WIDTH)}`);
  if (elevation.metres[k] > 0) continue;
  metres[k] = seaCount[k] ? sum[k] / seaCount[k] : 0;
  filled[k] = 1;
  wet++;
}

// Dry texels beside the sea take their filled neighbours' mean.
const dilated = [];
for (let pass = 0; pass < FILL_PASSES; pass++) {
  const nextMetres = metres.slice();
  const nextFilled = filled.slice();
  let n = 0;
  for (let j = 0; j < HEIGHT; j++) {
    for (let i = 0; i < WIDTH; i++) {
      const k = j * WIDTH + i;
      if (filled[k]) continue;
      let s = 0;
      let c = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const y = j + dj;
        if (y < 0 || y >= HEIGHT) continue;
        for (let di = -1; di <= 1; di++) {
          const q = y * WIDTH + ((i + di + WIDTH) % WIDTH);
          if (filled[q]) {
            s += metres[q];
            c++;
          }
        }
      }
      if (c) {
        nextMetres[k] = s / c;
        nextFilled[k] = 1;
        n++;
      }
    }
  }
  metres = nextMetres;
  filled = nextFilled;
  dilated.push(n);
}
let neutral = 0;
for (let k = 0; k < WIDTH * HEIGHT; k++) {
  if (filled[k]) continue;
  metres[k] = depth.WATER_DEPTH_NEUTRAL;
  neutral++;
}
console.log(`Texels: ${WIDTH * HEIGHT}; wet ${wet}; filled from the sea ${dilated.join(" + ")}; neutral ${neutral}`);

const encode = (m) => {
  const out = new Uint8Array(m.length);
  for (let k = 0; k < m.length; k++) out[k] = depth.encodeWaterDepth(m[k]);
  return out;
};
const half = new Float64Array((WIDTH / 2) * (HEIGHT / 2));
for (let j = 0; j < HEIGHT / 2; j++) {
  for (let i = 0; i < WIDTH / 2; i++) {
    const k = 2 * j * WIDTH + 2 * i;
    half[j * (WIDTH / 2) + i] = (metres[k] + metres[k + 1] + metres[k + WIDTH] + metres[k + WIDTH + 1]) / 4;
  }
}

const outputs = [
  ["earth-bathy-4k.png", WIDTH, HEIGHT, encode(metres)],
  ["earth-bathy-2k.png", WIDTH / 2, HEIGHT / 2, encode(half)],
];
for (const [name, w, h, levels] of outputs) {
  const file = path.join(assets, name);
  const grey = path.join(scratch, `${name}.gray`);
  fs.writeFileSync(grey, levels);
  execFileSync("magick", [
    "-size", `${w}x${h}`, "-depth", "8", `gray:${grey}`,
    "-strip",
    "-define", "png:color-type=0",
    "-define", "png:bit-depth=8",
    "-define", "png:compression-level=9",
    "-define", "png:exclude-chunks=date,time,gAMA,cHRM,bKGD,sRGB,iCCP",
    `png:${file}`,
  ]);
  const back = execFileSync("magick", [file, "-depth", "8", "gray:-"], { maxBuffer: w * h + 1024 });
  if (!back.equals(Buffer.from(levels))) throw new Error(`${file}: decodes differently from what was written`);
  const bytes = fs.statSync(file).size;
  console.log(`Wrote ${path.relative(root, file)}: ${w}×${h}, ${bytes} B${bytes > PNG_BUDGET ? " (over the budget)" : ""}`);
  // Over the sea on both sides; a dry texel's fill can stop a column short
  // of the date line on one side (Chukotka), which no water shows.
  const wetAt = (j, i) => w === WIDTH ? elevation.metres[j * WIDTH + i] <= 0 : true;
  let seam = 0;
  let seamWet = 0;
  for (let j = 0; j < h; j++) {
    const step = Math.abs(levels[j * w] - levels[j * w + w - 1]);
    seam = Math.max(seam, step);
    if (wetAt(j, 0) && wetAt(j, w - 1)) seamWet = Math.max(seamWet, step);
  }
  console.log(`  Date line: largest step between the first and last columns ${seam} levels${w === WIDTH ? `, ${seamWet} where both are wet` : ""}`);
}

const [, , , levels4k] = outputs[0];
const at = (lat, lon) =>
  levels4k[Math.min(HEIGHT - 1, Math.floor(((90 - lat) / 180) * HEIGHT)) * WIDTH + Math.min(WIDTH - 1, Math.floor(((lon + 180) / 360) * WIDTH))];
const SPOTS = {
  "Challenger Deep": [11.35, 142.2],
  "Puerto Rico Trench": [19.7, -66.5],
  "Great Bahama Bank": [24.0, -77.8],
  "North Sea": [56, 3],
  "Grand Banks": [45, -51],
  "Mid-Pacific": [0, -150],
  "North Pole": [89.9, 0],
  "Lake Superior": [47.7, -87.5],
  Caspian: [42, 50],
};
for (const [name, [lat, lon]] of Object.entries(SPOTS)) {
  const level = at(lat, lon);
  console.log(`  ${name.padEnd(18)} ${String(level).padStart(3)}  ${depth.decodeWaterDepth(level).toFixed(0).padStart(5)} m`);
}
