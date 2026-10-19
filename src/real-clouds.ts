// Date-matched clouds from NASA GIBS true-colour imagery (tides-l3s; spike
// findings in tides-pdu). Pure logic only: which layer and day to show, the
// tile URLs, the cloud-alpha maths and the day debounce. The browser side
// lives in renderers/realCloudTextures.ts.

const DAY_MS = 86_400_000

// Daily true-colour composites of daytime passes. Ranges from the GIBS
// capabilities document (2026-10-18). WMTS 404s outside them, so the client
// checks the date itself.
export const VIIRS_FROM = Date.UTC(2015, 10, 24)
export const MODIS_FROM = Date.UTC(2000, 1, 24)
const VIIRS_LAYER = 'VIIRS_SNPP_CorrectedReflectance_TrueColor'
const MODIS_LAYER = 'MODIS_Terra_CorrectedReflectance_TrueColor'

// WMTS level 2 of the EPSG:4326 "250m" matrix is 5x3 tiles of 512px, 72 deg
// each. The globe is the top-left 2560x1280, so the bottom tile row only
// contributes its top 256px. Same equirectangular layout as the static clouds.
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
export const MAX_CACHED_DAYS = 3

export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS
}

export function utcDayKey(ms: number): string {
  return new Date(utcDay(ms)).toISOString().slice(0, 10)
}

export type CloudSource =
  | { kind: 'static'; reason: 'before-coverage' | 'after-latest' }
  | { kind: 'gibs'; layer: string; date: string }

export function selectCloudSource(simMs: number, nowMs: number): CloudSource {
  const day = utcDay(simMs)
  // Today's composite is still filling in, so yesterday is the latest whole day.
  const latest = utcDay(nowMs) - DAY_MS
  if (day > latest) return { kind: 'static', reason: 'after-latest' }
  const date = utcDayKey(day)
  if (day >= VIIRS_FROM) return { kind: 'gibs', layer: VIIRS_LAYER, date }
  if (day >= MODIS_FROM) return { kind: 'gibs', layer: MODIS_LAYER, date }
  return { kind: 'static', reason: 'before-coverage' }
}

export function sourceKey(source: CloudSource): string {
  return source.kind === 'static'
    ? `static:${source.reason}`
    : `${source.layer}/${source.date}`
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

function saturation(max: number, min: number): number {
  return max === 0 ? 0 : (max - min) / max
}

/** Cloud = bright and colourless: min(r,g,b) rejects ocean and vegetation,
 * the saturation term rejects tan desert. 0..255. */
export function cloudAlpha(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return (
    255 *
    smoothstep(0.32, 0.8, min / 255) *
    (1 - smoothstep(0.12, 0.3, saturation(max, min)))
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

/**
 * gibs and out are RGBA; staticAlpha and ice hold one byte per pixel. Pixels
 * GIBS has no data for (polar night, swath gaps, failed tiles) are black and
 * keep the static cloud alpha. Output is grey (RGB = alpha) and opaque, since
 * the cloud material reads its alphaMap from the green channel.
 */
export function composeCloudAlpha(
  gibs: ArrayLike<number>,
  staticAlpha: ArrayLike<number>,
  ice: ArrayLike<number>,
  out: { [index: number]: number; length: number }
): void {
  for (let p = 0, i = 0; i < out.length; p++, i += 4) {
    const r = gibs[i]
    const g = gibs[i + 1]
    const b = gibs[i + 2]
    const a =
      Math.max(r, g, b) < 12
        ? staticAlpha[p]
        : cloudAlpha(r, g, b) * (1 - ice[p] / 255)
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

/** Debounces the wanted source key. The first key commits at once; later ones
 * once they have been wanted for SETTLE_MS. Returns the same state object when
 * nothing changed, so calling it again in the same frame is a no-op. */
export function stepCloudDay(
  prev: CloudDayState,
  desiredKey: string,
  wallMs: number
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
  if (wallMs - prev.since >= SETTLE_MS) {
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
  return selectCloudSource(jumpToMs ?? simMs, nowMs)
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
