// Reading one GLM L2 LCFA netCDF4 file (tides-ufyr.13) with jsfive, and
// downloading and decoding one in full. Runs in ./glm.worker.ts, or on the
// main thread where no worker can (./glmWorkerClient.ts imports it lazily,
// so jsfive stays out of the main bundle).
import { File, type Dataset } from 'jsfive'
import { decodeGlmFlashes, type GlmBatch, type GlmRaw, type Packing } from '../glm'
import { eitherSignal } from './surface/fetch-retry'

export const FETCH_TIMEOUT_MS = 30_000

const FLASH_VARS = {
  lat: 'flash_lat',
  lon: 'flash_lon',
  first: 'flash_time_offset_of_first_event',
  last: 'flash_time_offset_of_last_event',
  energy: 'flash_energy',
  area: 'flash_area',
} as const

const EMPTY: ArrayLike<number> = []

function dataset(file: File, name: string): Dataset {
  const d = file.get(name)
  if (!d || !('value' in d)) throw new Error(`GLM file has no ${name}`)
  return d as Dataset
}

// A flash variable's values; a zero-length one is empty whatever jsfive
// makes of its (unallocated) storage.
function values(file: File, name: string): ArrayLike<number> {
  const d = dataset(file, name)
  if (d.shape.length > 0 && d.shape[0] === 0) return EMPTY
  return d.value
}

function firstNumber(v: unknown): number | null {
  const x = Array.isArray(v) || ArrayBuffer.isView(v) ? (v as ArrayLike<unknown>)[0] : v
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

// flash_time_offset_of_last_event's packing (its attributes are compact
// storage, which jsfive reads), to check GLM_PACKING by.
function timePacking(file: File): Packing | null {
  try {
    const attrs = dataset(file, FLASH_VARS.last).attrs
    const scale = firstNumber(attrs.scale_factor)
    const offset = firstNumber(attrs.add_offset)
    return scale === null || offset === null ? null : { scale, offset }
  } catch {
    return null
  }
}

/** A GLM file's flash variables, still packed. */
export function readGlmFile(buffer: ArrayBuffer): GlmRaw {
  const file = new File(buffer, 'glm.nc')
  const subpoint = firstNumber(dataset(file, 'nominal_satellite_subpoint_lon').value)
  if (subpoint === null) throw new Error('GLM file has no subpoint longitude')
  const lat = values(file, FLASH_VARS.lat)
  const empty = lat.length === 0
  const read = (name: string) => (empty ? EMPTY : values(file, name))
  return {
    lat,
    lon: read(FLASH_VARS.lon),
    first: read(FLASH_VARS.first),
    last: read(FLASH_VARS.last),
    energy: read(FLASH_VARS.energy),
    area: read(FLASH_VARS.area),
    subpointLon: subpoint,
    timePacking: timePacking(file),
  }
}

export interface GlmLoadRequest {
  url: string
  key: string
  windowStartMs: number
}

/** Downloads, reads and decodes one file (FETCH_TIMEOUT_MS at most). */
export async function loadGlmBatch({ url, key, windowStartMs }: GlmLoadRequest, signal: AbortSignal): Promise<GlmBatch> {
  const { signal: either, release } = eitherSignal(signal, AbortSignal.timeout(FETCH_TIMEOUT_MS))
  try {
    const res = await fetch(url, { signal: either })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const buffer = await res.arrayBuffer()
    signal.throwIfAborted()
    return decodeGlmFlashes(readGlmFile(buffer), key, windowStartMs)
  } finally {
    release()
  }
}
