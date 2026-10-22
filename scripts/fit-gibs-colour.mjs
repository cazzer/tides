// Fit src/assets/gibs-colour-lut.bin, the recolour from NASA GIBS's Blue
// Marble Next Generation to earth-day.jpg's grading (tides-01v.15;
// src/renderers/gibsPatch.ts). The two are graded differently (open ocean
// 2,5,20 against ~25,75,101 sRGB; dark forest 26,41,12 against ~84,88,39),
// so without it the patch's coastlines step by under half the day map's.
//
// Source: the whole globe of Blue Marble at level 4 of GIBS's EPSG:4326
// "500m" matrix (20x10 tiles of 18 deg, 10240 px around), and earth-day.jpg,
// both box-filtered to GRID x GRID/2. Only pure samples are fitted: where
// either map spreads more than PURE over 3x3 the pixel mixes land and water
// (or the maps disagree on where the coast is), and a lookup that learned
// "half-water -> half-land" would fold the water ramps back on themselves.
// Latitudes past 70 deg are left out: the patch fades out there
// (poleSmoothing.ts), and the ice caps differ in extent.
//
// The LUT is SIDE^3 RGB8 entries in sRGB, red fastest, then green, then blue
// (a Data3DTexture's layout). Its axes are warped, entry k at
// 255 * (k / (SIDE - 1))^2 of each channel, because Blue Marble keeps the
// ocean, lakes and forests in the bottom tenth of the range; a lookup takes
// sqrt(colour) as its coordinate. The entries are a least-squares fit of the
// trilinear lookup (Jacobi-preconditioned CG), with a Laplacian on the gain
// between neighbouring entries that fills the colours Blue Marble never uses
// and keeps the dark ones from swinging on a level of JPEG noise; more of it
// flattens the land/water step the fit exists for (SMOOTH 4 takes dark forest
// to a blue-grey). It is refit twice with Huber weights, HUBER above the
// median residual so only outliers (cloud, ice, regional regrading) lose
// weight.
//
// The shipped LUT is fitted on every sample; a second fit, on half the
// tiles, is scored on the other half (a checkerboard) to check it generalises.
// The script then prints three ramps the patch's detail moves along and the
// gain at a few colours. Tiles are cached in the directory given (fetched
// once, ~5 MB). GRID, PURE, SMOOTH and HUBER can be overridden from the
// environment to explore a refit.
//
// As committed (sRGB levels, of the rounded LUT; level-4 tiles fetched
// 2026-10-22, GRID 5120, PURE 12, SMOOTH 1, HUBER 24; 7.1M of 10.2M samples
// pure):
//   all samples, shipped fit: RMS r/g/b 7.6/11.4/13.1 (unmapped 23.1/65.9/76.2), median 14.1, p90 27.0
//   held-out tiles:           RMS r/g/b 8.2/11.6/13.4 (unmapped 23.4/65.9/76.2), median 14.3, p90 26.9
//   gain (output per input level): open ocean 1.7, lake 2.3, dark forest 0.8, desert 1.5
// The ramps dip by at most ~12 levels of luma (lake to open ocean, which the
// day map also shades apart) and none folds back past its start. What
// remains is mostly regional: the day map greens a forest Blue Marble shows
// tan, and its warp (~3 day-map texels around the Great Lakes, under one
// elsewhere; tides-01v.20) moves coasts no colour fit can, which is why the
// patch still adds only its high frequencies.
//
// Requires ImageMagick (magick) to decode the JPEGs.
// usage: node scripts/fit-gibs-colour.mjs <tile-cache-dir>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src", "assets", "gibs-colour-lut.bin");
const dayMap = path.join(root, "src", "assets", "earth-day.jpg");
const cache = process.argv[2];
if (!cache) throw new Error("usage: node scripts/fit-gibs-colour.mjs <tile-cache-dir>");

const LEVEL = 4;
const COLS = 20;
const ROWS = 10;
const GRID = Number(process.env.GRID ?? 5120);
const MAX_LAT = 70;
const SIDE = 17;
/** Largest 3x3 spread (sRGB levels, summed over channels) a sample may have
 * in either map: past it, the sample mixes land and water. */
const PURE = Number(process.env.PURE ?? 12);
const SMOOTH = Number(process.env.SMOOTH ?? 1);
const HUBER = Number(process.env.HUBER ?? 24);
const tileUrl = (row, col) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/${LEVEL}/${row}/${col}.jpeg`;

async function fetchTiles() {
  fs.mkdirSync(cache, { recursive: true });
  const wanted = [];
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) wanted.push([row, col]);
  const missing = wanted.filter(([row, col]) => !fs.existsSync(path.join(cache, `${row}-${col}.jpeg`)));
  while (missing.length) {
    await Promise.all(
      missing.splice(0, 8).map(async ([row, col]) => {
        const response = await fetch(tileUrl(row, col));
        if (!response.ok) throw new Error(`${tileUrl(row, col)}: HTTP ${response.status}`);
        fs.writeFileSync(path.join(cache, `${row}-${col}.jpeg`), Buffer.from(await response.arrayBuffer()));
      }),
    );
  }
}

function decode(file, width, height) {
  const rgb = execFileSync(
    "magick",
    [file, "-filter", "Box", "-resize", `${width}x${height}!`, "-depth", "8", "rgb:-"],
    { maxBuffer: width * height * 3 + 1024 },
  );
  if (rgb.length !== width * height * 3) throw new Error(`${file}: decoded ${rgb.length} bytes`);
  return rgb;
}

await fetchTiles();
const H = GRID / 2;
const tilePx = GRID / COLS;
const marble = new Uint8Array(GRID * H * 3);
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const px = decode(path.join(cache, `${row}-${col}.jpeg`), tilePx, tilePx);
    for (let y = 0; y < tilePx; y++) {
      marble.set(px.subarray(y * tilePx * 3, (y + 1) * tilePx * 3), ((row * tilePx + y) * GRID + col * tilePx) * 3);
    }
  }
}
const day = decode(dayMap, GRID, H);

// The 3x3 spread at pixel (x, y): the largest channel-summed distance of a
// neighbour from the centre.
function spread(rgb, x, y) {
  const i = (y * GRID + x) * 3;
  let most = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const j = (y + dy) * GRID + ((x + dx + GRID) % GRID);
      const d = Math.abs(rgb[j * 3] - rgb[i]) + Math.abs(rgb[j * 3 + 1] - rgb[i + 1]) + Math.abs(rgb[j * 3 + 2] - rgb[i + 2]);
      if (d > most) most = d;
    }
  }
  return most;
}

// Samples (byte offsets), and whether each one's tile is held out (a checkerboard).
const sampleAt = [];
const heldAt = [];
let considered = 0;
for (let y = 1; y < H - 1; y++) {
  if (Math.abs(90 - ((y + 0.5) / H) * 180) > MAX_LAT) continue;
  for (let x = 0; x < GRID; x++) {
    considered++;
    if (spread(marble, x, y) > PURE || spread(day, x, y) > PURE) continue;
    sampleAt.push((y * GRID + x) * 3);
    heldAt.push((Math.floor(y / tilePx) + Math.floor(x / tilePx)) % 2);
  }
}
const samples = Int32Array.from(sampleAt);
const held = Uint8Array.from(heldAt);

// The trilinear lookup's 8 corners and weights for the Blue Marble colour at
// byte `i` of `rgb`.
const N = SIDE * SIDE * SIDE;
const corners = new Int32Array(8);
const weights = new Float64Array(8);
function lookupAt(rgb, i) {
  const lo = [];
  const t = [];
  for (let c = 0; c < 3; c++) {
    const s = Math.sqrt(rgb[i + c] / 255) * (SIDE - 1);
    const k = Math.min(SIDE - 2, Math.floor(s));
    lo.push(k);
    t.push(s - k);
  }
  for (let n = 0; n < 8; n++) {
    const dr = n & 1;
    const dg = (n >> 1) & 1;
    const db = (n >> 2) & 1;
    corners[n] = lo[0] + dr + SIDE * (lo[1] + dg + SIDE * (lo[2] + db));
    weights[n] = (dr ? t[0] : 1 - t[0]) * (dg ? t[1] : 1 - t[1]) * (db ? t[2] : 1 - t[2]);
  }
}
function apply(lut, rgb, i, c) {
  lookupAt(rgb, i);
  let v = 0;
  for (let n = 0; n < 8; n++) v += weights[n] * lut[corners[n] * 3 + c];
  return v;
}

// The sparse normal matrix keeps, for each entry, its 27 neighbours.
const offset = (dr, dg, db) => dr + SIDE * (dg + SIDE * db);
const slot = (dr, dg, db) => dr + 1 + 3 * (dg + 1) + 9 * (db + 1);
const NEIGHBOURS = [];
for (let db = -1; db <= 1; db++) for (let dg = -1; dg <= 1; dg++) for (let dr = -1; dr <= 1; dr++) NEIGHBOURS.push(offset(dr, dg, db));
// The slot of corner q seen from corner p of a cell.
const CORNER_SLOT = new Int32Array(64);
for (let p = 0; p < 8; p++) {
  for (let q = 0; q < 8; q++) {
    CORNER_SLOT[p * 8 + q] = slot((q & 1) - (p & 1), ((q >> 1) & 1) - ((p >> 1) & 1), ((q >> 2) & 1) - ((p >> 2) & 1));
  }
}
// The smoothing pulls neighbouring entries together in proportion to the
// gain between them, so it is uniform in colour rather than in entries
// (the dark entries, a level or two apart, would otherwise be free to swing).
const spacing = (k) => (255 * (2 * k + 1)) / (SIDE - 1) ** 2;

function fitChannel(c, fitted, weight) {
  const M = new Float64Array(N * 27);
  const b = new Float64Array(N);
  let total = 0;
  for (let n = 0; n < fitted.length; n++) {
    const i = samples[fitted[n]];
    const w = weight[n];
    total += w;
    lookupAt(marble, i);
    const d = day[i + c];
    for (let p = 0; p < 8; p++) {
      const wp = w * weights[p];
      b[corners[p]] += wp * d;
      const row = corners[p] * 27;
      for (let q = 0; q < 8; q++) M[row + CORNER_SLOT[p * 8 + q]] += wp * weights[q];
    }
  }
  // In units of the data's total weight, so it means the same at any GRID.
  const smooth = (SMOOTH * total) / N / 1000;
  for (let k = 0; k < N; k++) {
    const at = [k % SIDE, Math.floor(k / SIDE) % SIDE, Math.floor(k / SIDE / SIDE)];
    for (let axis = 0; axis < 3; axis++) {
      if (at[axis] + 1 >= SIDE) continue;
      const step = [0, 0, 0];
      step[axis] = 1;
      const j = k + offset(...step);
      const s = smooth * (255 / spacing(at[axis])) ** 2;
      M[k * 27 + slot(0, 0, 0)] += s;
      M[j * 27 + slot(0, 0, 0)] += s;
      M[k * 27 + slot(...step)] -= s;
      M[j * 27 + slot(...step.map((v) => -v))] -= s;
    }
  }
  const multiply = (x, out) => {
    for (let k = 0; k < N; k++) {
      let v = 0;
      for (let n = 0; n < 27; n++) {
        const m = M[k * 27 + n];
        if (m !== 0) v += m * x[k + NEIGHBOURS[n]];
      }
      out[k] = v;
    }
  };
  // Jacobi-preconditioned conjugate gradients, from the identity.
  const x = new Float64Array(N);
  for (let k = 0; k < N; k++) x[k] = 255 * (([k % SIDE, Math.floor(k / SIDE) % SIDE, Math.floor(k / SIDE / SIDE)][c] / (SIDE - 1)) ** 2);
  const inverseDiagonal = new Float64Array(N);
  for (let k = 0; k < N; k++) inverseDiagonal[k] = 1 / M[k * 27 + slot(0, 0, 0)];
  const r = new Float64Array(N);
  const z = new Float64Array(N);
  const Ap = new Float64Array(N);
  const dot = (u, v) => u.reduce((a, value, k) => a + value * v[k], 0);
  multiply(x, Ap);
  for (let k = 0; k < N; k++) r[k] = b[k] - Ap[k];
  for (let k = 0; k < N; k++) z[k] = r[k] * inverseDiagonal[k];
  const p = Float64Array.from(z);
  const bb = dot(b, b);
  let rz = dot(r, z);
  let it = 0;
  for (; it < 5000 && dot(r, r) > 1e-16 * bb; it++) {
    multiply(p, Ap);
    const alpha = rz / dot(p, Ap);
    for (let k = 0; k < N; k++) {
      x[k] += alpha * p[k];
      r[k] -= alpha * Ap[k];
      z[k] = r[k] * inverseDiagonal[k];
    }
    const next = dot(r, z);
    for (let k = 0; k < N; k++) p[k] = z[k] + (next / rz) * p[k];
    rz = next;
  }
  const relative = Math.sqrt(dot(r, r) / bb);
  if (relative > 1e-6) throw new Error(`channel ${c}: CG stopped at relative residual ${relative.toExponential(1)}`);
  return x;
}

// The rounded LUT fitted to the samples `fitted` indexes, refit twice with
// Huber weights.
function fitLut(fitted) {
  const lut = new Float64Array(N * 3);
  const weight = new Float64Array(fitted.length).fill(1);
  for (let pass = 0; pass < 3; pass++) {
    if (pass > 0) {
      fitted.forEach((n, m) => {
        const i = samples[n];
        const e = Math.hypot(...[0, 1, 2].map((c) => apply(lut, marble, i, c) - day[i + c]));
        weight[m] = e <= HUBER ? 1 : HUBER / e;
      });
    }
    for (let c = 0; c < 3; c++) {
      const x = fitChannel(c, fitted, weight);
      for (let k = 0; k < N; k++) lut[k * 3 + c] = x[k];
    }
  }
  return Uint8Array.from(lut, (v) => Math.max(0, Math.min(255, Math.round(v))));
}

// Fit error, in sRGB levels, of a rounded LUT on the samples `scored` indexes.
function report(name, bytes, scored) {
  const sq = [0, 0, 0];
  const before = [0, 0, 0];
  const errors = new Float64Array(scored.length);
  scored.forEach((n, m) => {
    const i = samples[n];
    let e2 = 0;
    for (let c = 0; c < 3; c++) {
      const e = apply(bytes, marble, i, c) - day[i + c];
      sq[c] += e * e;
      before[c] += (marble[i + c] - day[i + c]) ** 2;
      e2 += e * e;
    }
    errors[m] = Math.sqrt(e2);
  });
  errors.sort();
  const n = scored.length;
  const rms = (a) => a.map((v) => Math.sqrt(v / n).toFixed(1)).join("/");
  console.log(
    `${name}: ${n} samples, RMS r/g/b ${rms(sq)} (unmapped ${rms(before)}), median ${errors[n >> 1].toFixed(1)}, p90 ${errors[Math.floor(n * 0.9)].toFixed(1)}`,
  );
}

const all = samples.map((_, n) => n);
console.log(`${samples.length} of ${considered} samples pure enough to fit`);
const validation = fitLut(all.filter((n) => !held[n]));
report("held-out tiles", validation, all.filter((n) => held[n]));
const bytes = fitLut(all);
report("all samples, shipped fit", bytes, all);
fs.writeFileSync(output, bytes);

// The ramps the patch's detail moves along, which must not fold back, and
// the gain there (output levels per input level).
const look = (colour) => [0, 1, 2].map((c) => apply(bytes, colour, 0, c));
const ramp = (name, from, to, steps = 12) => {
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = (s / steps) ** 2;
    out.push(look(from.map((v, c) => v + (to[c] - v) * t)));
  }
  const luma = out.map(([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b);
  const folds = luma.slice(1).filter((v, s) => v < luma[s] - 0.5).length;
  console.log(`  ${name}: ${out.map((o) => o.map(Math.round).join(",")).join(" -> ")}${folds ? `  (${folds} folds)` : ""}`);
};
ramp("deep water to shelf", [0, 2, 7], [40, 110, 130]);
ramp("ocean to forest", [2, 5, 20], [26, 41, 12]);
ramp("grey", [0, 0, 0], [60, 60, 60]);
for (const [name, colour] of [
  ["open ocean", [2, 5, 20]],
  ["lake", [0, 2, 7]],
  ["dark forest", [26, 41, 12]],
  ["desert", [201, 171, 121]],
]) {
  const at = look(colour);
  const gain = Math.max(
    ...[0, 1, 2].map((c) => {
      const up = colour.map((v, k) => v + (k === c ? 1 : 0));
      return Math.hypot(...look(up).map((v, k) => v - at[k]));
    }),
  );
  console.log(`  ${name} ${colour.join(",")} -> ${at.map(Math.round).join(",")}, gain ${gain.toFixed(1)}`);
}
console.log(`Wrote ${path.relative(root, output)} (${SIDE}^3 RGB, ${bytes.length} bytes)`);
