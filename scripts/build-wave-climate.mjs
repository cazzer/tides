// Build src/assets/earth-wave-climate.bin, the sea's wave climate
// (tides-d9f.5; layout and encoding in src/renderers/waterClimate.ts, the
// source of truth, which the page decodes through).
//
// Samples Open-Meteo's Marine API (Météo-France MFWAM, its best match
// worldwide) at each texel centre on each of DAYS: the first day at every
// texel (save south of MFWAM's grid), the later ones only where the first saw
// sea. Each raw response is
// kept under --cache, so a re-run reads them back and makes no requests.
// Prints the global ocean medians that WIND_WAVE_REF_M and SWELL_REF_M
// should hold.
//
// usage: node scripts/build-wave-climate.mjs [--cache <dir>]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runnerImport } from "vite";

const API = "https://marine-api.open-meteo.com/v1/marine";
const MODEL = "meteofrance_wave";
const DAILY = [
  "wave_height_max",
  "wind_wave_height_max",
  "swell_wave_height_max",
  "wave_direction_dominant",
  "wind_wave_direction_dominant",
  "swell_wave_direction_dominant",
];
const BATCH = 96;
const PACE_MS = 11_000;
const TIMEOUT_MS = 60_000;
const MAX_REQUESTS = 50;

const root = process.cwd();
const output = path.join(root, "src", "assets", "earth-wave-climate.bin");
const cacheArg = process.argv.indexOf("--cache");
const cache = cacheArg >= 0 ? path.resolve(process.argv[cacheArg + 1]) : path.join(os.tmpdir(), "tides-wave-climate");
fs.mkdirSync(cache, { recursive: true });

// waterClimateLayout.ts is TypeScript; Vite (6.1 or later) transforms it for
// Node. It's the layout alone, not the asset this script makes, so a clean
// checkout bootstraps.
const { module: climate } = await runnerImport("/src/renderers/waterClimateLayout.ts", {
  configFile: false,
  logLevel: "error",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let requests = 0;
let lastRequest = 0;

async function fetchBatch(day, points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(","),
    longitude: points.map((p) => p.lon).join(","),
    daily: DAILY.join(","),
    start_date: day,
    end_date: day,
    timezone: "GMT",
    models: MODEL,
  });
  const url = `${API}?${params}`;
  for (let attempt = 0; ; attempt++) {
    if (++requests > MAX_REQUESTS) throw new Error(`more than ${MAX_REQUESTS} requests; stopping`);
    await sleep(Math.max(0, lastRequest + PACE_MS - Date.now()));
    lastRequest = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 429 && attempt < 4) {
      // Retry-After in seconds when the API gives one, else back off.
      const after = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 60_000 * 2 ** attempt;
      console.warn(`429 from Open-Meteo; waiting ${wait / 1000} s`);
      await sleep(wait);
      continue;
    }
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  }
}

// One batch of a day, from the cache or the API.
async function batch(day, start, points) {
  const file = path.join(cache, `${day}-${String(start).padStart(4, "0")}.json`);
  const key = `${DAILY.join(",")};${points.map((p) => `${p.lat},${p.lon}`).join(";")}`;
  let body;
  if (fs.existsSync(file)) {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cached.key !== key) throw new Error(`${file} holds other points or variables; delete it`);
    body = cached.body;
  } else {
    body = await fetchBatch(day, points);
    // One location comes back as an object, more as an array.
    if (!Array.isArray(body)) body = [body];
    fs.writeFileSync(file, JSON.stringify({ key, body }));
    console.log(`fetched ${day} #${start} (${points.length} points)`);
  }
  if (!Array.isArray(body)) body = [body];
  if (body.length !== points.length) {
    throw new Error(`${day} #${start}: ${body?.length} locations, expected ${points.length}`);
  }
  return body.map((location, k) => {
    const { lat, lon } = points[k];
    const dLon = Math.abs(((location.longitude - lon + 540) % 360) - 180);
    if (Math.abs(location.latitude - lat) > 1 || dLon > 1) {
      throw new Error(`${day} #${start + k}: answered for ${location.latitude},${location.longitude}, asked ${lat},${lon}`);
    }
    const value = (name) => {
      const v = location.daily?.[name]?.[0];
      if (v !== null && typeof v !== "number") throw new Error(`${day} #${start + k}: ${name} is ${v}`);
      return v;
    };
    return {
      waveHeight: value("wave_height_max"),
      windWave: value("wind_wave_height_max"),
      swell: value("swell_wave_height_max"),
      direction: value("wave_direction_dominant"),
      windDirection: value("wind_wave_direction_dominant"),
      swellDirection: value("swell_wave_direction_dominant"),
    };
  });
}

async function sampleDay(day, indices) {
  const samples = new Map();
  for (let start = 0; start < indices.length; start += BATCH) {
    const slice = indices.slice(start, start + BATCH);
    const points = slice.map((k) => ({
      lat: climate.texelLat(Math.floor(k / climate.CLIMATE_COLS)),
      lon: climate.texelLon(k % climate.CLIMATE_COLS),
    }));
    const days = await batch(day, start, points);
    slice.forEach((k, n) => samples.set(k, days[n]));
  }
  return samples;
}

const count = climate.CLIMATE_COLS * climate.CLIMATE_ROWS;
const [first, ...later] = climate.DAYS;
// MFWAM's grid stops short of the South Pole: the API answers 400 ("No data
// is available for this location") at 86.25°S, which is all ice sheet.
const SOUTHMOST_LAT = -80;
const asked = Array.from({ length: count }, (_, k) => k).filter(
  (k) => climate.texelLat(Math.floor(k / climate.CLIMATE_COLS)) > SOUTHMOST_LAT,
);
const firstDay = await sampleDay(first, asked);
const ocean = [...firstDay].filter(([, d]) => d.waveHeight !== null).map(([k]) => k);
const perTexel = new Map(ocean.map((k) => [k, [firstDay.get(k)]]));
for (const day of later) {
  for (const [k, sample] of await sampleDay(day, ocean)) perTexel.get(k).push(sample);
}

const cells = Array.from({ length: count }, (_, k) => (perTexel.has(k) ? climate.climateCell(perTexel.get(k)) : null));
const bytes = climate.encode(cells);
fs.writeFileSync(output, bytes);

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const decoded = climate.decode(bytes);
const sea = cells.flatMap((c, k) => (c === null ? [] : [decoded[k]]));
const settled = (h) => median(sea.map((c) => Math.hypot(c[`${h}Cos`], c[`${h}Sin`]))).toFixed(3);
console.log(`${requests} requests; ${sea.length} of ${count} texels at sea`);
console.log(`ocean medians: wind waves ${median(sea.map((c) => c.windWave)).toFixed(3)} m, swell ${median(sea.map((c) => c.swell)).toFixed(3)} m`);
console.log(`heading lengths: dominant ${settled("wave")}, wind waves ${settled("wind")}, swell ${settled("swell")}`);
console.log(`Wrote ${path.relative(root, output)} (${bytes.length} bytes)`);
