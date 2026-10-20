// Real planetary Kp for the aurora (tides-qe5): parsing, picking a value for
// the sim time, and the debounced feed that decides what to download. No DOM;
// the fetching is injected (see renderers/AuroraRenderer.tsx).
//
// Sources, all CORS-open:
// - NOAA SWPC, last ~7 days (3-hourly, updated through the day):
//   https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json
// - NOAA SWPC's 3-day forecast (the same week observed, then ~3 days
//   predicted, issued a few times a day):
//   https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json
// - CelesTrak space-weather files (CSSI format, 8 Kp per day in tenths,
//   definitive values from GFZ Potsdam):
//   https://celestrak.org/SpaceData/SW-Last5Years.csv (~260 kB)
//   https://celestrak.org/SpaceData/SW-All.csv (~2.9 MB, from 1957-10-01)
// GFZ's own JSON API (https://kp.gfz.de/app/json/) sends no CORS header, so a
// browser can't read it directly.

export const SWPC_KP_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'
export const SWPC_FORECAST_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'
export const CELESTRAK_RECENT_URL = 'https://celestrak.org/SpaceData/SW-Last5Years.csv'
export const CELESTRAK_ALL_URL = 'https://celestrak.org/SpaceData/SW-All.csv'

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const SLOT_MS = 3 * HOUR

/** First day of SW-All.csv. */
export const KP_ARCHIVE_FROM = Date.UTC(1957, 9, 1)
/** SWPC's file holds about a week; ask it for anything newer than this. */
export const SWPC_SPAN_MS = 6.5 * DAY
/** The SWPC forecast reaches about three days ahead; ask it for anything
 * up to this far past now. */
export const FORECAST_SPAN_MS = 4 * DAY
/** SW-Last5Years starts on 1 January five years back; stay well inside. */
export const RECENT_SPAN_MS = 4 * 365 * DAY
/** The latest slot's value is carried this far past its end, so "now" uses
 * the latest published slot rather than nothing. SWPC posts a slot an hour or
 * more after it closes, so the newest is often two slots old. */
export const CARRY_MS = 2 * SLOT_MS

/** Kp samples, one per 3-hour slot, sorted by start time. */
export interface KpSeries {
  /** Slot start, epoch ms. */
  t: Float64Array
  kp: Float32Array
}

function series(samples: { t: number; kp: number }[]): KpSeries {
  samples.sort((a, b) => a.t - b.t)
  const t = new Float64Array(samples.length)
  const kp = new Float32Array(samples.length)
  samples.forEach((s, i) => {
    t[i] = s.t
    kp[i] = s.kp
  })
  return { t, kp }
}

/** SWPC time tags are UTC without a zone, "2024-05-10 00:00:00.000" or
 * "2026-10-12T00:00:00". */
function parseUtc(tag: string): number {
  const iso = tag.trim().replace(' ', 'T')
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
}

/** SWPC's planetary K-index products: either an array of objects
 * ({time_tag, Kp} observed, {time_tag, kp, observed} forecast) or the older
 * array of rows with a header row. */
export function parseSwpcKp(json: unknown): KpSeries {
  if (!Array.isArray(json)) throw new Error('SWPC Kp: expected an array')
  const samples: { t: number; kp: number }[] = []
  let timeCol = 0
  let kpCol = 1
  for (const row of json) {
    let tag: unknown
    let value: unknown
    if (Array.isArray(row)) {
      if (row.includes('time_tag')) {
        timeCol = row.indexOf('time_tag')
        kpCol = row.findIndex((c) => c === 'Kp' || c === 'kp_index')
        continue
      }
      tag = row[timeCol]
      value = row[kpCol]
    } else if (row && typeof row === 'object') {
      const r = row as Record<string, unknown>
      tag = r.time_tag
      value = r.Kp ?? r.kp ?? r.kp_index
    }
    if (typeof tag !== 'string') continue
    const t = parseUtc(tag)
    const kp = Number(value)
    if (value == null || value === '' || !Number.isFinite(t) || !Number.isFinite(kp)) continue
    samples.push({ t, kp: Math.min(Math.max(kp, 0), 9) })
  }
  return series(samples)
}

/** CelesTrak's CSSI space-weather CSV: DATE, then KP1..KP8 in tenths (37 is
 * "4-" = 3.67). Rows without Kp (the monthly predictions) are skipped. */
export function parseCelestrakKp(csv: string): KpSeries {
  const lines = csv.split(/\r?\n/)
  const header = lines[0]?.split(',').map((h) => h.trim()) ?? []
  const dateCol = header.indexOf('DATE')
  const kpCols = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => header.indexOf(`KP${i}`))
  if (dateCol < 0 || kpCols.some((c) => c < 0)) {
    throw new Error('CelesTrak Kp: unexpected header')
  }
  const samples: { t: number; kp: number }[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',')
    const day = Date.parse(`${cells[dateCol]}T00:00:00Z`)
    if (!Number.isFinite(day)) continue
    kpCols.forEach((col, slot) => {
      const cell = cells[col]
      if (cell == null || cell.trim() === '') return
      const tenths = Number(cell)
      if (!Number.isFinite(tenths)) return
      // Tenths of thirds: round back to the exact third.
      samples.push({ t: day + slot * SLOT_MS, kp: Math.round((tenths / 10) * 3) / 3 })
    })
  }
  return series(samples)
}

/** Kp at `ms`, interpolated between slot centres so playback fades rather
 * than steps. Null outside the data (or across a gap of more than a slot). */
export function kpAt(s: KpSeries, ms: number): number | null {
  const n = s.t.length
  if (n === 0) return null
  if (ms < s.t[0] || ms >= s.t[n - 1] + SLOT_MS + CARRY_MS) return null
  // Last slot starting at or before ms.
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (s.t[mid] <= ms) lo = mid
    else hi = mid - 1
  }
  const i = lo
  if (ms >= s.t[i] + SLOT_MS + (i === n - 1 ? CARRY_MS : 0)) return null // gap
  const centre = s.t[i] + SLOT_MS / 2
  const j = ms < centre ? i - 1 : i + 1
  if (j < 0 || j >= n || Math.abs(s.t[j] - s.t[i]) > SLOT_MS) return s.kp[i]
  const cj = s.t[j] + SLOT_MS / 2
  const f = (ms - centre) / (cj - centre)
  return s.kp[i] + f * (s.kp[j] - s.kp[i])
}

export type KpSourceKind = 'swpc' | 'swpc-forecast' | 'celestrak-recent' | 'celestrak-all'

/** The cheapest file that covers `simMs`; null when nothing can (past the
 * forecast, or before 1957). */
export function kpSourceFor(simMs: number, nowMs: number): KpSourceKind | null {
  if (simMs > nowMs + CARRY_MS) {
    return simMs <= nowMs + FORECAST_SPAN_MS ? 'swpc-forecast' : null
  }
  if (simMs < KP_ARCHIVE_FROM) return null
  if (simMs >= nowMs - SWPC_SPAN_MS) return 'swpc'
  if (simMs >= nowMs - RECENT_SPAN_MS) return 'celestrak-recent'
  return 'celestrak-all'
}

/** Lookup order: the freshest observations first, predictions last. */
const PRIORITY: readonly KpSourceKind[] = [
  'swpc',
  'celestrak-recent',
  'celestrak-all',
  'swpc-forecast',
]

/** The SWPC files change through the day; the archives don't. */
const LIVE: ReadonlySet<KpSourceKind> = new Set(['swpc', 'swpc-forecast'])

/** How long a source must be wanted before it is downloaded, so scrubbing
 * past 1990 doesn't start the 2.9 MB archive. */
export const KP_SETTLE_MS = 1500
/** Wait before retrying a failed download. */
export const KP_RETRY_MS = 5 * 60_000
/** Re-download the SWPC files this often while in use (the observations
 * update every slot). */
export const SWPC_REFRESH_MS = 30 * 60_000

interface SourceState {
  data: KpSeries | null
  loading: boolean
  /** Wall ms of the last finished attempt (success or failure). */
  at: number
  failed: boolean
}

export interface KpFeedDeps {
  load: (kind: KpSourceKind) => Promise<KpSeries>
}

/** Shared Kp state for every View's aurora. tick() is cheap and idempotent
 * within a frame. */
export function createKpFeed({ load }: KpFeedDeps) {
  const sources = new Map<KpSourceKind, SourceState>()
  let candidate: KpSourceKind | null = null
  let candidateSince = 0
  let generation = 0
  /** Latest wall-clock ms seen by tick; stamps finished downloads. */
  let wall = 0

  function lookup(ms: number): number | null {
    for (const kind of PRIORITY) {
      const data = sources.get(kind)?.data
      if (!data) continue
      const kp = kpAt(data, ms)
      if (kp != null) return kp
    }
    return null
  }

  function needsLoad(kind: KpSourceKind, wallMs: number): boolean {
    const s = sources.get(kind)
    if (!s) return true
    if (s.loading) return false
    if (s.failed) return wallMs - s.at >= KP_RETRY_MS
    return LIVE.has(kind) && wallMs - s.at >= SWPC_REFRESH_MS
  }

  function start(kind: KpSourceKind, wallMs: number) {
    const prev = sources.get(kind)
    const state: SourceState = {
      data: prev?.data ?? null,
      loading: true,
      at: prev?.at ?? wallMs,
      failed: false,
    }
    sources.set(kind, state)
    const gen = generation
    load(kind).then(
      (data) => {
        if (gen !== generation) return
        sources.set(kind, { data, loading: false, at: wall, failed: false })
      },
      (err: unknown) => {
        if (gen !== generation) return
        console.warn(`[aurora] Kp download failed (${kind})`, err)
        sources.set(kind, {
          data: state.data,
          loading: false,
          at: wall,
          failed: true,
        })
      }
    )
  }

  return {
    /** Kp for the sim time from whatever is loaded, or null (use DEFAULT_KP).
     * Starts downloads once the wanted source has settled. During a jump
     * only the target time matters. */
    tick(simMs: number, jumpToMs: number | null, wallMs: number, nowMs: number): number | null {
      wall = wallMs
      const target = jumpToMs ?? simMs
      const kp = lookup(target)
      const kind = kpSourceFor(target, nowMs)
      if (kind === null || !needsLoad(kind, wallMs)) {
        candidate = null
        return kp
      }
      // The first download starts at once; later ones once settled.
      const first = sources.size === 0
      if (candidate !== kind) {
        candidate = kind
        candidateSince = wallMs
      }
      if (first || wallMs - candidateSince >= KP_SETTLE_MS) {
        candidate = null
        start(kind, wallMs)
      }
      return kp
    },
    /** Drops in-flight downloads' results; loaded data is kept. */
    deactivate() {
      generation++
      candidate = null
      for (const [kind, s] of sources) {
        if (s.loading) {
          if (s.data) sources.set(kind, { ...s, loading: false })
          else sources.delete(kind)
        }
      }
    },
  }
}

export type KpFeed = ReturnType<typeof createKpFeed>
