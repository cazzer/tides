// Date-matched clouds from NASA GIBS true-colour imagery (tides-l3s; spike
// findings in tides-pdu). A false-colour layer from the same instrument is
// only a mask for seasonal snow and sea ice (tides-6bh). No-data gaps are
// filled from the previous day before falling back to the static clouds
// (tides-2t9). Within the last ~90 days geostationary imagery matched to the
// sim time goes over the top (tides-1zj, geo-clouds.ts). Pure logic only:
// which layers, days and slots to show, the tile URLs, the gap fill, the
// cloud-alpha maths and the debounce. The browser side lives in
// renderers/realCloudTextures.ts.

const DAY_MS = 86_400_000

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
// A day must stay wanted this long (wall clock) before it is fetched, so fast
// playback and the frames of a jump tween never trigger downloads.
export const SETTLE_MS = 1500
/** Cloud textures kept, days or geostationary slots alike. */
export const MAX_CACHED_DAYS = 3

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

/** Blackens the RGB of every pixel within NO_DATA_GROW px (a square) of a
 * no-data pixel in a w x h RGBA image, so the fill and static fallback cover
 * the darkened rim too. Failed tiles (row-major, like tileUrls) don't seed:
 * their edges are clean, and the fill only writes inside them. Alpha bytes are
 * left alone. */
export function growNoData(
  rgba: { [index: number]: number; length: number },
  w: number,
  h: number,
  failed: readonly boolean[] = []
): void {
  const n = NO_DATA_GROW
  // Separable: spread along rows, then blacken along columns.
  const rows = new Uint8Array(w * h)
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (failed[Math.floor(y / TILE) * COLS + Math.floor(x / TILE)]) continue
      if (isNoData(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2])) {
        rows.fill(1, p - Math.min(x, n), p + Math.min(w - 1 - x, n) + 1)
      }
    }
  }
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      if (!rows[p]) continue
      for (let yy = Math.max(0, y - n); yy <= Math.min(h - 1, y + n); yy++) {
        const i = (yy * w + x) * 4
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
      }
    }
  }
}

/** gibs and falseColour are full-size RGBA; fillGibs and fillFalseColour are
 * the fill day's RGBA for the w x h region at (x0, y0). Where gibs has no
 * data, both take the fill day's colour; alpha bytes are left alone. */
export function fillNoData(
  gibs: { [index: number]: number; length: number },
  falseColour: { [index: number]: number; length: number },
  fillGibs: ArrayLike<number>,
  fillFalseColour: ArrayLike<number>,
  x0: number,
  y0: number,
  w: number,
  h: number
): void {
  for (let y = 0, j = 0; y < h; y++) {
    for (let x = 0, i = ((y0 + y) * OUT_W + x0) * 4; x < w; x++, i += 4, j += 4) {
      if (!isNoData(gibs[i], gibs[i + 1], gibs[i + 2])) continue
      for (let c = 0; c < 3; c++) {
        gibs[i + c] = fillGibs[j + c]
        falseColour[i + c] = fillFalseColour[j + c]
      }
    }
  }
}

/**
 * gibs, falseColour and out are RGBA; staticAlpha and ice hold one byte per
 * pixel. Pixels with no true colour on either day (polar night, swath gaps,
 * failed tiles) are black and keep the static cloud alpha. Elsewhere the
 * land-ice mask or false-colour snow, whichever is stronger, removes cloud;
 * missing false colour is black and masks nothing. Output is grey (RGB =
 * alpha) and opaque, since the cloud material reads its alphaMap from the green
 * channel. out may alias gibs.
 */
export function composeCloudAlpha(
  gibs: ArrayLike<number>,
  falseColour: ArrayLike<number>,
  snowEdges: readonly [number, number],
  staticAlpha: ArrayLike<number>,
  ice: ArrayLike<number>,
  out: { [index: number]: number; length: number }
): void {
  for (let p = 0, i = 0; i < out.length; p++, i += 4) {
    const r = gibs[i]
    const g = gibs[i + 1]
    const b = gibs[i + 2]
    let a: number
    if (isNoData(r, g, b)) {
      a = staticAlpha[p]
    } else {
      a = cloudAlpha(r, g, b)
      if (a > 0) {
        const snow = snowWeight(falseColour[i], falseColour[i + 1], falseColour[i + 2], snowEdges)
        a *= 1 - Math.max(ice[p] / 255, snow)
      }
    }
    out[i] = out[i + 1] = out[i + 2] = a
    out[i + 3] = 255
  }
}

export interface CloudDayState {
  /** Key waiting to settle, or null. */
  candidate: string | null
  /** Wall-clock ms when the candidate was first wanted. */
  since: number
  committed: string | null
}

export const initialCloudDayState: CloudDayState = {
  candidate: null,
  since: 0,
  committed: null,
}

// Geostationary slots change every 10 sim minutes, so playback would refetch
// constantly. A slot within GEO_NEAR_MS of the one shown must be wanted for
// GEO_NEAR_SETTLE_MS: at real time it updates every 10 minutes, but during
// fast playback the clouds only catch up in GEO_NEAR_MS steps (and not at all
// once a slot lasts under SETTLE_MS of wall time) until it slows or stops.
export const GEO_NEAR_MS = 3 * 3_600_000
export const GEO_NEAR_SETTLE_MS = 12_000

/** How long `next` must be wanted before it replaces `committed`. */
export function settleMsFor(next: CloudSource, committed: CloudSource | null): number {
  if (next.kind !== 'geo' || committed?.kind !== 'geo') return SETTLE_MS
  const apart = Math.abs(Date.parse(next.time) - Date.parse(committed.time))
  return apart < GEO_NEAR_MS ? GEO_NEAR_SETTLE_MS : SETTLE_MS
}

/** Debounces the wanted source key. The first key commits at once; later ones
 * once they have been wanted for settleMs. Returns the same state object when
 * nothing changed, so calling it again in the same frame is a no-op. */
export function stepCloudDay(
  prev: CloudDayState,
  desiredKey: string,
  wallMs: number,
  settleMs: number = SETTLE_MS
): { state: CloudDayState; commit: string | null } {
  if (prev.committed === null) {
    return {
      state: { candidate: null, since: wallMs, committed: desiredKey },
      commit: desiredKey,
    }
  }
  if (desiredKey === prev.committed) {
    if (prev.candidate === null) return { state: prev, commit: null }
    return { state: { ...prev, candidate: null }, commit: null }
  }
  if (desiredKey !== prev.candidate) {
    return {
      state: { ...prev, candidate: desiredKey, since: wallMs },
      commit: null,
    }
  }
  if (wallMs - prev.since >= settleMs) {
    return {
      state: { candidate: null, since: wallMs, committed: desiredKey },
      commit: desiredKey,
    }
  }
  return { state: prev, commit: null }
}

/** During a jump the clock tweens through every day in between; only the
 * target matters. */
export function desiredCloudSource(
  simMs: number,
  jumpToMs: number | null,
  nowMs: number
): CloudSource {
  return selectRealCloudSource(jumpToMs ?? simMs, nowMs)
}

export function isRetryable(failure: number | 'timeout' | 'network'): boolean {
  if (failure === 'timeout' || failure === 'network') return true
  return failure === 408 || failure === 429 || failure >= 500
}

/** Keys to drop, least recently used first, so at most `max` remain. `keep`
 * (the displayed texture) is never evicted. */
export function pickEvictions(
  entries: { key: string; lastUsed: number }[],
  keep: string | null,
  max: number
): string[] {
  const excess = entries.length - max
  if (excess <= 0) return []
  return entries
    .filter((e) => e.key !== keep)
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, excess)
    .map((e) => e.key)
}
