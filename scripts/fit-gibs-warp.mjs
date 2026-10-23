// Fit src/assets/gibs-warp.bin, where the GIBS patch samples Blue Marble so
// its coasts land on earth-day.jpg's (tides-01v.20; src/renderers/gibsPatch.ts).
// The day map is warped against Blue Marble Next Generation by up to ~4 of
// its texels (~15 km) around the Great Lakes, and under one along most sea
// coasts, so there the patch's sharp shores sat beside the day map's blurred
// ones: a double shoreline that no recolour can fix.
//
// Source: the whole globe of Blue Marble at level 4 of GIBS's EPSG:4326
// "500m" matrix (20x10 tiles, the colour fit's cache), recoloured through
// gibs-colour-lut.bin, resampled to earth-day.jpg's 10800x5400, and the red
// channel of both (land against water, in either map), blurred by SIGMA, with
// blue less red to tell water (WATER and over) from land.
//
// What matters is where the coasts sit, so the data are coast pixels, not
// blocks of imagery (which also match shelves, shading and the maps' own
// colour, and gave Yucatan's north coast a 2.5 texel shift it doesn't have).
// A Blue Marble pixel is a coast pixel where its gradient peaks across it,
// red steps by EDGE_STEP or more over +-4 texels, and that step is from water
// to land (rivers' and deserts' edges, ice and forest, aren't coasts the two
// maps share). Along that normal n, the steepest same-way step of the day map
// within +-REACH texels is its coast, and the distance between the two (to a
// quarter texel, refined) is the shift across the coast, n.d, with the day
// map at x showing Blue Marble at x + d.
// Pixels where the day map's step is under DAY_STEP or isn't from water to
// land, or where a second step elsewhere is within AMBIGUOUS of it, are
// dropped.
//
// GIBS builds each level from the one below by halving, corner-aligned, so a
// coarser level sits south-east of a finer one: level 4 is 7/16 of its pixel
// off level 7, which the patch streams (measured 0.45 px over Lake Michigan
// and Yucatan). Each shift is moved by that much, so the field registers
// level 7.
//
// The field is a CELL-degree equirectangular grid, sampled bilinearly at
// texel centres like the texture it ships as, fitted by least squares to the
// coast pixels' n.d, plus one bias common to every coast (the day map's
// steepest step sits a little landward of Blue Marble's everywhere, which a
// shore facing one way alone would read as a shift), with a membrane (SMOOTH,
// in km so the same at every latitude) and a weak pull to zero (ZERO) where
// no coast says anything, refit twice with Huber weights. Last, every node
// under AGREE texels is set to zero, ramping in to full half a texel later,
// so the patch is untouched where the maps already agree. So is every node
// whose shift the coasts around it (its cell and the 8 next to it) don't
// confirm from both sides: those facing along it and those facing against it
// must each have moved, less the bias, by at least half of it. A warp moves
// every shore; a coast the day map merely draws differently (Texas's Laguna
// Madre as a wide lagoon, its mainland shore 4 texels inland) moves only the
// shores on one side.
//
// The field ships as CELL-degree RG8, rows from the north, x east then y
// south, each 128 plus sixteenths of a day-map texel (1/10800 of the
// circumference).
//
// A second fit, on half the coast pixels (a checkerboard of 1 degree
// squares), is scored on the other half to check that it generalises: the
// score is each pixel's residual across its coast, in day-map texels.
//
// As committed (level-4 tiles fetched 2026-10-22; defaults below; 90k coast
// pixels; common bias -0.43 texels), median |residual| across the coasts, in
// day-map texels, without the field and with it:
//   held-out:  all 0.43 -> 0.42, Great Lakes 3.05 -> 0.86, Gulf of Mexico
//              0.43 -> 0.43, Europe 0.24 -> 0.24
//   shipped:   Great Lakes 3.03 -> 0.79
// 70 of 16200 nodes move the patch, by at most 5.6 texels: the Great Lakes
// (Michigan -3.1, -3.0), Lake Victoria, and the coasts of Greenland and the
// Canadian Arctic islands. At the ship's stop (headless, 2026-10-22) the
// patch's coasts sit a median 23 -> 6 screen px off the day map's over Lake
// Michigan and 25 -> 7 over Lake Erie; Texas, Yucatan, Florida, Gibraltar and
// the Caspian are unchanged.
//
// Requires ImageMagick (magick) to decode the JPEGs.
// usage: node scripts/fit-gibs-warp.mjs <tile-cache-dir>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "src", "assets", "gibs-warp.bin");
const lutFile = path.join(root, "src", "assets", "gibs-colour-lut.bin");
const dayMap = path.join(root, "src", "assets", "earth-day.jpg");
const cache = process.argv[2];
if (!cache) throw new Error("usage: node scripts/fit-gibs-warp.mjs <tile-cache-dir>");

const LEVEL = 4;
const COLS = 20;
const ROWS = 10;
const W = 10800;
const H = 5400;
const TILE = W / COLS;
const LUT_SIDE = 17;
const MAX_LAT = 80;
const SIGMA = 1;
/** Red levels Blue Marble must step by across a coast, and the day map. */
const EDGE_STEP = 30;
const DAY_STEP = 15;
const REACH = 6;
const AMBIGUOUS = 0.6;
/** Blue over red, in sRGB levels, of water in either map: open ocean is
 * ~75, lakes ~50, forest and desert below 0, ice ~5. */
const WATER = 30;
const CELL = 2;
const SMOOTH = Number(process.env.SMOOTH ?? 1);
const ZERO = 0.1;
const HUBER = 1;
/** Under this many texels the maps are taken to agree: the coast pixels'
 * shifts carry a few tenths of a texel of bias, and moving the patch by a
 * shift that small made sea coasts measurably worse at the ship's stop. */
const AGREE = 2;
/** Coast pixels each side must have to confirm a node's shift. */
const CONFIRM_PIXELS = 10;
/** Level 4's offset south-east of level 7, in day-map texels. */
const LEVEL_OFFSET = (7 / 16) * (W / (COLS * 512));
/** Stored units per day-map texel. */
const UNITS = 16;
const tileUrl = (row, col) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/${LEVEL}/${row}/${col}.jpeg`;

async function fetchTiles() {
  fs.mkdirSync(cache, { recursive: true });
  const missing = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!fs.existsSync(path.join(cache, `${row}-${col}.jpeg`))) missing.push([row, col]);
    }
  }
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

function decode(file, width, height, filter) {
  const rgb = execFileSync(
    "magick",
    [file, "-filter", filter, "-resize", `${width}x${height}!`, "-depth", "8", "rgb:-"],
    { maxBuffer: width * height * 3 + 1024 },
  );
  if (rgb.length !== width * height * 3) throw new Error(`${file}: decoded ${rgb.length} bytes`);
  return rgb;
}

// Blue Marble's red, and blue less red, once recoloured (the same lookup as
// the patch's).
function marbleChannels() {
  const lut = fs.readFileSync(lutFile);
  const red = new Float32Array(W * H);
  const blue = new Float32Array(W * H);
  const lo = [0, 0, 0];
  const t = [0, 0, 0];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const px = decode(path.join(cache, `${row}-${col}.jpeg`), TILE, TILE, "Mitchell");
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const i = (y * TILE + x) * 3;
          for (let c = 0; c < 3; c++) {
            const s = Math.sqrt(px[i + c] / 255) * (LUT_SIDE - 1);
            lo[c] = Math.min(LUT_SIDE - 2, Math.floor(s));
            t[c] = s - lo[c];
          }
          let r = 0;
          let b = 0;
          for (let n = 0; n < 8; n++) {
            const dr = n & 1;
            const dg = (n >> 1) & 1;
            const db = (n >> 2) & 1;
            const w = (dr ? t[0] : 1 - t[0]) * (dg ? t[1] : 1 - t[1]) * (db ? t[2] : 1 - t[2]);
            const at = (lo[0] + dr + LUT_SIDE * (lo[1] + dg + LUT_SIDE * (lo[2] + db))) * 3;
            r += w * lut[at];
            b += w * lut[at + 2];
          }
          red[(row * TILE + y) * W + col * TILE + x] = r;
          blue[(row * TILE + y) * W + col * TILE + x] = b - r;
        }
      }
    }
  }
  return { red: blur(red, SIGMA), blue: blur(blue, SIGMA) };
}

function dayChannels() {
  const rgb = decode(dayMap, W, H, "Box");
  const red = new Float32Array(W * H);
  const blue = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    red[i] = rgb[i * 3];
    blue[i] = rgb[i * 3 + 2] - rgb[i * 3];
  }
  return { red: blur(red, SIGMA), blue: blur(blue, SIGMA) };
}

// Separable Gaussian, wrapping in x and clamped in y.
function blur(image, sigma) {
  const r = Math.ceil(sigma * 3);
  const kernel = [];
  for (let i = -r; i <= r; i++) kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = kernel.reduce((a, b) => a + b);
  const across = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += kernel[i + r] * image[y * W + ((x + i + W) % W)];
      across[y * W + x] = v / sum;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += kernel[i + r] * across[Math.min(H - 1, Math.max(0, y + i)) * W + x];
      out[y * W + x] = v / sum;
    }
  }
  return out;
}

// Bilinear, wrapping in x and clamped in y.
function sample(image, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = ((x0 % W) + W) % W;
  const xb = (xa + 1) % W;
  const ya = Math.min(H - 1, Math.max(0, y0));
  const yb = Math.min(H - 1, Math.max(0, y0 + 1));
  return (
    (image[ya * W + xa] * (1 - fx) + image[ya * W + xb] * fx) * (1 - fy) +
    (image[yb * W + xa] * (1 - fx) + image[yb * W + xb] * fx) * fy
  );
}

// The vertex of the parabola through f at (at - h, at, at + h), within h of at.
function refine(f, at, h) {
  const before = f(at - h);
  const here = f(at);
  const after = f(at + h);
  const curve = before - 2 * here + after;
  return curve < 0 ? at + Math.max(-h, Math.min(h, (h * 0.5 * (before - after)) / curve)) : at;
}

// The coast pixels: where each is, its normal (toward the brighter red,
// land), and the shift across it.
function measureCoasts({ red: marble, blue: marbleBlue }, { red: day, blue: dayBlue }) {
  const coasts = [];
  for (let y = 1; y < H - 1; y++) {
    if (Math.abs(90 - ((y + 0.5) / H) * 180) > MAX_LAT) continue;
    for (let x = 0; x < W; x++) {
      const gx = (marble[y * W + ((x + 1) % W)] - marble[y * W + ((x + W - 1) % W)]) / 2;
      const gy = (marble[(y + 1) * W + x] - marble[(y - 1) * W + x]) / 2;
      const length = Math.hypot(gx, gy);
      if (length < 8) continue;
      const nx = gx / length;
      const ny = gy / length;
      // Each map's red step over 2 texels, s texels along the normal.
      const across = (image, s) =>
        sample(image, x + nx * (s + 1), y + ny * (s + 1)) - sample(image, x + nx * (s - 1), y + ny * (s - 1));
      const marbleStep = (s) => across(marble, s);
      const dayStep = (s) => across(day, s);
      const here = marbleStep(0);
      if (marbleStep(-0.75) > here || marbleStep(0.75) > here) continue;
      if (sample(marble, x + nx * 4, y + ny * 4) - sample(marble, x - nx * 4, y - ny * 4) < EDGE_STEP) continue;
      if (sample(marbleBlue, x - nx * 4, y - ny * 4) < WATER || sample(marbleBlue, x + nx * 4, y + ny * 4) >= WATER) continue;
      const marbleAt = refine(marbleStep, 0, 0.5);
      if (Math.abs(marbleAt) > 0.75) continue;
      let best = -Infinity;
      let at = 0;
      const steps = [];
      for (let s = -REACH; s <= REACH; s += 0.25) {
        const v = dayStep(s);
        steps.push([s, v]);
        if (v > best) [best, at] = [v, s];
      }
      if (best < DAY_STEP || Math.abs(at) > REACH - 0.5) continue;
      // Water on the day map's water side, land on its land side, and
      // nothing else between its coast and Blue Marble's: a lagoon or a
      // barrier island there means two shores, and either could be the one.
      const water = (s) => sample(dayBlue, x + nx * s, y + ny * s) >= WATER;
      let clean = true;
      for (let s = Math.min(0, at) - 4; s <= at - 1.5 && clean; s += 0.5) clean = water(s);
      for (let s = at + 1.5; s <= Math.max(0, at) + 4 && clean; s += 0.5) clean = !water(s);
      if (!clean) continue;
      const rival = steps.some(
        ([s, v], k) =>
          Math.abs(s - at) > 2.5 && v > AMBIGUOUS * best && v >= (steps[k - 1]?.[1] ?? -Infinity) && v >= (steps[k + 1]?.[1] ?? -Infinity),
      );
      if (rival) continue;
      const dayAt = refine(dayStep, at, 0.25);
      const lon = ((x + 0.5) / W) * 360 - 180;
      const lat = 90 - ((y + 0.5) / H) * 180;
      coasts.push({
        lon,
        lat,
        nx,
        ny,
        shift: marbleAt - dayAt - LEVEL_OFFSET * (nx + ny),
        held: (Math.floor(lon + 180) + Math.floor(lat + 90)) % 2,
      });
    }
  }
  return coasts;
}

// The field's grid: node (i, j) at the centre of cell i east of the
// antimeridian, j south of the north pole.
const NX = 360 / CELL;
const NY = 180 / CELL;
const N = NX * NY;
function corners(lon, lat) {
  const fx = (lon + 180) / CELL - 0.5;
  const fy = Math.min(NY - 1, Math.max(0, (90 - lat) / CELL - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.min(NY - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (i, j) => j * NX + ((i % NX) + NX) % NX;
  return {
    nodes: [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)],
    weights: [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty],
  };
}
function fieldAt(field, lon, lat) {
  const { nodes, weights } = corners(lon, lat);
  let x = 0, y = 0;
  for (let k = 0; k < 4; k++) {
    x += weights[k] * field[nodes[k]];
    y += weights[k] * field[N + nodes[k]];
  }
  return [x, y];
}
// A coast pixel's residual across its coast, in day-map texels, for a
// field whose last entry is the coasts' common bias.
function residual(field, coast) {
  const [fx, fy] = fieldAt(field, coast.lon, coast.lat);
  return coast.nx * fx + coast.ny * fy + field[2 * N] - coast.shift;
}

// Least squares by conjugate gradients, x then y of every node, then the
// bias. Each coast pixel adds to its cell's 8x8 block of the normal
// equations (its 4 nodes' x and y), and to their row with the bias.
function solve(coasts, weight) {
  const cells = new Map();
  const B = 2 * N;
  const rhs = new Float64Array(B + 1);
  let biasWeight = 0;
  coasts.forEach((coast, c) => {
    const { nodes, weights } = corners(coast.lon, coast.lat);
    const key = nodes[0];
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { nodes, matrix: new Float64Array(64), bias: new Float64Array(8) }));
    const a = [...weights.map((w) => w * coast.nx), ...weights.map((w) => w * coast.ny)];
    for (let p = 0; p < 8; p++) {
      const row = p < 4 ? nodes[p] : N + nodes[p - 4];
      rhs[row] += weight[c] * a[p] * coast.shift;
      cell.bias[p] += weight[c] * a[p];
      for (let q = 0; q < 8; q++) cell.matrix[p * 8 + q] += weight[c] * a[p] * a[q];
    }
    rhs[B] += weight[c] * coast.shift;
    biasWeight += weight[c];
  });
  const blocks = [...cells.values()];
  const multiply = (v, out) => {
    out.fill(0);
    for (const { nodes, matrix, bias } of blocks) {
      const at = [...nodes, ...nodes.map((k) => N + k)];
      for (let p = 0; p < 8; p++) {
        let sum = bias[p] * v[B];
        for (let q = 0; q < 8; q++) sum += matrix[p * 8 + q] * v[at[q]];
        out[at[p]] += sum;
        out[B] += bias[p] * v[at[p]];
      }
    }
    out[B] += biasWeight * v[B];
    for (let j = 0; j < NY; j++) {
      // East-west neighbours are cos(lat) as far apart as north-south ones.
      const across = 1 / Math.max(0.1, Math.cos(((90 - (j + 0.5) * CELL) * Math.PI) / 180)) ** 2;
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        const east = j * NX + ((i + 1) % NX);
        for (const o of [0, N]) {
          const de = SMOOTH * across * (v[o + k] - v[o + east]);
          out[o + k] += de;
          out[o + east] -= de;
          if (j + 1 < NY) {
            const ds = SMOOTH * (v[o + k] - v[o + k + NX]);
            out[o + k] += ds;
            out[o + k + NX] -= ds;
          }
          out[o + k] += ZERO * v[o + k];
        }
      }
    }
  };
  const dot = (u, v) => u.reduce((a, value, k) => a + value * v[k], 0);
  const x = new Float64Array(B + 1);
  const r = Float64Array.from(rhs);
  const p = Float64Array.from(r);
  const Ap = new Float64Array(B + 1);
  const start = dot(r, r);
  let rr = start;
  for (let it = 0; it < 5000 && rr > 1e-14 * start; it++) {
    multiply(p, Ap);
    const alpha = rr / dot(p, Ap);
    for (let k = 0; k < x.length; k++) {
      x[k] += alpha * p[k];
      r[k] -= alpha * Ap[k];
    }
    const next = dot(r, r);
    for (let k = 0; k < x.length; k++) p[k] = r[k] + (next / rr) * p[k];
    rr = next;
  }
  if (rr > 1e-10 * start) throw new Error(`CG stopped at relative residual ${Math.sqrt(rr / start).toExponential(1)}`);
  return x;
}

const smoothstep = (from, to, x) => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

// The fitted field, kept only where it moves the patch AGREE texels or more,
// and quantised as stored.
function fitField(coasts) {
  const weight = new Float64Array(coasts.length).fill(1);
  let field = solve(coasts, weight);
  for (let pass = 0; pass < 2; pass++) {
    coasts.forEach((coast, c) => {
      const e = Math.abs(residual(field, coast));
      weight[c] = e <= HUBER ? 1 : HUBER / e;
    });
    field = solve(coasts, weight);
  }
  // The coast pixels in each node's cell.
  const inCell = Array.from({ length: N }, () => []);
  for (const coast of coasts) {
    const i = Math.min(NX - 1, Math.floor((coast.lon + 180) / CELL));
    const j = Math.min(NY - 1, Math.floor((90 - coast.lat) / CELL));
    inCell[j * NX + i].push(coast);
  }
  const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
  // Whether the coasts around node k, both those facing along its shift and
  // those facing against it, moved by at least half of it.
  const confirmed = (k) => {
    const [i, j] = [k % NX, Math.floor(k / NX)];
    const along = [];
    const against = [];
    for (let dj = -1; dj <= 1; dj++) {
      if (j + dj < 0 || j + dj >= NY) continue;
      for (let di = -1; di <= 1; di++) {
        for (const coast of inCell[(j + dj) * NX + ((i + di + NX) % NX)]) {
          const across = coast.nx * field[k] + coast.ny * field[N + k];
          const facing = across / Math.hypot(field[k], field[N + k]);
          if (Math.abs(facing) > 0.5) (facing > 0 ? along : against).push((coast.shift - field[2 * N]) / across);
        }
      }
    }
    return [along, against].every((side) => side.length >= CONFIRM_PIXELS && median(side) >= 0.5);
  };
  const bytes = new Uint8Array(2 * N);
  const shipped = new Float64Array(2 * N + 1);
  shipped[2 * N] = field[2 * N];
  for (let k = 0; k < N; k++) {
    let keep = smoothstep(AGREE, AGREE + 0.5, Math.hypot(field[k], field[N + k]));
    if (keep > 0 && !confirmed(k)) keep = 0;
    for (const [o, c] of [[0, 0], [N, 1]]) {
      const v = Math.max(-127, Math.min(127, Math.round(field[o + k] * keep * UNITS)));
      bytes[2 * k + c] = 128 + v;
      shipped[o + k] = v / UNITS;
    }
  }
  return { bytes, shipped };
}

const quantiles = (values) => {
  if (values.length === 0) return "no pixels";
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))].toFixed(2);
  return `median ${q(0.5)}, p75 ${q(0.75)}`;
};
const REGIONS = {
  all: [-90, 90, -180, 180],
  "Great Lakes": [40, 50, -93, -75],
  "Gulf of Mexico": [18, 31, -98, -80],
  Europe: [35, 60, -10, 30],
};
function report(name, field, coasts) {
  console.log(`${name}:`);
  for (const [region, [s, n, w, e]] of Object.entries(REGIONS)) {
    const inside = coasts.filter((c) => c.lat >= s && c.lat <= n && c.lon >= w && c.lon <= e);
    const unmoved = new Float64Array(2 * N + 1);
    unmoved[2 * N] = field[2 * N];
    const before = inside.map((c) => residual(unmoved, c));
    const after = inside.map((c) => residual(field, c));
    console.log(`  ${region} (${inside.length} px): ${quantiles(before)} -> ${quantiles(after)}`);
  }
}

await fetchTiles();
const coasts = measureCoasts(marbleChannels(), dayChannels());
console.log(`${coasts.length} coast pixels measured`);
report("held-out coasts, |residual| across them (texels)", fitField(coasts.filter((c) => !c.held)).shipped, coasts.filter((c) => c.held));
const { bytes, shipped } = fitField(coasts);
report("all coasts, shipped field", shipped, coasts);
console.log(`  coasts' common bias ${shipped[2 * N].toFixed(2)} texels (the day map's step sits that far landward of Blue Marble's)`);
let moved = 0;
let most = 0;
for (let k = 0; k < N; k++) {
  const length = Math.hypot(shipped[k], shipped[N + k]);
  if (length > 0) moved++;
  most = Math.max(most, length);
}
console.log(`  ${moved} of ${N} nodes move the patch, at most ${most.toFixed(2)} texels`);
for (const [name, lat, lon] of [["Lake Michigan", 44, -87], ["Lake Erie", 42.2, -81.2], ["Yucatan", 21.3, -89.6], ["Florida", 27, -81]]) {
  console.log(`  ${name}: ${fieldAt(shipped, lon, lat).map((v) => v.toFixed(2)).join(", ")}`);
}
fs.writeFileSync(output, bytes);
console.log(`Wrote ${path.relative(root, output)} (${NX}x${NY} RG8, ${bytes.length} bytes)`);
