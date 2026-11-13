// GOES Geostationary Lightning Mapper files (tides-ufyr.13): where they are,
// what their keys say, and turning one file's packed flash variables into a
// FlashBatch. No DOM, no HDF5 (renderers/glmFile.ts reads the files).
//
// NOAA's open-data buckets (CORS-open, no key): one GLM L2 LCFA netCDF4 file
// per 20 s per satellite, ~350 KB, under
// GLM-L2-LCFA/YYYY/DDD/HH/OR_GLM-L2-LCFA_G19_sYYYYDDDHHMMSSt_e..._c....nc,
// listed with S3's ?list-type=2&prefix=.
import { WINDOW_MS, type FlashBatch } from './lightning'

export { WINDOW_MS }

export interface GlmSatellite {
  id: 'G19' | 'G18'
  bucket: string
  /** The first day its bucket holds GLM files, epoch ms. */
  fromMs: number
}

/** GOES-East (GOES-19) and GOES-West (GOES-18): the Americas, Atlantic and Pacific. */
export const SATELLITES: readonly GlmSatellite[] = [
  { id: 'G19', bucket: 'noaa-goes19', fromMs: Date.UTC(2025, 0, 15) },
  { id: 'G18', bucket: 'noaa-goes18', fromMs: Date.UTC(2022, 8, 19) },
]

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export interface Packing {
  scale: number
  offset: number
}

/**
 * The packed flash variables' scale_factor and add_offset (all i2 with
 * _Unsigned "true" and _FillValue -1): value = (raw & 0xffff) · scale +
 * offset. jsfive 0.4.0 can't read HDF5's dense attribute storage, which
 * these variables' attributes use, so they are hard-coded, as read with
 * netCDF4 from OR_GLM-L2-LCFA_G19_s20263170000000_e20263170000200_c20263170000217.nc
 * (2026-11-12) and as the GOES-19 GLM L2 ReadMe gives them; readGlmFile
 * checks the time packing against flash_time_offset_of_last_event's, which
 * jsfive can read.
 */
export const GLM_PACKING = {
  /** Seconds from the file's start (flash_time_offset_of_first_event / _last_event). */
  time: { scale: 0.00038147560553625226, offset: -5 },
  /** Joules (flash_energy). */
  energy: { scale: 9.999959802209943e-16, offset: 2.8514998886357517e-16 },
  /** Square metres (flash_area). */
  area: { scale: 152601.859375, offset: 0 },
} as const satisfies Record<string, Packing>

const FILL = -1

/** A file's flash variables as read, still packed. */
export interface GlmRaw {
  lat: ArrayLike<number>
  lon: ArrayLike<number>
  first: ArrayLike<number>
  last: ArrayLike<number>
  energy: ArrayLike<number>
  area: ArrayLike<number>
  /** nominal_satellite_subpoint_lon, degrees east. */
  subpointLon: number
  /** flash_time_offset_of_last_event's packing, where the file's attributes gave it. */
  timePacking: Packing | null
}

/** A GLM window's flashes and the satellite that saw them. */
export interface GlmBatch extends FlashBatch {
  subpointLon: number
}

const pad = (n: number, width: number) => String(n).padStart(width, '0')

/** The S3 prefix of the hour holding `ms`. */
export function glmHourPrefix(ms: number): string {
  const d = new Date(ms)
  const year = d.getUTCFullYear()
  const day = Math.floor((ms - Date.UTC(year, 0, 1)) / DAY_MS) + 1
  return `GLM-L2-LCFA/${year}/${pad(day, 3)}/${pad(d.getUTCHours(), 2)}/`
}

/** The start of the hour holding `ms`. */
export function hourStartMs(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS
}
export { HOUR_MS }

const bucketUrl = (sat: GlmSatellite) => `https://${sat.bucket}.s3.amazonaws.com/`

/** The listing of one hour's files, after `startAfter` (a key) when given. */
export function glmListUrl(sat: GlmSatellite, hourMs: number, startAfter: string | null = null): string {
  const prefix = encodeURIComponent(glmHourPrefix(hourMs))
  const after = startAfter ? `&start-after=${encodeURIComponent(startAfter)}` : ''
  return `${bucketUrl(sat)}?list-type=2&prefix=${prefix}${after}`
}

export function glmObjectUrl(sat: GlmSatellite, key: string): string {
  return bucketUrl(sat) + key.split('/').map(encodeURIComponent).join('/')
}

/** The .nc keys in an S3 ListObjectsV2 reply, in its (key) order. */
export function parseGlmListing(xml: string): string[] {
  const keys: string[] = []
  for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    if (m[1].endsWith('.nc')) keys.push(m[1])
  }
  return keys
}

const START_FIELD = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_/

/** A key's observation start (its _s field, to the tenth of a second), epoch ms; NaN if none. */
export function glmKeyStartMs(key: string): number {
  const m = START_FIELD.exec(key)
  if (!m) return Number.NaN
  const [year, day, hour, minute, second, tenth] = m.slice(1).map(Number)
  return Date.UTC(year, 0, 1) + (day - 1) * DAY_MS + hour * HOUR_MS + minute * 60_000 + second * 1000 + tenth * 100
}

/** The window a key's file covers (its start rounded to the nearest 20 s). */
export function glmKeyWindow(key: string): number {
  return Math.round(glmKeyStartMs(key) / WINDOW_MS)
}

/** Flash footprints outside this (km²) mean the packing is not what GLM_PACKING says. */
export const AREA_SANE_KM2: readonly [number, number] = [20, 1e5]

let warnedPacking = false

const unpack = (raw: number, p: Packing) => (raw & 0xffff) * p.scale + p.offset

function samePacking(a: Packing, b: Packing): boolean {
  return Math.abs(a.scale - b.scale) <= 1e-9 * Math.abs(b.scale) && Math.abs(a.offset - b.offset) <= 1e-9
}

/**
 * One file's flashes in real units, sorted by their first light. Rows with a
 * fill value or a non-finite field are dropped. If the file's own time
 * packing differs from GLM_PACKING's, a warning (once); if any footprint is
 * outside AREA_SANE_KM2, the packing is wrong for this file and the batch is
 * emptied. `owned` starts all 0 (the feed decides, ./glm-feed.ts).
 */
export function decodeGlmFlashes(raw: GlmRaw, key: string, windowStartMs: number): GlmBatch {
  if (raw.timePacking && !samePacking(raw.timePacking, GLM_PACKING.time) && !warnedPacking) {
    warnedPacking = true
    console.warn('[lightning] GLM time packing differs from GLM_PACKING', raw.timePacking, key)
  }
  const n = raw.lat.length
  const keep: number[] = []
  const first = new Float64Array(n)
  let sane = true
  for (let i = 0; i < n; i++) {
    const r = [raw.first[i], raw.last[i], raw.energy[i], raw.area[i]]
    if (r.some((v) => v === FILL || !Number.isFinite(v))) continue
    if (!Number.isFinite(raw.lat[i]) || !Number.isFinite(raw.lon[i])) continue
    const areaKm2 = unpack(raw.area[i], GLM_PACKING.area) / 1e6
    if (areaKm2 < AREA_SANE_KM2[0] || areaKm2 > AREA_SANE_KM2[1]) sane = false
    first[i] = unpack(raw.first[i], GLM_PACKING.time)
    keep.push(i)
  }
  if (!sane) {
    console.warn('[lightning] GLM flash areas out of range; dropping', key)
    keep.length = 0
  }
  keep.sort((a, b) => first[a] - first[b])
  const count = keep.length
  const batch: GlmBatch = {
    source: 'glm',
    key,
    startMs: windowStartMs,
    count,
    lat: new Float32Array(count),
    lon: new Float32Array(count),
    offsetMs: new Float32Array(count),
    durationMs: new Float32Array(count),
    energyJ: new Float32Array(count),
    areaKm2: new Float32Array(count),
    owned: new Uint8Array(count),
    subpointLon: raw.subpointLon,
  }
  keep.forEach((i, j) => {
    const last = unpack(raw.last[i], GLM_PACKING.time)
    batch.lat[j] = raw.lat[i]
    batch.lon[j] = raw.lon[i]
    batch.offsetMs[j] = first[i] * 1000
    batch.durationMs[j] = Math.max(0, last - first[i]) * 1000
    batch.energyJ[j] = unpack(raw.energy[i], GLM_PACKING.energy)
    batch.areaKm2[j] = unpack(raw.area[i], GLM_PACKING.area) / 1e6
  })
  return batch
}

/** The batch's buffers, for a transfer out of the worker. */
export function batchTransfer(batch: FlashBatch): ArrayBuffer[] {
  return [batch.lat, batch.lon, batch.offsetMs, batch.durationMs, batch.energyJ, batch.areaKm2, batch.owned].map(
    (a) => a.buffer as ArrayBuffer
  )
}

/** Degrees between two longitudes, 0..180. */
function lonGap(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180)
}

/**
 * Whether the satellite over `ownLon` draws a flash at `lon` that the one
 * over `otherLon` may also have seen: the nearer one does (`winsTies` on a
 * tie), so an overlap shows each flash once.
 */
export function ownsFlash(lon: number, ownLon: number, otherLon: number, winsTies: boolean): boolean {
  const own = lonGap(lon, ownLon)
  const other = lonGap(lon, otherLon)
  return own < other || (own === other && winsTies)
}
