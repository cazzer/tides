// Date-matched clouds from NASA GIBS true-colour imagery (tides-l3s; spike
// findings in tides-pdu). A false-colour layer from the same instrument is
// only a mask for seasonal snow and sea ice (tides-6bh). No-data gaps are
// filled from the previous day before falling back to the static clouds
// (tides-2t9), feathered rather than cut (tides-g29), and sunglint is taken
// out over the sea (tides-a7w). Within the last ~90 days geostationary imagery
// matched to the sim time goes over the top (tides-1zj, geo-clouds.ts). Pure
// logic only:
// which layers, days and slots there are, the tile URLs, the gap fill and the
// cloud-alpha maths. Which of them to show when is ../cloud-frames.ts; the
// browser side lives in renderers/cloudPipeline.ts.

export const DAY_MS = 86_400_000

// Daily true-colour composites of daytime passes, each paired with the same
// instrument's false colour, where snow and ice are cyan and cloud is white.
// Ranges from the GIBS capabilities document (2026-10-18), the same for both
// layers of a pair. WMTS 404s outside them, so the client checks the date
// itself.
export const VIIRS_FROM = Date.UTC(2015, 10, 24)
export const MODIS_FROM = Date.UTC(2000, 1, 24)
const VIIRS = {
  layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
  snowLayer: 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1',
} as const
const MODIS = {
  layer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
  snowLayer: 'MODIS_Terra_CorrectedReflectance_Bands721',
} as const
export type SnowLayer = typeof VIIRS.snowLayer | typeof MODIS.snowLayer

// WMTS level 2 of the EPSG:4326 "250m" matrix is 5x3 tiles of 512px, 72 deg
// each, for both layers of a pair. The globe is the top-left 2560x1280, so the
// bottom tile row only contributes its top 256px. Same equirectangular layout
// as the static clouds.
export const TILE = 512
export const COLS = 5
export const ROWS = 3
export const OUT_W = 2560
export const OUT_H = 1280

// GIBS tile latency ranged from 1 s to over 280 s during the spike, so a slow
// tile gets one retry and is then dropped; its area keeps the static clouds.
export const TILE_TIMEOUT_MS = 60_000

export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

export function utcDayKey(ms: number): string {
  return new Date(utcDay(ms)).toISOString().slice(0, 10)
}

export type GibsSource = { kind: 'gibs'; layer: string; snowLayer: SnowLayer; date: string }
/** Geostationary imagery at a 10-minute slot (tides-1zj, geo-clouds.ts), over
 * the daily composite where the satellites don't see. */
export type GeoSource = { kind: 'geo'; time: string; fallback: GibsSource }
export type CloudSource =
  | { kind: 'static'; reason: 'before-coverage' | 'after-latest' }
  | GibsSource
  | GeoSource

// Geostationary full disks come every 10 minutes. GIBS keeps a rolling ~90
// days (older times 404 although DescribeDomains lists them) and publishes
// 20-35 minutes after the scan.
const MINUTE_MS = 60_000
export const GEO_SLOT_MS = 10 * MINUTE_MS
export const GEO_ARCHIVE_MS = 89 * DAY_MS
export const GEO_LATENCY_MS = 40 * MINUTE_MS

export function geoSlot(ms: number): number {
  return Math.floor(ms / GEO_SLOT_MS) * GEO_SLOT_MS
}

/** WMTS time for a slot, e.g. 2026-10-18T00:10:00Z. */
export function geoTimeKey(ms: number): string {
  return new Date(geoSlot(ms)).toISOString().slice(0, 19) + 'Z'
}

/** The slot to show for a sim time, or null outside the archive. Times after
 * the latest published slot (the present, or later today) show that one. */
export function selectGeoSlot(simMs: number, nowMs: number): number | null {
  const slot = Math.min(geoSlot(simMs), geoSlot(nowMs - GEO_LATENCY_MS))
  return slot < nowMs - GEO_ARCHIVE_MS ? null : slot
}

/** The daily composite alone; see selectRealCloudSource for what Real
 * weather shows. */
export function selectCloudSource(simMs: number, nowMs: number): CloudSource {
  const today = utcDay(nowMs)
  // Today's composite is still filling in, so yesterday is the latest whole
  // day; today shows it rather than the static clouds (tides-x2f).
  const latest = today - DAY_MS
  const simDay = utcDay(simMs)
  if (simDay > today) return { kind: 'static', reason: 'after-latest' }
  const day = Math.min(simDay, latest)
  const date = utcDayKey(day)
  if (day >= VIIRS_FROM) return { kind: 'gibs', ...VIIRS, date }
  if (day >= MODIS_FROM) return { kind: 'gibs', ...MODIS, date }
  return { kind: 'static', reason: 'before-coverage' }
}

/** Geostationary imagery for the sim time's 10-minute slot within the
 * archive, over the daily composite; the daily composite alone outside it. */
export function selectRealCloudSource(simMs: number, nowMs: number): CloudSource {
  const daily = selectCloudSource(simMs, nowMs)
  if (daily.kind !== 'gibs') return daily
  const slot = selectGeoSlot(simMs, nowMs)
  return slot === null ? daily : { kind: 'geo', time: geoTimeKey(slot), fallback: daily }
}

/** True when the sim time is today and shows the latest imagery instead: the
 * latest whole day, or the latest published geostationary slot. */
export function isLatestStandIn(source: CloudSource | null, simMs: number, nowMs: number): boolean {
  if (source?.kind === 'geo') {
    return utcDay(simMs) === utcDay(nowMs) && Date.parse(source.time) < geoSlot(simMs)
  }
  return (
    source?.kind === 'gibs' &&
    utcDay(simMs) === utcDay(nowMs) &&
    source.date !== utcDayKey(simMs)
  )
}

/** The day before the source's, to fill its gaps from; null before the layer's
 * coverage. */
export function fillDate(source: GibsSource): string | null {
  const day = Date.parse(source.date) - DAY_MS
  const from = source.layer === VIIRS.layer ? VIIRS_FROM : MODIS_FROM
  return day < from ? null : utcDayKey(day)
}

/** snowLayer follows from layer, so it isn't part of the key. */
export function sourceKey(source: CloudSource): string {
  if (source.kind === 'static') return `static:${source.reason}`
  if (source.kind === 'geo') return `geo/${source.time}/${sourceKey(source.fallback)}`
  return `${source.layer}/${source.date}`
}

/** Row-major, top row first. */
export function tileUrls(layer: string, date: string): string[] {
  const urls: string[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      urls.push(
        `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/${layer}/default/${date}/250m/2/${row}/${col}.jpg`
      )
    }
  }
  return urls
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** GIBS fills areas without data with black; JPEG noise lifts it a little. */
function isNoData(r: number, g: number, b: number): boolean {
  return Math.max(r, g, b) < 12
}

function saturation(max: number, min: number): number {
  return max === 0 ? 0 : (max - min) / max
}

/** Cloud = bright and not warm: min(r,g,b) rejects ocean and vegetation, and
 * is dimmed by how far red or green beats blue past a slight warm tint, which
 * rejects desert and dry land. A blue tint is ocean through thin cloud, so it
 * isn't penalised unless it is strong enough to be shallow water. The ramp is
 * linear so thin cloud and cloud edges keep partial alpha.
 * Calibrated on 2024-01-15 and 2023-09-20 (VIIRS) and 2010-01-15 (MODIS).
 * 0..255. */
export function cloudAlpha(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const rg = Math.max(r, g)
  const warmth = rg > b ? (rg - b) / rg : 0
  const v = (min / 255) * Math.max(0, 1 - 3.5 * Math.max(0, warmth - 0.05))
  return (
    255 *
    Math.min(1, Math.max(0, (v - 0.28) / (0.85 - 0.28))) *
    (1 - smoothstep(0.25, 0.4, saturation(max, min)))
  )
}

/** 0..1 land-ice weight from the static specular (water is bright) and day
 * textures: bright, colourless land is ice sheet, which true colour can't tell
 * from cloud. */
export function iceWeight(spec: number, r: number, g: number, b: number): number {
  if (spec >= 128) return 0
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return (
    smoothstep(0.55, 0.8, min / 255) *
    (1 - smoothstep(0.08, 0.2, saturation(max, min)))
  )
}

// Calibrated on 2024-01-15 (VIIRS) and 2010-01-15 (MODIS) samples; 7-2-1
// renders ice cloud much more cyan than VIIRS does.
export const SNOW_EDGES: Record<SnowLayer, readonly [number, number]> = {
  [VIIRS.snowLayer]: [60, 110],
  [MODIS.snowLayer]: [110, 160],
}

/** 0..1 snow/ice weight from a false-colour pixel: how much cyan beats red.
 * min(g,b) because blue drops out on vegetation; an absolute difference
 * because a ratio also removed cloud over ocean. */
export function snowWeight(
  r: number,
  g: number,
  b: number,
  [lo, hi]: readonly [number, number]
): number {
  if (isNoData(r, g, b)) return 0
  return smoothstep(lo, hi, Math.min(g, b) - r)
}

// Complete days have at most 0.06% no-data per column within ±45°, real gaps
// at least 4.8%.
export const FILL_GAP_FRACTION = 0.002

/**
 * Which tiles (row-major, like tileUrls) to fetch from fillDate: every row of a
 * 512px column with gaps, and any tile whose primary true colour failed. gibs
 * is the RGBA true-colour mosaic. Passes run pole to pole, so a gap spans the
 * whole column; only ±45° is counted because polar night is no-data on
 * complete days but never reaches that band. Failed tiles are left out of the
 * count, since they are filled on their own.
 */
export function tilesToFill(gibs: ArrayLike<number>, failed: readonly boolean[]): boolean[] {
  const wanted = failed.slice(0, COLS * ROWS)
  for (let col = 0; col < COLS; col++) {
    let gaps = 0
    let counted = 0
    for (let y = OUT_H / 4; y < (3 * OUT_H) / 4; y++) {
      if (failed[Math.floor(y / TILE) * COLS + col]) continue
      counted += TILE
      for (let x = col * TILE, i = (y * OUT_W + x) * 4; x < (col + 1) * TILE; x++, i += 4) {
        if (isNoData(gibs[i], gibs[i + 1], gibs[i + 2])) gaps++
      }
    }
    if (counted > 0 && gaps / counted > FILL_GAP_FRACTION) {
      for (let row = 0; row < ROWS; row++) wanted[row * COLS + col] = true
    }
  }
  return wanted
}

// JPEG ringing and resampling darken the pixels next to a gap (half brightness
// 1 px out, still dimmed 2 px out), which would read as a clear line along the
// seam with the fill day or the static clouds.
export const NO_DATA_GROW = 2

// Dark open ocean (high latitudes, low sun) has the odd pixel under the
// no-data threshold. Those aren't gaps (tides-9jn.3: grown, each let the
// static clouds through as a sharp 5 px square); a real gap is at least 3 px
// across, so only no-data pixels whose whole 3x3 neighbourhood is no-data
// start one.
/** What a stray dark pixel is lifted to: the darkest data. */
const NO_DATA_LIFT = 12

/**
 * Blackens the RGB of every pixel within NO_DATA_GROW px (a square) of a
 * no-data gap in a w x h RGBA image, so the fill and static fallback cover
 * the darkened rim too. A gap is no-data at least 3 px across; stray no-data
 * pixels outside one are dark data, and are lifted just above the no-data
 * threshold so nothing downstream takes them for a gap. Failed tiles
 * (row-major, like tileUrls) don't seed and aren't lifted: their edges are
 * clean, and the fill only writes inside them. Alpha bytes are left alone.
 */
export function growNoData(
  rgba: { [index: number]: number; length: number },
  w: number,
  h: number,
  failed: readonly boolean[] = []
): void {
  const noData = new Uint8Array(w * h)
  for (let y = 0, p = 0; y < h; y++) {
    const tileRow = Math.floor(y / TILE) * COLS
    for (let x = 0; x < w; x++, p++) {
      if (failed[tileRow + Math.floor(x / TILE)]) continue
      if (isNoData(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2])) noData[p] = 1
    }
  }
  // Seeds are the 3x3 erosion of noData; growing them by NO_DATA_GROW + 1
  // covers the gap and NO_DATA_GROW px around it. Separable: spread along
  // rows, then along columns.
  const reach = NO_DATA_GROW + 1
  const rows = new Uint8Array(w * h)
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (!noData[p]) continue
      let seed = true
      for (let yy = Math.max(0, y - 1); seed && yy <= Math.min(h - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          if (!noData[yy * w + xx]) {
            seed = false
            break
          }
        }
      }
      if (seed) rows.fill(1, p - Math.min(x, reach), p + Math.min(w - 1 - x, reach) + 1)
    }
  }
  const grown = new Uint8Array(w * h)
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (!rows[p]) continue
      for (let yy = Math.max(0, y - reach); yy <= Math.min(h - 1, y + reach); yy++) {
        grown[yy * w + x] = 1
      }
    }
  }
  for (let p = 0, i = 0; p < grown.length; p++, i += 4) {
    if (grown[p]) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
    } else if (noData[p]) {
      rgba[i] = Math.max(rgba[i], NO_DATA_LIFT)
      rgba[i + 1] = Math.max(rgba[i + 1], NO_DATA_LIFT)
      rgba[i + 2] = Math.max(rgba[i + 2], NO_DATA_LIFT)
    }
  }
}

/** In a dataMask: tiles that weren't fetched, which have no data but no edge
 * either. */
export const NOT_FETCHED = 2

/** Per pixel of a full-size RGBA mosaic: 1 where it has data, 0 where it is
 * no-data black, NOT_FETCHED inside the tiles (row-major, like tileUrls)
 * marked in notFetched. */
export function dataMask(rgba: ArrayLike<number>, notFetched: readonly boolean[] = []): Uint8Array {
  const mask = new Uint8Array(rgba.length / 4)
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const x = p % OUT_W
    const y = (p - x) / OUT_W
    if (notFetched[Math.floor(y / TILE) * COLS + Math.floor(x / TILE)]) mask[p] = NOT_FETCHED
    else mask[p] = isNoData(rgba[i], rgba[i + 1], rgba[i + 2]) ? 0 : 1
  }
  return mask
}

/** Box blur of a w x h field, averaging only the rows that exist in y, and in
 * x wrapping around the globe or, without wrapX, only the columns that
 * exist. */
export function boxBlur(
  src: ArrayLike<number>,
  w: number,
  h: number,
  r: number,
  wrapX = true
): Float32Array {
  const rows = new Float32Array(w * h)
  const k = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const o = y * w
    let sum = 0
    if (wrapX) {
      for (let d = -r; d <= r; d++) sum += src[o + ((d % w) + w) % w]
      for (let x = 0; x < w; x++) {
        rows[o + x] = sum / k
        sum += src[o + ((x + r + 1) % w)] - src[o + (((x - r) % w) + w) % w]
      }
    } else {
      for (let x = 0; x <= Math.min(w - 1, r); x++) sum += src[o + x]
      for (let x = 0; x < w; x++) {
        rows[o + x] = sum / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1)
        if (x + r + 1 < w) sum += src[o + x + r + 1]
        if (x - r >= 0) sum -= src[o + x - r]
      }
    }
  }
  const out = new Float32Array(w * h)
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = 0; y <= Math.min(h - 1, r); y++) sum += rows[y * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1)
      if (y + r + 1 < h) sum += rows[(y + r + 1) * w + x]
      if (y - r >= 0) sum -= rows[(y - r) * w + x]
    }
  }
  return out
}

/** Separable square min or max filter of radius r, wrapping in x. */
function rankFilter(src: Uint8Array, w: number, h: number, r: number, max: boolean): Uint8Array {
  const rows = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const o = y * w
    for (let x = 0; x < w; x++) {
      let m = max ? 0 : 255
      for (let d = -r; d <= r; d++) {
        const v = src[o + ((x + d + w) % w)]
        m = max ? (v > m ? v : m) : v < m ? v : m
      }
      rows[o + x] = m
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h - 1, y + r)
    for (let x = 0; x < w; x++) {
      let m = max ? 0 : 255
      for (let yy = y0; yy <= y1; yy++) {
        const v = rows[yy * w + x]
        m = max ? (v > m ? v : m) : v < m ? v : m
      }
      out[y * w + x] = m
    }
  }
  return out
}

// --- Sunglint (tides-a7w) ----------------------------------------------------
//
// Over open water near each swath's centre the true colour shows sunglint: a
// smooth grey sheen, often a streak tens of degrees long, bright enough
// (min(r,g,b) ~85-140, a few hot spots past 200) for cloudAlpha to give it
// 20-115 (2026-10-18, a typical streak at 125-122°W, 0-12°S). Neither colour
// tells it from thin cloud: the false colour of glint, e.g. (70,106,103) at
// min 121, is within a few levels of broken cloud at the same brightness,
// (64,97,99), and the true colour is the same blue-grey. What does tell them
// apart at this resolution is texture: glint is smoother than the open ocean
// around it (whose eddies and swath noise the enhancement brings out), let
// alone cloud. Of the pixels at glint's floor, 24-50% (p25-p75 over the
// streak, median 36%) have a 4-neighbour gradient |dx|+|dy| under 8, against a
// median of 3% (p75 7%) around the 2026-10-18 typhoon at 133-150°E, whose thin
// outer cloud a floor alone would take. And glint is broad, so a morphological
// opening (a min, then a max, over ~100 km) keeps its floor while removing the
// cloud on top of it.
//
// So over water: the floor is the opening of min(r,g,b); where the pixels near
// it are smooth, it isn't as bright as an overcast deck and the sun at the
// overpass is high enough for glint, the floor is taken back down to clear
// ocean (GLINT_CLEAR) and everything above it rescaled, which keeps cloud
// inside the glint. Geometry only gates by latitude: the daily composite
// doesn't say which orbit a pixel came from, so the glint's longitude can't be
// predicted, but SNPP (13:30) and Terra (10:30) both see a point 1.5 hours
// from local noon, and glint needs that sun within ~50° of the zenith. Checked
// on 2026-10-18 (streaks 20°N-30°S removed, including the Indian Ocean and
// the Gulf of Guinea at 3°W-69°E; the typhoon and the Peru deck kept),
// 2026-06-21 (streaks 5-40°N; the brightest hot spots, smaller than the
// opening, are dimmed but stay) and 2026-07-09/10, older than the geostationary
// archive (North Atlantic streaks removed, trade cumulus kept). Thin smooth
// cloud in a glinty area loses some alpha, and haze, dust and smoke over the
// sea (off Angola, the Arabian Sea) go with the glint, which is no loss.

/** Clear open ocean's min(r,g,b): the level the glint floor is taken down to. */
export const GLINT_CLEAR = 40
// The floor and weights are smooth fields, so they're worked out at half
// resolution and interpolated back up.
const GLINT_W = OUT_W / 2
const GLINT_H = OUT_H / 2
/** Opening radius in half-resolution pixels (~85 km at the equator). */
const GLINT_OPEN = 3
/** A pixel this little above the floor is part of it, unless the floor is
 * brighter than GLINT_BACKGROUND_MAX (cloud, not glint). */
const GLINT_BACKGROUND_ABOVE = 12
const GLINT_BACKGROUND_MAX = 160
/** Gradient (|dx|+|dy| of min(r,g,b), full resolution) under which a floor
 * pixel counts as smooth. */
export const GLINT_SMOOTH_GRADIENT = 8
/** Radius (half-res px) over which the smooth fraction is taken, and the
 * fraction that starts and completes the removal. */
const GLINT_SMOOTH_RADIUS = 4
export const GLINT_SMOOTH_EDGES = [0.1, 0.3] as const
/** The weight spreads this far (half-res px) to reach the streak's edges. */
const GLINT_SPREAD = 3
/** Floors this bright are overcast, not glint. */
export const GLINT_BRIGHT_EDGES = [190, 230] as const
/** Solar zenith (degrees) at the overpass over which glint fades out. */
export const GLINT_SUN_EDGES = [35, 50] as const
/** Both satellites pass 1.5 hours from local solar noon. */
const OVERPASS_HOUR_ANGLE_DEG = 22.5

/** Solar declination (degrees), to within ~2°, which is plenty for a gate. */
export function solarDeclination(ms: number): number {
  const day = (ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / DAY_MS
  return -23.44 * Math.cos(((2 * Math.PI) / 365.25) * (day + 10))
}

/** 0..1: how high the sun is for glint at the overpass along a latitude. */
export function glintSunGate(latDeg: number, declinationDeg: number): number {
  const rad = Math.PI / 180
  const cosZenith =
    Math.sin(latDeg * rad) * Math.sin(declinationDeg * rad) +
    Math.cos(latDeg * rad) * Math.cos(declinationDeg * rad) * Math.cos(OVERPASS_HOUR_ANGLE_DEG * rad)
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith))) / rad
  return 1 - smoothstep(GLINT_SUN_EDGES[0], GLINT_SUN_EDGES[1], zenith)
}

/**
 * The glint floor per output pixel of a true-colour RGBA mosaic: the level
 * removeGlint takes back down to clear ocean, or 0 where there is nothing to
 * remove. land is nonzero over land (one byte per pixel, like Terrain.land in
 * geo-clouds.ts); dayMs is the imagery's day, for the sun.
 */
export function glintFloor(rgba: ArrayLike<number>, land: ArrayLike<number>, dayMs: number): Uint8Array {
  const n = GLINT_W * GLINT_H
  const lum = new Uint8Array(OUT_W * OUT_H)
  const seen = new Uint8Array(OUT_W * OUT_H)
  const low = new Uint8Array(n).fill(255)
  const hasWater = new Uint8Array(n)
  for (let y = 0, p = 0; y < OUT_H; y++) {
    const row = (y >> 1) * GLINT_W
    for (let x = 0; x < OUT_W; x++, p++) {
      if (land[p]) continue
      const i = p * 4
      const r = rgba[i]
      const g = rgba[i + 1]
      const b = rgba[i + 2]
      if (isNoData(r, g, b)) continue
      const v = Math.min(r, g, b)
      lum[p] = v
      seen[p] = 1
      const q = row + (x >> 1)
      hasWater[q] = 1
      if (v < low[q]) low[q] = v
    }
  }
  // Opening: land and no-data take no part (255 for the min, 0 for the max).
  const eroded = rankFilter(low, GLINT_W, GLINT_H, GLINT_OPEN, false)
  for (let q = 0; q < n; q++) if (!hasWater[q]) eroded[q] = 0
  const opened = rankFilter(eroded, GLINT_W, GLINT_H, GLINT_OPEN, true)

  // How smooth the pixels at the floor are, per half-res cell.
  const floorPixels = new Float32Array(n)
  const smoothPixels = new Float32Array(n)
  for (let y = 1; y < OUT_H - 1; y++) {
    const row = (y >> 1) * GLINT_W
    for (let x = 0, p = y * OUT_W; x < OUT_W; x++, p++) {
      if (!seen[p]) continue
      const q = row + (x >> 1)
      const f = opened[q]
      if (f > GLINT_BACKGROUND_MAX || lum[p] - f > GLINT_BACKGROUND_ABOVE) continue
      const o = y * OUT_W
      const gradient =
        Math.abs(lum[o + ((x + 1) % OUT_W)] - lum[o + ((x + OUT_W - 1) % OUT_W)]) +
        Math.abs(lum[p + OUT_W] - lum[p - OUT_W])
      floorPixels[q]++
      if (gradient < GLINT_SMOOTH_GRADIENT) smoothPixels[q]++
    }
  }
  const floorNear = boxBlur(floorPixels, GLINT_W, GLINT_H, GLINT_SMOOTH_RADIUS)
  const smoothNear = boxBlur(smoothPixels, GLINT_W, GLINT_H, GLINT_SMOOTH_RADIUS)
  const smooth = new Uint8Array(n)
  for (let q = 0; q < n; q++) {
    if (floorNear[q] < 0.05) continue
    smooth[q] = 255 * smoothstep(GLINT_SMOOTH_EDGES[0], GLINT_SMOOTH_EDGES[1], smoothNear[q] / floorNear[q])
  }
  const spread = boxBlur(
    rankFilter(smooth, GLINT_W, GLINT_H, GLINT_SPREAD, true),
    GLINT_W,
    GLINT_H,
    GLINT_SPREAD
  )

  // The floor, smoothed over water only.
  const weighted = new Float32Array(n)
  for (let q = 0; q < n; q++) weighted[q] = hasWater[q] ? opened[q] : 0
  const floorSum = boxBlur(weighted, GLINT_W, GLINT_H, GLINT_OPEN)
  const waterSum = boxBlur(hasWater, GLINT_W, GLINT_H, GLINT_OPEN)
  const declination = solarDeclination(dayMs)
  const cells = new Float32Array(n)
  for (let gy = 0; gy < GLINT_H; gy++) {
    const gate = glintSunGate(90 - ((gy + 0.5) / GLINT_H) * 180, declination)
    if (gate <= 0) continue
    for (let gx = 0, q = gy * GLINT_W; gx < GLINT_W; gx++, q++) {
      if (waterSum[q] <= 0 || spread[q] <= 0) continue
      const f = floorSum[q] / waterSum[q]
      if (f <= GLINT_CLEAR) continue
      const w =
        gate *
        (spread[q] / 255) *
        (1 - smoothstep(GLINT_BRIGHT_EDGES[0], GLINT_BRIGHT_EDGES[1], f))
      cells[q] = w * (f - GLINT_CLEAR)
    }
  }

  // Bilinear back up to full resolution, between half-res cell centres.
  const out = new Uint8Array(OUT_W * OUT_H)
  for (let y = 0, p = 0; y < OUT_H; y++) {
    const fy = Math.min(GLINT_H - 1, Math.max(0, (y + 0.5) / 2 - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(GLINT_H - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < OUT_W; x++, p++) {
      if (!seen[p]) continue
      const fx = (x + 0.5) / 2 - 0.5
      const x0 = Math.floor(fx)
      const tx = fx - x0
      const xa = (x0 + GLINT_W) % GLINT_W
      const xb = (x0 + 1) % GLINT_W
      const above = cells[y0 * GLINT_W + xa] * (1 - tx) + cells[y0 * GLINT_W + xb] * tx
      const below = cells[y1 * GLINT_W + xa] * (1 - tx) + cells[y1 * GLINT_W + xb] * tx
      const lift = above * (1 - ty) + below * ty
      if (lift >= 1) out[p] = Math.round(GLINT_CLEAR + lift)
    }
  }
  return out
}

/** One colour channel with the glint floor (glintFloor) taken back down to
 * GLINT_CLEAR and the range above it stretched to fill the rest. */
export function removeGlint(v: number, floor: number): number {
  return Math.max(0, GLINT_CLEAR + ((v - floor) * (255 - GLINT_CLEAR)) / (255 - floor))
}

// --- Feathered seams (tides-g29) ----------------------------------------------
//
// A day's composite has hard edges where its data stops: swath gaps and failed
// tiles (filled from the day before), polar night (static clouds), and the
// antimeridian. GIBS assigns each pixel to its local solar day, so just east
// of 180° the composite holds the next UTC day's ~01:30 pass, while just west
// of it holds this day's: ~24 hours apart. The fill day's pixels east of 180°
// come from this day's ~01:30 pass, the same swath as the west side. So rather
// than cutting from one source to the next, each source is faded out over a
// band inside its own data (its validity mask, box-blurred), and along the
// antimeridian the fill day takes over the east side, fading back to the
// primary day over DATELINE_FEATHER_PX. Only the weights are blurred, never
// the clouds.

/** Width (px) over which a source fades out inside the edge of its data. */
export const FEATHER_PX = 24
/** Width (px) east of 180° over which the fill day hands over to the day. */
export const DATELINE_FEATHER_PX = 64

/** 0..1 per pixel of a dataMask: a source's weight, 0 outside its data and
 * rising to 1 by FEATHER_PX inside it. Unfetched tiles have no data but don't
 * make an edge, so the fill day stays whole along the antimeridian although
 * its east-most column is rarely fetched. Nor does the antimeridian, where
 * each day's two sides are a day apart and the primary day's west side meets
 * the fill day's east side instead. */
export function featherWeights(mask: ArrayLike<number>): Float32Array {
  const known = new Uint8Array(mask.length)
  for (let p = 0; p < known.length; p++) known[p] = mask[p] ? 1 : 0
  const near = boxBlur(known, OUT_W, OUT_H, FEATHER_PX, false)
  for (let p = 0; p < near.length; p++) {
    near[p] = mask[p] === 1 ? smoothstep(0.5, 1, near[p]) : 0
  }
  return near
}

/**
 * Blends the day's cloud alpha over the fill day's over the static clouds,
 * each feathered inside its own data and the fill day leading along the
 * antimeridian. primary and fill are composeCloudAlpha output (RGBA, alpha in
 * green), primaryData and fillData their dataMask; fill is null without a
 * fill day. out (RGBA, may alias primary) gets the alpha grey and opaque.
 */
export function blendDaily(
  primary: ArrayLike<number>,
  primaryData: ArrayLike<number>,
  fill: ArrayLike<number> | null,
  fillData: ArrayLike<number> | null,
  staticAlpha: ArrayLike<number>,
  out: { [index: number]: number; length: number }
): void {
  const primaryWeight = featherWeights(primaryData)
  const fillWeight = fill && fillData ? featherWeights(fillData) : null
  for (let y = 0, p = 0; y < OUT_H; y++) {
    for (let x = 0; x < OUT_W; x++, p++) {
      const i = p * 4
      let wp = primaryWeight[p]
      let under = staticAlpha[p]
      if (fill && fillWeight) {
        const wf = fillWeight[p]
        under = wf * fill[i + 1] + (1 - wf) * under
        if (x < DATELINE_FEATHER_PX) wp *= 1 - (1 - smoothstep(0, DATELINE_FEATHER_PX, x)) * wf
      }
      out[i] = out[i + 1] = out[i + 2] = wp * primary[i + 1] + (1 - wp) * under
      out[i + 3] = 255
    }
  }
}

// Ice cloud is cyan in the false colour too, a little less than snow, and
// GIBS's JPEG chroma blocks push patches of it over the snow edges: over the
// open sea that cut 8-16 px blocks out of the North Pacific storm track
// (tides-9jn.3). Sea ice is (nearly all) poleward of 50-65°, so over the sea
// the snow mask fades in across those latitudes; the odd late-winter ice
// further south (the Sea of Okhotsk, the Gulf of St Lawrence) shows as cloud,
// which it looks like anyway.
export const SEA_ICE_LAT_EDGES = [50, 65] as const

/** 0..1: how far the false-colour snow mask counts over the sea at a
 * latitude. */
export function seaIceGate(latDeg: number): number {
  return smoothstep(SEA_ICE_LAT_EDGES[0], SEA_ICE_LAT_EDGES[1], Math.abs(latDeg))
}

/**
 * gibs, falseColour and out are RGBA; staticAlpha and ice hold one byte per
 * pixel. Pixels with no true colour (polar night, swath gaps, failed tiles)
 * are black and keep the static cloud alpha. Elsewhere glint (glintFloor, one
 * byte per pixel, optional) is taken out first, then the land-ice mask or
 * false-colour snow, whichever is stronger, removes cloud; missing false
 * colour is black and masks nothing. With land (nonzero over land, one byte
 * per pixel of a full OUT_W x OUT_H image), false-colour snow over the sea
 * only counts where there can be sea ice (seaIceGate). Output is grey (RGB =
 * alpha) and opaque, since the cloud material reads its alphaMap from the
 * green channel. out may alias gibs.
 */
export function composeCloudAlpha(
  gibs: ArrayLike<number>,
  falseColour: ArrayLike<number>,
  snowEdges: readonly [number, number],
  staticAlpha: ArrayLike<number>,
  ice: ArrayLike<number>,
  out: { [index: number]: number; length: number },
  glint: ArrayLike<number> | null = null,
  land: ArrayLike<number> | null = null
): void {
  let seaGate = 1
  for (let p = 0, i = 0; i < out.length; p++, i += 4) {
    if (land && p % OUT_W === 0) seaGate = seaIceGate(90 - ((p / OUT_W + 0.5) / OUT_H) * 180)
    const r = gibs[i]
    const g = gibs[i + 1]
    const b = gibs[i + 2]
    let a: number
    if (isNoData(r, g, b)) {
      a = staticAlpha[p]
    } else {
      const floor = glint ? glint[p] : 0
      a = floor
        ? cloudAlpha(removeGlint(r, floor), removeGlint(g, floor), removeGlint(b, floor))
        : cloudAlpha(r, g, b)
      if (a > 0) {
        let snow = snowWeight(falseColour[i], falseColour[i + 1], falseColour[i + 2], snowEdges)
        if (land && !land[p]) snow *= seaGate
        a *= 1 - Math.max(ice[p] / 255, snow)
      }
    }
    out[i] = out[i + 1] = out[i + 2] = a
    out[i + 3] = 255
  }
}

export function isRetryable(failure: number | 'timeout' | 'network'): boolean {
  if (failure === 'timeout' || failure === 'network') return true
  return failure === 408 || failure === 429 || failure >= 500
}

/** Keys to drop, least recently used first, so at most `max` remain. Keys in
 * `keep` (the frames being shown) are never evicted. */
export function pickEvictions(
  entries: { key: string; lastUsed: number }[],
  keep: ReadonlySet<string>,
  max: number
): string[] {
  const excess = entries.length - max
  if (excess <= 0) return []
  return entries
    .filter((e) => !keep.has(e.key))
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, excess)
    .map((e) => e.key)
}
