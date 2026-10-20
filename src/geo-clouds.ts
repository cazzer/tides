// Time-matched clouds from geostationary imagery on NASA GIBS (tides-1zj):
// GOES-East, GOES-West and Himawari clean longwave IR (band 13) every 10
// minutes, so clouds exist on the night side too and there's no dateline seam
// between daily passes, plus the red visible band by day for the low cloud IR
// can't see. Where none of them sees well (high latitudes, and Europe /
// Africa / the western Indian Ocean, which would need Meteosat) the daily
// VIIRS composite from real-clouds.ts shows through. Pure logic only; the
// browser side is renderers/cloudPipeline.ts.
import { COLS, OUT_H, OUT_W, ROWS, smoothstep, TILE } from './real-clouds.ts'

const DAY_MS = 86_400_000
const DEG = Math.PI / 180

// GIBS layers as of the 2026-10-19 capabilities document. Sub-satellite
// longitudes are the operational slots (GOES-19, GOES-18, Himawari-9), which
// match the centres of the imaged disks.
export const GEO_SATELLITES = [
  {
    id: 'goes-west',
    label: 'GOES-West',
    lon: -137.2,
    irLayer: 'GOES-West_ABI_Band13_Clean_Infrared',
    visLayer: 'GOES-West_ABI_Band2_Red_Visible_1km',
  },
  {
    id: 'goes-east',
    label: 'GOES-East',
    lon: -75.2,
    irLayer: 'GOES-East_ABI_Band13_Clean_Infrared',
    visLayer: 'GOES-East_ABI_Band2_Red_Visible_1km',
  },
  {
    id: 'himawari',
    label: 'Himawari',
    lon: 140.7,
    irLayer: 'Himawari_AHI_Band13_Clean_Infrared',
    visLayer: 'Himawari_AHI_Band3_Red_Visible_1km',
  },
] as const
export type GeoSatellite = (typeof GEO_SATELLITES)[number]

// Slot timing is in real-clouds.ts. A request for a time between slots gets
// the slot before, but a missing slot (a few a day) 404s, so the client steps
// back up to this many slots itself.
export const GEO_STEP_BACK = 3

/** WMTS tile URL (row-major index like tileUrls); IR is published in the
 * "2km" matrix set, visible in "1km", both 5x3 tiles of 512px at level 2 like
 * the daily layers. */
export function geoTileUrl(layer: string, time: string, index: number): string {
  const matrixSet = layer.endsWith('_1km') ? '1km' : '2km'
  const row = Math.floor(index / COLS)
  const col = index % COLS
  return `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layer}/default/${time}/${matrixSet}/2/${row}/${col}.png`
}

// View geometry. A geostationary disk reaches ~81° of arc from the
// sub-satellite point, but pixels stretch and parallax grows toward the limb,
// so a satellite has full say within GEO_FULL_DEG and none past GEO_ZERO_DEG,
// leaving the daily composite at high latitudes.
export const GEO_FULL_DEG = 58
export const GEO_ZERO_DEG = 72

/** Great-circle angle (degrees) from the sub-satellite point. */
export function viewAngle(latDeg: number, lonDeg: number, satLonDeg: number): number {
  const c = Math.cos(latDeg * DEG) * Math.cos((lonDeg - satLonDeg) * DEG)
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG
}

/** 0..1: how far this satellite's view of a point can be trusted. */
export function viewCoverage(angleDeg: number): number {
  return 1 - smoothstep(GEO_FULL_DEG, GEO_ZERO_DEG, angleDeg)
}

/** Relative weight between satellites that both see a point: the one looking
 * more nearly straight down wins, with a crossfade a few tens of degrees wide
 * through the overlap rather than a 50/50 blend of two parallaxes. */
export function viewWeight(angleDeg: number): number {
  return viewCoverage(angleDeg) * Math.cos(angleDeg * DEG) ** 6
}

/** Latitude/longitude (degrees) of an output pixel's centre. */
export function pixelLat(y: number): number {
  return 90 - ((y + 0.5) / OUT_H) * 180
}
export function pixelLon(x: number): number {
  return ((x + 0.5) / OUT_W) * 360 - 180
}

/** Which of the 15 level-2 tiles (row-major) hold any pixel this satellite
 * covers, so the rest are never fetched. */
export function geoTilesFor(satLon: number): boolean[] {
  const wanted: boolean[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const top = 90 - row * (TILE / OUT_H) * 180
      const bottom = Math.max(-90, top - (TILE / OUT_H) * 180)
      const west = -180 + col * (TILE / OUT_W) * 360
      const east = west + (TILE / OUT_W) * 360
      const nearestLat = top < 0 ? top : bottom > 0 ? bottom : 0
      // Longitude difference to the tile's nearest edge, with wrap-around.
      const d = (lon: number) => Math.abs(((lon - satLon + 540) % 360) - 180)
      const inside = d(west) + d(east) <= (TILE / OUT_W) * 360 + 1e-9
      const nearestDLon = inside ? 0 : Math.min(d(west), d(east))
      wanted.push(viewAngle(nearestLat, satLon + nearestDLon, satLon) < GEO_ZERO_DEG)
    }
  }
  return wanted
}

/** The tile (row-major index) holding the sub-satellite point, fetched first
 * to find out whether a slot exists before asking for the rest. */
export function probeTile(satLon: number): number {
  return Math.floor(ROWS / 2) * COLS + Math.min(COLS - 1, Math.floor(((satLon + 180) / 360) * COLS))
}

/** Of `wanted` tiles, those with any daylight at all for the visible band
 * (sampled every 4° of each tile, which is plenty for a 72° tile). */
export function daylitTiles(wanted: readonly boolean[], sun: { lat: number; lon: number }): boolean[] {
  const tileDeg = (TILE / OUT_W) * 360
  return wanted.map((want, i) => {
    if (!want) return false
    const west = -180 + (i % COLS) * tileDeg
    const top = 90 - Math.floor(i / COLS) * tileDeg
    for (let lat = top; lat >= Math.max(-90, top - tileDeg); lat -= 4) {
      for (let lon = west; lon <= west + tileDeg; lon += 4) {
        if (cosSunZenith(lat, lon, sun) > VIS_DAY_FROM) return true
      }
    }
    return false
  })
}

// --- IR decoding -----------------------------------------------------------

const WARM_GREY_TOP = 197
const WARM_GREY_TOP_C = -18.85
const WARM_GREY_C_PER_LEVEL = (56.65 - WARM_GREY_TOP_C) / (WARM_GREY_TOP - 2)
const COLD_GREY_LOW = 5
const COLD_GREY_HIGH = 230
const WARM_POLYLINE_END = 60

// Greys a little lighter than the warm ramp's top are nearly all that top
// resampled with a little cyan (196,198,198 averages 197.3) rather than the
// coldest greys of a core, which sit by its pinks; read as -79 °C they left
// cold specks along cloud edges (tides-9jn.3). They're ambiguous like the
// rest: warm unless inside a cold cluster.
const WARM_GREY_SLACK = 210

function greyTemperature(v: number): number {
  if (v <= WARM_GREY_SLACK) {
    return WARM_GREY_TOP_C + (WARM_GREY_TOP - Math.min(WARM_GREY_TOP, v)) * WARM_GREY_C_PER_LEVEL
  }
  // Above that only the cold greys and white remain.
  return v >= COLD_GREY_HIGH ? -79.6 - ((v - COLD_GREY_HIGH) / (255 - COLD_GREY_HIGH)) * 12 : -79
}

// GIBS renders brightness temperature through its
// Clean_Longwave_Infrared_Window_Band colormap. At level 2 the tiles are
// resampled from the full-resolution image, so pixels fall between the
// colormap's entries. These are its linear runs as polylines, [r, g, b, °C],
// coldest first. The cold greys (-70.6 °C at 5 up to -79.6 °C at 230) reuse
// the warm grey ramp's values, so they're left out of the polylines: a
// greyish pixel is read as the warm ramp, and decodeIr turns greys inside a
// cold cluster back.
const IR_POLYLINES: readonly (readonly (readonly [number, number, number, number])[])[] = [
  [
    [255, 255, 255, -91.6],
    [127, 0, 127, -90.6],
    [255, 127, 203, -80.6],
    [230, 230, 230, -79.6],
  ],
  [
    [26, 0, 0, -69.6],
    [255, 0, 0, -60.6],
    [255, 255, 0, -50.6],
    [0, 255, 0, -40.6],
    [0, 64, 86, -31.6],
    [0, 0, 115, -29.85],
    [0, 0, 125, -29.35],
    [0, 13, 122, -28.85],
    [0, 255, 255, -19.35],
    [197, 197, 197, -18.85],
    // Stops short of the ramp's black end, so dark reds next to the cold
    // greys of a convective core read as -70 °C rather than +50 °C.
    [WARM_POLYLINE_END, WARM_POLYLINE_END, WARM_POLYLINE_END, greyTemperature(WARM_POLYLINE_END)],
  ],
]

/** [°C at the nearest point on the polylines, distance to it in RGB]. */
function nearestOnPolylines(r: number, g: number, b: number): [number, number] {
  let best = Infinity
  let temp = 0
  for (const line of IR_POLYLINES) {
    for (let i = 0; i + 1 < line.length; i++) {
      const [r0, g0, b0, t0] = line[i]
      const [r1, g1, b1, t1] = line[i + 1]
      const dr = r1 - r0
      const dg = g1 - g0
      const db = b1 - b0
      const len2 = dr * dr + dg * dg + db * db
      const u = Math.max(0, Math.min(1, ((r - r0) * dr + (g - g0) * dg + (b - b0) * db) / len2))
      const er = r0 + u * dr - r
      const eg = g0 + u * dg - g
      const eb = b0 + u * db - b
      const d = er * er + eg * eg + eb * eb
      if (d < best) {
        best = d
        temp = t0 + u * (t1 - t0)
      }
    }
  }
  return [temp, Math.sqrt(best)]
}

// 5 bits a channel; the coloured ramps change by at most ~0.5 °C per 8 levels.
let colourLut: { temp: Float32Array; distance: Uint8Array } | null = null
function getColourLut() {
  if (colourLut) return colourLut
  const temp = new Float32Array(32 * 32 * 32)
  const distance = new Uint8Array(temp.length)
  for (let i = 0; i < temp.length; i++) {
    const [t, d] = nearestOnPolylines(((i >> 10) << 3) + 4, (((i >> 5) & 31) << 3) + 4, ((i & 31) << 3) + 4)
    temp[i] = t
    distance[i] = Math.min(255, Math.round(d))
  }
  return (colourLut = { temp, distance })
}

function lutIndex(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
}

// Resampling also blends colours from different runs of the colormap (a warm
// grey with a cyan, say), which lie off every polyline and whose nearest point
// can be tens of degrees out. Further than this (in RGB, including the LUT's
// quantisation) they're unmixed from their on-ramp neighbours instead, which
// is what the blend was of. So are greys with any tint (a dark red resampled
// with a grey, say 92,71,71): the warm ramp is pure grey, so a tint is always
// another run mixed in, but such pixels lie close enough to the grey ramp to
// read as warm as the sea, and left holes in convective cloud (tides-9jn.3).
const BLEND_DISTANCE = 20
/** LUT temperatures above this are on the warm grey ramp proper. */
const ON_WARM_GREY_C = WARM_GREY_TOP_C + 0.3

const GREY_TOLERANCE = 3

function isGrey(r: number, g: number, b: number): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) <= GREY_TOLERANCE
}

function coldGreyTemperature(v: number): number {
  const u = (Math.min(COLD_GREY_HIGH, Math.max(COLD_GREY_LOW, v)) - COLD_GREY_LOW) /
    (COLD_GREY_HIGH - COLD_GREY_LOW)
  return -70.6 - u * 9
}

/** Brightness temperature (°C) of one colormapped pixel, reading greys as the
 * warm ramp. */
export function irTemperature(r: number, g: number, b: number): number {
  if (isGrey(r, g, b)) return greyTemperature((r + g + b) / 3)
  return getColourLut().temp[lutIndex(r, g, b)]
}

/** A grey with at least COLD_NEIGHBOURS of its 8 neighbours colder than
 * COLD_NEIGHBOUR_C is inside a cold cluster, so on the cold ramp; a warm grey
 * along the straight edge of an anvil has at most 3. */
const COLD_NEIGHBOUR_C = -60
const COLD_NEIGHBOURS = 4
const COLD_GREY_PASSES = 8

/**
 * The temperature of a blended pixel p: of the on-ramp 8-neighbours (and
 * pairs of them), the mix whose colour comes closest to p's, at the same mix
 * of their temperatures. Its own decode when it has no such neighbour. The
 * fit's RGB distance is left in unmixError.
 */
let unmixError = 0
function unmix(
  rgba: ArrayLike<number>,
  temps: Float32Array,
  isBlend: Uint8Array,
  w: number,
  h: number,
  p: number
): number {
  const x = p % w
  const y = (p - x) / w
  const i = p * 4
  const r = rgba[i]
  const g = rgba[i + 1]
  const b = rgba[i + 2]
  const near: number[] = []
  for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
    for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
      const q = yy * w + xx
      if (!isBlend[q] && !Number.isNaN(temps[q])) near.push(q)
    }
  }
  let best = Infinity
  let temp = temps[p]
  for (let a = 0; a < near.length; a++) {
    const qa = near[a] * 4
    const ra = rgba[qa]
    const ga = rgba[qa + 1]
    const ba = rgba[qa + 2]
    const ta = temps[near[a]]
    for (let c = a; c < near.length; c++) {
      const qc = near[c] * 4
      const dr = rgba[qc] - ra
      const dg = rgba[qc + 1] - ga
      const db = rgba[qc + 2] - ba
      const len2 = dr * dr + dg * dg + db * db
      const u = len2 ? Math.max(0, Math.min(1, ((r - ra) * dr + (g - ga) * dg + (b - ba) * db) / len2)) : 0
      const er = ra + u * dr - r
      const eg = ga + u * dg - g
      const eb = ba + u * db - b
      const d = er * er + eg * eg + eb * eb
      if (d < best) {
        best = d
        temp = ta + u * (temps[near[c]] - ta)
      }
    }
  }
  unmixError = Math.sqrt(best)
  return temp
}

/**
 * Decodes a w x h RGBA IR mosaic into °C, NaN where there's no data. Edge
 * pixels GIBS blended with transparency count as no data, since the blend
 * darkens (warms) them. Greys that could be either ramp are read as cold when a
 * neighbour is already colder than COLD_NEIGHBOUR_C, spreading a few pixels
 * inward through the core of a cold cluster. Blends of two runs are unmixed
 * from their neighbours.
 */
export function decodeIr(rgba: ArrayLike<number>, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const { distance } = getColourLut()
  const ambiguous: number[] = []
  const blends: number[] = []
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    if (rgba[i + 3] < 255) {
      out[p] = NaN
      continue
    }
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    const t = irTemperature(r, g, b)
    out[p] = t
    if (isGrey(r, g, b)) {
      const v = (r + g + b) / 3
      if (v >= COLD_GREY_LOW && v <= WARM_GREY_SLACK) ambiguous.push(p)
    } else if (distance[lutIndex(r, g, b)] > BLEND_DISTANCE || t > ON_WARM_GREY_C) {
      blends.push(p)
    }
  }
  const isBlend = new Uint8Array(w * h)
  for (const p of blends) isBlend[p] = 1
  // Each pass decides from the previous pass's result, so a flip can't cascade
  // along a scanline through a warm area.
  const flips: number[] = []
  for (let pass = 0; pass < COLD_GREY_PASSES && ambiguous.length; pass++) {
    let kept = 0
    flips.length = 0
    for (const p of ambiguous) {
      const x = p % w
      const y = (p - x) / w
      let cold = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue
          if (out[yy * w + xx] < COLD_NEIGHBOUR_C) cold++
        }
      }
      if (cold >= COLD_NEIGHBOURS) flips.push(p)
      else ambiguous[kept++] = p
    }
    ambiguous.length = kept
    if (!flips.length) break
    for (const p of flips) {
      const i = p * 4
      out[p] = coldGreyTemperature((rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3)
    }
  }
  // Where a blend of three or more runs leaves no good pair of on-ramp
  // neighbours, a second pass also draws on the blends that did fit.
  const poor: number[] = []
  const unmixed = blends.map((p) => {
    const t = unmix(rgba, out, isBlend, w, h, p)
    if (unmixError > BLEND_DISTANCE) poor.push(p)
    return t
  })
  blends.forEach((p, k) => {
    out[p] = unmixed[k]
    isBlend[p] = 0
  })
  for (const p of poor) isBlend[p] = 1
  const refit = poor.map((p) => unmix(rgba, out, isBlend, w, h, p))
  poor.forEach((p, k) => (out[p] = refit[k]))
  return out
}

/**
 * Fills, in place, each missing pixel of an OUT_W-wide mosaic (decodeIr's
 * NaN, visibleGrey's 0) that has data either side of it in x, wrapping across
 * 180°, with their mean. GIBS draws Himawari's last column before the
 * antimeridian (179.86°E) about seven-eighths opaque in both bands, which
 * decodes as no data, so without this Himawari dropped out of that one column
 * and left a seam down the Pacific (tides-uwv). Wider gaps, and the limbs,
 * stay missing.
 */
export function bridgeGaps<T extends Float32Array | Uint8Array>(
  values: T,
  missing: (v: number) => boolean
): T {
  for (let row = 0; row < values.length; row += OUT_W) {
    for (let x = 0; x < OUT_W; x++) {
      if (!missing(values[row + x])) continue
      const west = values[row + ((x - 1 + OUT_W) % OUT_W)]
      const east = values[row + ((x + 1) % OUT_W)]
      if (!missing(west) && !missing(east)) values[row + x] = (west + east) / 2
    }
  }
  return values
}

// --- Sun ------------------------------------------------------------------

/** Subsolar latitude/longitude (degrees) from the NOAA low-precision solar
 * position (within ~0.5°, plenty for a day/night weight). */
export function subsolarPoint(ms: number): { lat: number; lon: number } {
  const d = ms / DAY_MS - 10957.5 // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * DEG
  const q = 280.459 + 0.98564736 * d
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG
  const e = (23.439 - 0.00000036 * d) * DEG
  const dec = Math.asin(Math.sin(e) * Math.sin(l))
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l)) / DEG
  const eqTimeDeg = ((((q - ra) % 360) + 540) % 360) - 180
  const utcHours = (((ms % DAY_MS) + DAY_MS) % DAY_MS) / 3_600_000
  const lon = ((((180 - utcHours * 15 - eqTimeDeg) % 360) + 540) % 360) - 180
  return { lat: dec / DEG, lon }
}

/** Cosine of the solar zenith angle at a point. */
export function cosSunZenith(latDeg: number, lonDeg: number, sun: { lat: number; lon: number }): number {
  return (
    Math.sin(latDeg * DEG) * Math.sin(sun.lat * DEG) +
    Math.cos(latDeg * DEG) * Math.cos(sun.lat * DEG) * Math.cos((lonDeg - sun.lon) * DEG)
  )
}

// --- Clear-sky reference ---------------------------------------------------

/** Terrain from the static textures, one byte per output pixel. */
export interface Terrain {
  /** The bump map's grey, linear in elevation (ELEVATION_KM_PER_LEVEL). */
  elevation: ArrayLike<number>
  /** Nonzero on land. */
  land: ArrayLike<number>
}

// earth-bump: Tibet ~180, the Altiplano ~148, Greenland ~116, Colorado ~60.
export const ELEVATION_KM_PER_LEVEL = 1 / 39
export const LAPSE_RATE_C_PER_KM = 6.5

function lapse(terrain: Terrain | null, p: number): number {
  return terrain ? LAPSE_RATE_C_PER_KM * ELEVATION_KM_PER_LEVEL * terrain.elevation[p] : 0
}

function percentile(values: number[], f: number): number {
  values.sort((a, b) => a - b)
  return values[Math.floor(f * (values.length - 1))]
}

/** Pixels within this view angle set the clear-sky reference. */
const REFERENCE_MAX_ANGLE = 65
const REFERENCE_PERCENTILE = 0.9
const REFERENCE_MIN_SAMPLES = 40
const REFERENCE_SMOOTH_ROWS = 8

/**
 * Clear-sky sea-level brightness temperature per output row: the warm end
 * (90th percentile) of the open sea the satellites see along that latitude,
 * smoothed over ±REFERENCE_SMOOTH_ROWS. Along any latitude most of the ~250°
 * the disks span is clear somewhere. Rows without enough sea use land too
 * (reduced to sea level); rows with too few samples copy the nearest row that
 * has them.
 */
export function rowReference(
  temps: readonly (Float32Array | null)[],
  terrain: Terrain | null
): Float32Array {
  const raw = new Float32Array(OUT_H).fill(NaN)
  const cosLimit = Math.cos(REFERENCE_MAX_ANGLE * DEG)
  const sea: number[] = []
  const all: number[] = []
  for (let y = 0; y < OUT_H; y++) {
    const cosLat = Math.cos(pixelLat(y) * DEG)
    // cos(angle) = cos(lat) cos(dLon) > cosLimit bounds dLon.
    if (cosLat <= cosLimit) continue
    const maxDLon = Math.acos(cosLimit / cosLat) / DEG
    sea.length = 0
    all.length = 0
    GEO_SATELLITES.forEach((sat, s) => {
      const t = temps[s]
      if (!t) return
      const x0 = Math.floor(((sat.lon - maxDLon + 180) / 360) * OUT_W)
      const x1 = Math.ceil(((sat.lon + maxDLon + 180) / 360) * OUT_W)
      for (let xx = x0; xx <= x1; xx++) {
        const p = y * OUT_W + (((xx % OUT_W) + OUT_W) % OUT_W)
        const v = t[p]
        if (Number.isNaN(v)) continue
        if (!terrain?.land[p]) sea.push(v)
        all.push(v + lapse(terrain, p))
      }
    })
    const values = sea.length >= REFERENCE_MIN_SAMPLES ? sea : all
    if (values.length >= REFERENCE_MIN_SAMPLES) raw[y] = percentile(values, REFERENCE_PERCENTILE)
  }
  const first = raw.findIndex((v) => !Number.isNaN(v))
  if (first < 0) return raw.fill(0)
  for (let y = 0; y < first; y++) raw[y] = raw[first]
  for (let y = first + 1; y < OUT_H; y++) if (Number.isNaN(raw[y])) raw[y] = raw[y - 1]
  const out = new Float32Array(OUT_H)
  for (let y = 0; y < OUT_H; y++) {
    let sum = 0
    let n = 0
    for (let k = -REFERENCE_SMOOTH_ROWS; k <= REFERENCE_SMOOTH_ROWS; k++) {
      const yy = y + k
      if (yy < 0 || yy >= OUT_H) continue
      sum += raw[yy]
      n++
    }
    out[y] = sum / n
  }
  return out
}

// Land at night can be 10-20 K colder than the sea at its latitude, which
// would read as a veil of cloud over every continent. So over land the
// reference also follows the warmest land nearby, reduced to sea level so
// plateaus compare fairly: the max over WARM_CELL px cells, spread to the
// neighbouring cells. That only ever lowers the reference, by at most
// LAND_COOL_MAX, which keeps a deck covering a whole cell visible.
export const WARM_CELL = 16
const WARM_COLS = OUT_W / WARM_CELL
const WARM_ROWS = OUT_H / WARM_CELL
export const LAND_MARGIN = 4
export const LAND_COOL_MAX = 20

/** Per WARM_CELL cell, the warmest sea-level land temperature within a cell
 * of it; Infinity where it sees no land. */
export function landWarmGrid(t: Float32Array, satLon: number, terrain: Terrain): Float32Array {
  const cells = new Float32Array(WARM_COLS * WARM_ROWS).fill(-Infinity)
  for (let y = 0; y < OUT_H; y++) {
    const lat = pixelLat(y)
    const row = Math.floor(y / WARM_CELL) * WARM_COLS
    for (let x = 0, p = y * OUT_W; x < OUT_W; x++, p++) {
      const v = t[p]
      if (!terrain.land[p] || Number.isNaN(v)) continue
      if (viewAngle(lat, pixelLon(x), satLon) > GEO_ZERO_DEG) continue
      const c = row + Math.floor(x / WARM_CELL)
      cells[c] = Math.max(cells[c], v + lapse(terrain, p))
    }
  }
  const out = new Float32Array(cells.length)
  for (let cy = 0; cy < WARM_ROWS; cy++) {
    for (let cx = 0; cx < WARM_COLS; cx++) {
      let m = -Infinity
      for (let yy = Math.max(0, cy - 1); yy <= Math.min(WARM_ROWS - 1, cy + 1); yy++) {
        for (let dx = -1; dx <= 1; dx++) {
          m = Math.max(m, cells[yy * WARM_COLS + ((cx + dx + WARM_COLS) % WARM_COLS)])
        }
      }
      out[cy * WARM_COLS + cx] = m === -Infinity ? Infinity : m
    }
  }
  return out
}

/** Clear-sky brightness temperature (°C) at pixel (x, y). rows is
 * rowReference; warm the satellite's landWarmGrid, or null without terrain. */
export function referenceAt(
  rows: Float32Array,
  terrain: Terrain | null,
  warm: Float32Array | null,
  x: number,
  y: number
): number {
  const p = y * OUT_W + x
  const sea = rows[y]
  if (!terrain || !warm || !terrain.land[p]) return sea - lapse(terrain, p)
  // Bilinear between cell centres; cells that see no land count as the sea.
  const gx = (x + 0.5) / WARM_CELL - 0.5
  const gy = Math.min(WARM_ROWS - 1, Math.max(0, (y + 0.5) / WARM_CELL - 0.5))
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const y1 = Math.min(WARM_ROWS - 1, y0 + 1)
  const fx = gx - x0
  const fy = gy - y0
  const at = (cx: number, cy: number) => {
    const v = warm[cy * WARM_COLS + ((cx + WARM_COLS) % WARM_COLS)]
    return v === Infinity ? sea : v
  }
  const local =
    (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) +
    (at(x0, y1) * (1 - fx) + at(x0 + 1, y1) * fx) * fy
  return Math.min(sea, Math.max(local + LAND_MARGIN, sea - LAND_COOL_MAX)) - lapse(terrain, p)
}

// --- Cloud alpha from IR ---------------------------------------------------

// A pixel this much colder than the clear-sky reference starts to show cloud
// and is opaque at OPAQUE_DT: low cloud is only a few K colder than the sea
// below it, deep convection 60-90 K. The ramp eases out, so mid-level cloud
// is about as opaque as a linear ramp to 30 K made it, but frontal and
// convective cloud keeps the structure of its tops up to OPAQUE_DT instead
// of saturating into flat white (tides-9jn.3).
export const CLEAR_DT = 5
export const OPAQUE_DT = 45
// Anything this cold is cloud whatever the reference, which can sit low where
// a latitude is mostly cloud. Ice sheets this cold are past GEO_ZERO_DEG.
export const COLD_CLEAR_C = -25
export const COLD_OPAQUE_C = -60

/** 0..1 cloud alpha from a brightness temperature and the clear-sky
 * reference (°C). */
export function irCloudAlpha(t: number, reference: number): number {
  const x = Math.min(1, Math.max(0, (reference - t - CLEAR_DT) / (OPAQUE_DT - CLEAR_DT)))
  return Math.max(1 - (1 - x) * (1 - x), smoothstep(COLD_CLEAR_C, COLD_OPAQUE_C, t))
}

// Cloud-top height above the ground from how far the top is below the clear
// sky's temperature, at the standard lapse rate, capped near the tropical
// tropopause.
export const MAX_CLOUD_TOP_KM = 16

export function cloudTopKm(t: number, reference: number): number {
  return Math.min(MAX_CLOUD_TOP_KM, Math.max(0, (reference - t) / LAPSE_RATE_C_PER_KM))
}

// --- Visible -----------------------------------------------------------------

// IR can't tell low cloud from the sea a few K warmer below it, so by day the
// red visible band adds it. The GIBS visible layers are scaled differently per
// satellite and aren't normalised for the sun, so each image is calibrated
// against its own IR: in bins of the sun's height, the typical brightness of
// pixels IR says are clear, and of pixels IR says are thick cold cloud.
export const VIS_BINS = 8
export const VIS_MIN_MU = 0.1
const VIS_MIN_SAMPLES = 30
const VIS_SAMPLE_STEP = 3
const VIS_CLEAR_DT = 1
const VIS_THICK_C = -40
const VIS_THICK_PERCENTILE = 0.8
// Opaque a little short of the brightness of thick cold cloud. At 0.6 most
// stratocumulus and frontal cloud saturated into flat white; nearer the full
// span it keeps the texture the visible shows, and the curve keeps
// moderately bright cloud looking like cloud rather than haze (tides-9jn.3).
export const VIS_OPAQUE_FRACTION = 0.85
export const VIS_GAMMA = 0.6
// By day IR alpha is thinned where the visible is darker than thick cloud, by
// up to this much, so cold cloud takes its texture from the visible too
// rather than staying as flat as its IR.
export const IR_DAY_TEXTURE = 0.35
// Daylight fades the visible in toward a higher sun.
export const VIS_DAY_FROM = 0.15
export const VIS_DAY_TO = 0.35
// Visible counts only where IR is at least a little colder than clear sky, so
// sunglint and bright desert (both warm) never become cloud.
export const VIS_GATE_FROM_DT = 0
export const VIS_GATE_TO_DT = 4

export interface VisCalibration {
  /** Per sun-height bin, brightness (0..255) of clear and of thick cloud. */
  clear: Float32Array
  cloud: Float32Array
}

export function muBin(mu: number): number {
  return Math.min(
    VIS_BINS - 1,
    Math.max(0, Math.floor(((mu - VIS_MIN_MU) / (1 - VIS_MIN_MU)) * VIS_BINS))
  )
}

/** Fills bins with too few samples from the nearest bin that has them; null
 * when none do. */
function fillBins(values: (number | null)[]): Float32Array | null {
  if (values.every((v) => v === null)) return null
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) {
    let best: number | null = null
    for (let d = 0; best === null; d++) best = values[i - d] ?? values[i + d] ?? null
    out[i] = best
  }
  return out
}

/** Visible brightness per output pixel from an RGBA grey mosaic; 0 where
 * there's no data. */
export function visibleGrey(rgba: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(rgba.length / 4)
  for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = rgba[i + 3] === 255 ? rgba[i] : 0
  return out
}

/** One satellite's visible (visibleGrey) against its decoded IR; reference
 * gives the clear-sky temperature at (x, y). Null when the image has too
 * little daylight to calibrate. */
export function calibrateVisible(
  vis: ArrayLike<number>,
  temps: Float32Array,
  reference: (x: number, y: number) => number,
  satLon: number,
  sun: { lat: number; lon: number }
): VisCalibration | null {
  const clear: number[][] = Array.from({ length: VIS_BINS }, () => [])
  const cloud: number[][] = Array.from({ length: VIS_BINS }, () => [])
  for (let y = 0; y < OUT_H; y += VIS_SAMPLE_STEP) {
    const lat = pixelLat(y)
    for (let x = 0; x < OUT_W; x += VIS_SAMPLE_STEP) {
      const p = y * OUT_W + x
      const t = temps[p]
      if (Number.isNaN(t) || vis[p] === 0) continue
      const lon = pixelLon(x)
      if (viewAngle(lat, lon, satLon) > GEO_FULL_DEG) continue
      const mu = cosSunZenith(lat, lon, sun)
      if (mu < VIS_MIN_MU) continue
      if (t < VIS_THICK_C) cloud[muBin(mu)].push(vis[p])
      else if (reference(x, y) - t < VIS_CLEAR_DT) clear[muBin(mu)].push(vis[p])
    }
  }
  const pick = (bins: number[][], f: number) =>
    fillBins(bins.map((b) => (b.length >= VIS_MIN_SAMPLES ? percentile(b, f) : null)))
  const c = pick(clear, 0.5)
  const k = pick(cloud, VIS_THICK_PERCENTILE)
  if (!c || !k) return null
  // Thick cloud can't get darker as the sun gets higher, and is at least as
  // bright as a higher sun's in proportion to mu, which a bin whose cold
  // pixels are mostly thin cirrus would otherwise undercut (GOES-West at
  // 2026-10-18 18Z, 50°S: 162 at mu 0.7 against 220 at 0.83), saturating
  // its stratocumulus.
  const mid = (b: number) => VIS_MIN_MU + ((b + 0.5) / VIS_BINS) * (1 - VIS_MIN_MU)
  for (let b = VIS_BINS - 2; b >= 0; b--) k[b] = Math.max(k[b], (k[b + 1] * mid(b)) / mid(b + 1))
  return { clear: c, cloud: k }
}

/** 0..1 visible brightness from clear sky to thick cloud. */
export function visBrightness(v: number, mu: number, cal: VisCalibration): number {
  // Linear between bin centres: stepping from bin to bin drew arcs of
  // constant sun height across the clouds.
  const f = Math.min(
    VIS_BINS - 1,
    Math.max(0, ((mu - VIS_MIN_MU) / (1 - VIS_MIN_MU)) * VIS_BINS - 0.5)
  )
  const b = Math.min(VIS_BINS - 2, Math.floor(f))
  const u = f - b
  const clear = cal.clear[b] + u * (cal.clear[b + 1] - cal.clear[b])
  const cloud = cal.cloud[b] + u * (cal.cloud[b + 1] - cal.cloud[b])
  return Math.min(1, Math.max(0, (v - clear) / Math.max(20, cloud - clear)))
}

/** 0..1 cloud alpha from visible brightness, by day only, gated by IR. The
 * composite passes as t the pixel's temperature or, if colder, that of the
 * cloud on two sides of it, so a single warm IR pixel in a field of cumulus
 * doesn't cut a hole in it. */
export function visCloudAlpha(
  v: number,
  mu: number,
  t: number,
  reference: number,
  cal: VisCalibration
): number {
  if (mu < VIS_DAY_FROM) return 0
  const x = Math.min(1, visBrightness(v, mu, cal) / VIS_OPAQUE_FRACTION)
  return (
    x ** VIS_GAMMA *
    smoothstep(VIS_DAY_FROM, VIS_DAY_TO, mu) *
    smoothstep(VIS_GATE_FROM_DT, VIS_GATE_TO_DT, reference - t)
  )
}

/** IR alpha thinned by day where the visible is darker than thick cloud. */
export function irDayAlpha(irAlpha: number, v: number, mu: number, cal: VisCalibration): number {
  if (mu < VIS_DAY_FROM) return irAlpha
  const day = smoothstep(VIS_DAY_FROM, VIS_DAY_TO, mu)
  return irAlpha * (1 - day * IR_DAY_TEXTURE * (1 - visBrightness(v, mu, cal)))
}

// --- Composite -------------------------------------------------------------

/** t0, the temperature at (x, y), or the second coldest of its 4 neighbours
 * (wrapping in x) if colder: a warm pixel with cloud on two sides is a gap
 * the IR resolution missed, while one beside a lone cumulus or along a
 * cloud's straight edge is not. */
function gateTemperature(t: Float32Array, x: number, y: number, t0: number): number {
  let first = Infinity
  let second = Infinity
  const take = (v: number) => {
    if (v < first) {
      second = first
      first = v
    } else if (v < second) {
      second = v
    }
  }
  const o = y * OUT_W
  take(t[o + ((x + 1) % OUT_W)])
  take(t[o + ((x - 1 + OUT_W) % OUT_W)])
  if (y > 0) take(t[o - OUT_W + x])
  if (y < OUT_H - 1) take(t[o + OUT_W + x])
  return second < t0 ? second : t0
}

export interface GeoImagery {
  /** Per GEO_SATELLITES entry, decoded IR (°C, NaN for no data), or null
   * when that satellite's imagery couldn't be had. */
  temps: readonly (Float32Array | null)[]
  /** Per GEO_SATELLITES entry, visibleGrey of its visible mosaic, or null. */
  vis: readonly (ArrayLike<number> | null)[]
  /** Scan time, for the sun. */
  timeMs: number
}

/**
 * Writes the cloud texture into out (RGBA, OUT_W x OUT_H):
 * - G: cloud alpha, which the cloud material reads. Geostationary where a
 *   satellite sees well, crossfading by view angle between satellites and
 *   into `fallback` (RGBA whose G is the daily composite's alpha) toward the
 *   disks' limbs and beyond them.
 * - R: cloud-top height above the ground, 0..MAX_CLOUD_TOP_KM as 0..255, from
 *   IR; 0 where no satellite sees.
 * - B: how much of the pixel is geostationary (0..255), i.e. how far R and the
 *   time match can be trusted.
 * - A: 255.
 * terrain (null skips the land and elevation corrections) comes from the
 * static textures. out may alias fallback.
 */
export function composeGeoClouds(
  { temps, vis, timeMs }: GeoImagery,
  terrain: Terrain | null,
  fallback: ArrayLike<number>,
  out: { [index: number]: number; length: number }
): void {
  const rows = rowReference(temps, terrain)
  const sun = subsolarPoint(timeMs)
  const sats = GEO_SATELLITES.flatMap((sat, s) => {
    const t = temps[s]
    if (!t) return []
    const warm = terrain ? landWarmGrid(t, sat.lon, terrain) : null
    const v = vis[s]
    const cal = v
      ? calibrateVisible(v, t, (x, y) => referenceAt(rows, terrain, warm, x, y), sat.lon, sun)
      : null
    const cosDLon = new Float64Array(OUT_W)
    for (let x = 0; x < OUT_W; x++) cosDLon[x] = Math.cos((pixelLon(x) - sat.lon) * DEG)
    return [{ t, warm, vis: cal ? v : null, cal, cosDLon }]
  })
  const sinSun = Math.sin(sun.lat * DEG)
  const cosSun = Math.cos(sun.lat * DEG)
  const cosDLonSun = new Float64Array(OUT_W)
  for (let x = 0; x < OUT_W; x++) cosDLonSun[x] = Math.cos((pixelLon(x) - sun.lon) * DEG)
  for (let y = 0; y < OUT_H; y++) {
    const lat = pixelLat(y) * DEG
    const cosLat = Math.cos(lat)
    const sinLat = Math.sin(lat)
    for (let x = 0, p = y * OUT_W, i = p * 4; x < OUT_W; x++, p++, i += 4) {
      const mu = sinLat * sinSun + cosLat * cosSun * cosDLonSun[x]
      let uncovered = 1
      let weights = 0
      let alpha = 0
      let height = 0
      for (const sat of sats) {
        const t = sat.t[p]
        if (Number.isNaN(t)) continue
        const angle = Math.acos(cosLat * sat.cosDLon[x]) / DEG
        const c = viewCoverage(angle)
        if (c <= 0) continue
        const ref = referenceAt(rows, terrain, sat.warm, x, y)
        let a = irCloudAlpha(t, ref)
        const v = sat.vis?.[p]
        if (v && mu >= VIS_DAY_FROM) {
          a = Math.max(
            irDayAlpha(a, v, mu, sat.cal!),
            visCloudAlpha(v, mu, gateTemperature(sat.t, x, y, t), ref, sat.cal!)
          )
        }
        const w = viewWeight(angle)
        uncovered *= 1 - c
        weights += w
        alpha += w * a
        height += w * a * cloudTopKm(t, ref)
      }
      // Two partial views of a point are better than either.
      const coverage = 1 - uncovered
      const geoAlpha = weights > 0 ? alpha / weights : 0
      out[i] = alpha > 0 ? (255 * height) / alpha / MAX_CLOUD_TOP_KM : 0
      out[i + 1] = 255 * (coverage * geoAlpha + (1 - coverage) * (fallback[i + 1] / 255))
      out[i + 2] = 255 * coverage
      out[i + 3] = 255
    }
  }
}
