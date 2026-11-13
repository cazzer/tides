// Simulated lightning (tides-ufyr.14): plausible flashes for the scene times
// GOES GLM has nothing for (before its archive, and past the latest data:
// forecast hours and the static clouds beyond them), deterministic from the
// time alone so scrubbing replays the same storms. Pure.
//
// Storms are seeded per STORM_EPOCH_MS per climatology cell
// (./lightning-climatology.ts) at the most the cell could flash, F · R_MAX /
// MEAN_GATE, each storm living 20-60 min with a sin-shaped flash rate, and
// thinned per 20 s window: a storm flashes in a window when its fixed draw
// uAccept is under (R / R_MAX) · g, so the expected density is
//   F_clim(cell, t) · R · g(cover) / MEAN_GATE
// with R the regime's factor at the storm's centre (the forecast's showers
// where the cloud frames carry precipitation there, the climatology's
// diurnal cycle elsewhere) and g the thick-cloud gate on the drawn cover.
// MEAN_GATE is g's mean where storms are, so the climatology's own rate
// comes back on average. F_clim is LIS's where it has data and a guess
// elsewhere (./lightning-climatology.ts densityOf): there the cover gate and
// the forecast's showers alone say where storms are. Storm centres are in
// the cloud map's frame (the
// renderer adds the static clouds' drift at emit).
import { precipFromFrames } from './cloud-precip'
import {
  CLIM_CELLS,
  CLIM_W,
  cellAreaKm2,
  densityOf,
  monthBlend,
  staticCover,
  type LightningClimatology,
  type MonthBlend,
} from './lightning-climatology'
import { WINDOW_MS, type FlashBatch } from './lightning'
import { smoothstep } from './real-clouds'

/** [TUNE] The most the regime factor R reaches (the storms' seeding headroom). */
export const R_MAX = 3
/** [TUNE] Forecast showers (mm/h, on the 10° grid, smoothed) for R = 1. */
export const SHOWERS_REF_MM_H = 0.3
/** [TUNE] The thick-cloud gate: none under this alpha, all over THICK_HI. */
export const THICK_LO = 0.5
export const THICK_HI = 0.8
/** [TUNE] The gate's mean where storms are. */
export const MEAN_GATE = 0.35
/** [TUNE] A storm's mean peak flash rate (exponential), flashes per minute. */
export const STORM_RATE_PER_MIN = 3
/** [TUNE] A storm's life, uniform between these. */
export const STORM_LIFE_MIN_MS = 20 * 60_000
export const STORM_LIFE_MAX_MS = 60 * 60_000
/** [TUNE] Flashes scatter this far (Gaussian sigma) from their storm's centre. */
export const FLASH_SIGMA_KM = 12
/** Storms are seeded per this much time. */
export const STORM_EPOCH_MS = 30 * 60_000
/** A window's flashes are capped at this many. */
export const SIM_MAX_PER_WINDOW = 4096
/** A storm's mean flash count: mean peak · mean life · the sine's mean (2 / π). */
export const FLASHES_PER_STORM =
  ((STORM_RATE_PER_MIN * (STORM_LIFE_MIN_MS + STORM_LIFE_MAX_MS)) / 2 / 60_000) * (2 / Math.PI)

// The flashes' look, as GLM's fixtures (src/__fixtures__/glm-lcfa-*.json)
// give it: optical energy ~10^-12.8 J, footprint ~10^2.7 km².
const LOG_ENERGY = { mean: -12.9, sd: 0.6, lo: -15, hi: -11.5 }
const LOG_AREA = { mean: 2.6, sd: 0.45, lo: Math.log10(20), hi: 5 }
const DURATION_MS: readonly [number, number] = [100, 400]

const DAY_MS = 86_400_000
const KM_PER_DEG = 111.195
const DEG = Math.PI / 180
const CELL_DEG = 360 / CLIM_W
const TWO_32 = 4294967296

// --- Hashing and draws -------------------------------------------------------

function mixIn(h: number, k: number): number {
  k = Math.imul(k, 0xcc9e2d51)
  k = (k << 15) | (k >>> 17)
  k = Math.imul(k, 0x1b873593)
  h ^= k
  h = (h << 13) | (h >>> 19)
  return (Math.imul(h, 5) + 0xe6546b64) | 0
}

/** Four 32-bit words hashed to one (murmur3's mixing and finaliser). */
export function hash32(a: number, b: number, c: number, d: number): number {
  let h = mixIn(mixIn(mixIn(mixIn(0x2f6b1d35, a), b), c), d) ^ 16
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** A uniform draw in (0, 1) for an index (a window or epoch, as its low
 * and high words), a key and a stream. */
export function unit(index: number, key: number, stream: number): number {
  return (hash32(index >>> 0, Math.floor(index / TWO_32) | 0, key, stream) + 0.5) / TWO_32
}

/** The standard normal's quantile (Acklam's rational approximation, ~1e-9). */
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** A Poisson(mu) draw by inverting its CDF at u: exact below 40, normal above. */
export function poissonInv(mu: number, u: number): number {
  if (!(mu > 0)) return 0
  if (mu >= 40) return Math.max(0, Math.round(mu + Math.sqrt(mu) * normInv(u)))
  let p = Math.exp(-mu)
  let cdf = p
  let k = 0
  while (u > cdf && k < 200) {
    k++
    p *= mu / k
    cdf += p
  }
  return k
}

// --- Rates -------------------------------------------------------------------

/** Mean solar time at a longitude, hours 0..24. */
export function localSolarHour(tMs: number, lonDeg: number): number {
  return ((((tMs / 3_600_000 + lonDeg / 15) % 24) + 24) % 24)
}

/** The climatology's diurnal cycle, mean 1 over a day: over land a late
 * afternoon peak (16:30), over the sea a weak one before dawn. */
export function diurnalFactor(hour: number, land: number): number {
  const w = (2 * Math.PI) / 24
  return land * (1 + 0.9 * Math.cos(w * (hour - 16.5))) + (1 - land) * (1 + 0.25 * Math.cos(w * (hour - 4)))
}

/** The forecast's factor for its convective showers, mm/h. */
export function forecastFactor(showersMmH: number): number {
  return Math.min(R_MAX, Math.max(0, showersMmH) / SHOWERS_REF_MM_H)
}

/** How much of a storm flashes under a drawn cloud alpha: only thick cloud. */
export function thickGate(alpha: number): number {
  return smoothstep(THICK_LO, THICK_HI, alpha)
}

/** A cloud map's alpha, a byte per texel, bottom row first (renderers/cloudBlend.ts coverBytesOf). */
export interface CloudBytes {
  data: ArrayLike<number>
  width: number
  height: number
}

/** One cloud frame as the CPU reads it: its alpha (null: the static
 * clouds', from the climatology) and precipitation grid (null: none). */
export interface SimFrame {
  cover: CloudBytes | null
  precip: Uint8Array | null
}

/** The clouds drawn at a time: frames a and b, mix of the way from a to b;
 * a null frame is the static clouds. */
export interface SimClouds {
  a: SimFrame | null
  b: SimFrame | null
  mix: number
}

function alphaAt(map: CloudBytes, latDeg: number, lonDeg: number): number {
  const u = (((lonDeg + 180) / 360) % 1 + 1) % 1
  const v = Math.min(1, Math.max(0, (latDeg + 90) / 180))
  const x = Math.min(map.width - 1, Math.floor(u * map.width))
  const y = Math.min(map.height - 1, Math.floor(v * map.height))
  return map.data[y * map.width + x] / 255
}

const frameCover = (frame: SimFrame | null, clim: LightningClimatology, latDeg: number, lonDeg: number) =>
  frame?.cover ? alphaAt(frame.cover, latDeg, lonDeg) : staticCover(clim, latDeg, lonDeg)

/** The drawn cloud's alpha at (lat, lon): the texel holding it in a and b, mixed. */
export function coverAt(clouds: SimClouds, clim: LightningClimatology, latDeg: number, lonDeg: number): number {
  const { a, b, mix } = clouds
  if (mix <= 0) return frameCover(a, clim, latDeg, lonDeg)
  if (mix >= 1) return frameCover(b, clim, latDeg, lonDeg)
  return (1 - mix) * frameCover(a, clim, latDeg, lonDeg) + mix * frameCover(b, clim, latDeg, lonDeg)
}

/** R at a point: the forecast's showers where the frames have precipitation
 * there, else the climatology's diurnal cycle. */
export function regimeFactor(
  clouds: SimClouds,
  latDeg: number,
  lonDeg: number,
  tMs: number,
  land: number
): number {
  const precip = precipFromFrames(clouds.a?.precip ?? null, clouds.b?.precip ?? null, clouds.mix, latDeg, lonDeg)
  return precip ? forecastFactor(precip.showers) : diurnalFactor(localSolarHour(tMs, lonDeg), land)
}

// --- Storms ------------------------------------------------------------------

/** One epoch's storms (those starting in it), in typed arrays. */
export interface Storms {
  count: number
  /** The centre, degrees, in the cloud map's frame. */
  lat: Float32Array
  lon: Float32Array
  startMs: Float64Array
  lifeMs: Float32Array
  /** Flashes per minute at the storm's height. */
  peakPerMin: Float32Array
  /** Its fixed draw against (R / R_MAX) · g. */
  uAccept: Float32Array
  /** Its cell's land fraction. */
  land: Float32Array
  /** Seeds its windows' draws. */
  seed: Uint32Array
}

const EPOCHS_KEPT = 4
const stormCache = new WeakMap<LightningClimatology, Map<number, Storms>>()
const blend: MonthBlend = { m0: 0, m1: 0, f: 0 }
const cellCounts = new Int32Array(CLIM_CELLS)
const SEED_SCALE = (R_MAX / MEAN_GATE) * (STORM_EPOCH_MS / DAY_MS) / FLASHES_PER_STORM

/** The storms starting in epoch `epoch` (floor(t / STORM_EPOCH_MS)); the
 * last few epochs' are kept. */
export function stormsOfEpoch(epoch: number, clim: LightningClimatology): Storms {
  let cache = stormCache.get(clim)
  if (!cache) {
    cache = new Map()
    stormCache.set(clim, cache)
  }
  const hit = cache.get(epoch)
  if (hit) {
    cache.delete(epoch)
    cache.set(epoch, hit)
    return hit
  }
  const storms = seedStorms(epoch, clim)
  cache.set(epoch, storms)
  while (cache.size > EPOCHS_KEPT) cache.delete(cache.keys().next().value!)
  return storms
}

function seedStorms(epoch: number, clim: LightningClimatology): Storms {
  const epochStart = epoch * STORM_EPOCH_MS
  monthBlend(epochStart + STORM_EPOCH_MS / 2, blend)
  let total = 0
  for (let cell = 0; cell < CLIM_CELLS; cell++) {
    const density = densityOf(clim, cell, blend)
    const mu = density > 0 ? density * cellAreaKm2(Math.floor(cell / CLIM_W)) * SEED_SCALE : 0
    const n = poissonInv(mu, unit(epoch, cell, 0))
    cellCounts[cell] = n
    total += n
  }
  const s: Storms = {
    count: total,
    lat: new Float32Array(total),
    lon: new Float32Array(total),
    startMs: new Float64Array(total),
    lifeMs: new Float32Array(total),
    peakPerMin: new Float32Array(total),
    uAccept: new Float32Array(total),
    land: new Float32Array(total),
    seed: new Uint32Array(total),
  }
  let i = 0
  for (let cell = 0; cell < CLIM_CELLS; cell++) {
    const n = cellCounts[cell]
    if (n === 0) continue
    const row = Math.floor(cell / CLIM_W)
    const lat0 = -90 + row * CELL_DEG
    const lon0 = -180 + (cell - row * CLIM_W) * CELL_DEG
    for (let k = 0; k < n; k++, i++) {
      const stream = 1 + k * 8
      s.lat[i] = lat0 + unit(epoch, cell, stream) * CELL_DEG
      s.lon[i] = lon0 + unit(epoch, cell, stream + 1) * CELL_DEG
      s.startMs[i] = epochStart + unit(epoch, cell, stream + 2) * STORM_EPOCH_MS
      s.lifeMs[i] = STORM_LIFE_MIN_MS + unit(epoch, cell, stream + 3) * (STORM_LIFE_MAX_MS - STORM_LIFE_MIN_MS)
      s.peakPerMin[i] = -STORM_RATE_PER_MIN * Math.log(unit(epoch, cell, stream + 4))
      s.uAccept[i] = unit(epoch, cell, stream + 5)
      s.land[i] = clim.land[cell]
      s.seed[i] = hash32(epoch >>> 0, Math.floor(epoch / TWO_32) | 0, cell, stream + 6)
    }
  }
  return s
}

// --- A window's flashes --------------------------------------------------------

/** The epochs whose storms can be alive at a time: a storm outlives its epoch by up to two. */
const EPOCHS_BACK = Math.ceil(STORM_LIFE_MAX_MS / STORM_EPOCH_MS)

// Scratch for a window's flashes before they are sorted, grown as needed.
let scratchCap = 0
let sLat = new Float32Array(0)
let sLon = new Float32Array(0)
let sOff = new Float32Array(0)
let sDur = new Float32Array(0)
let sEnergy = new Float32Array(0)
let sArea = new Float32Array(0)

function reserve(n: number) {
  if (n <= scratchCap) return
  const cap = Math.max(n, scratchCap * 2, 1024)
  const grow = (old: Float32Array) => {
    const next = new Float32Array(cap)
    next.set(old)
    return next
  }
  sLat = grow(sLat)
  sLon = grow(sLon)
  sOff = grow(sOff)
  sDur = grow(sDur)
  sEnergy = grow(sEnergy)
  sArea = grow(sArea)
  scratchCap = cap
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180

/**
 * Window w's simulated flashes (its 20 s from w · WINDOW_MS) under these
 * clouds (as drawn at the window's middle). Depends on nothing else: the
 * same arguments give the same batch, byte for byte.
 */
export function simulateWindow(w: number, clim: LightningClimatology, clouds: SimClouds): FlashBatch {
  const startMs = w * WINDOW_MS
  const tMid = startMs + WINDOW_MS / 2
  const e = Math.floor(tMid / STORM_EPOCH_MS)
  let count = 0
  for (let epoch = e - EPOCHS_BACK; epoch <= e; epoch++) {
    const s = stormsOfEpoch(epoch, clim)
    for (let i = 0; i < s.count; i++) {
      const tau = (tMid - s.startMs[i]) / s.lifeMs[i]
      if (!(tau > 0 && tau < 1)) continue
      const u = s.uAccept[i]
      const lat0 = s.lat[i]
      const lon0 = s.lon[i]
      // R / R_MAX is at most 1: the gate alone settles most.
      const g = thickGate(coverAt(clouds, clim, lat0, lon0))
      if (!(u < g)) continue
      if (!(u < (regimeFactor(clouds, lat0, lon0, tMid, s.land[i]) / R_MAX) * g)) continue
      const seed = s.seed[i]
      const mu = (s.peakPerMin[i] / 60_000) * Math.sin(Math.PI * tau) * WINDOW_MS
      const n = poissonInv(mu, unit(w, seed, 1))
      if (n === 0) continue
      reserve(count + n)
      const lonScale = FLASH_SIGMA_KM / (KM_PER_DEG * Math.max(Math.cos(lat0 * DEG), 0.05))
      for (let j = 0; j < n; j++, count++) {
        const stream = 2 + j * 6
        sLat[count] = clamp(lat0 + (FLASH_SIGMA_KM / KM_PER_DEG) * normInv(unit(w, seed, stream)), -90, 90)
        sLon[count] = wrapLon(lon0 + lonScale * normInv(unit(w, seed, stream + 1)))
        sOff[count] = unit(w, seed, stream + 2) * WINDOW_MS
        sEnergy[count] = 10 ** clamp(LOG_ENERGY.mean + LOG_ENERGY.sd * normInv(unit(w, seed, stream + 3)), LOG_ENERGY.lo, LOG_ENERGY.hi)
        sArea[count] = 10 ** clamp(LOG_AREA.mean + LOG_AREA.sd * normInv(unit(w, seed, stream + 4)), LOG_AREA.lo, LOG_AREA.hi)
        sDur[count] = DURATION_MS[0] + unit(w, seed, stream + 5) * (DURATION_MS[1] - DURATION_MS[0])
      }
    }
  }
  // Over the cap, an even spread of them (storms are in cell order: across the map).
  const kept = Math.min(count, SIM_MAX_PER_WINDOW)
  const order = new Uint32Array(kept)
  for (let j = 0; j < kept; j++) order[j] = kept === count ? j : Math.floor((j * count) / kept)
  order.sort((x, y) => sOff[x] - sOff[y] || x - y)
  const pick = (from: Float32Array) => {
    const to = new Float32Array(kept)
    for (let j = 0; j < kept; j++) to[j] = from[order[j]]
    return to
  }
  return {
    source: 'simulated',
    key: `sim:${w}`,
    startMs,
    count: kept,
    lat: pick(sLat),
    lon: pick(sLon),
    offsetMs: pick(sOff),
    durationMs: pick(sDur),
    energyJ: pick(sEnergy),
    areaKm2: pick(sArea),
    owned: new Uint8Array(kept).fill(1),
  }
}
