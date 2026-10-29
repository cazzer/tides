// NOAA SWPC's OVATION aurora nowcast for the ovals near the present
// (tides-kzj.5.3): parsing, fitting the shader's per-MLT oval table to it,
// and the feed that decides when to download. No DOM; the fetching is
// injected (see renderers/ovationFeed.ts).
//
// https://services.swpc.noaa.gov/json/ovation_aurora_latest.json (CORS-open,
// ~0.9 MB, refreshed every few minutes): the chance of seeing aurora overhead,
// 0-100 %, on a 1°×1° geographic grid (both hemispheres) for "Forecast Time",
// about 30-90 min after "Observation Time" (the solar wind's travel time from
// L1).
//
// The grid is binned by geomagnetic latitude and MLT at the forecast time,
// with the same dipole the shader uses, so each MLT hour's profile gives that
// hour's oval edges and brightness directly. The overall activity is the Kp
// whose Gussenhoven diffuse edge (../aurora.ts) matches the nightside
// equatorward edge, which keeps the shader's storm cues (red tops, folding)
// and the hand-over to the Kp model consistent.
import * as THREE from 'three'
import {
  auroraActivity,
  diffuseEquatorwardLat,
  geomagneticAxis,
  latLonToLocal,
  OVAL_TABLE_HOURS,
  ovalAt,
  sunDirectionLocal,
} from './aurora'
import { earthSpin } from './ephemeris'

export const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json'

const DEG = Math.PI / 180
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const LONS = 360
const LATS = 181

export interface OvationGrid {
  observedMs: number
  forecastMs: number
  /** Percent, [lon * 181 + (lat + 90)] for lon 0..359 east, lat -90..90. */
  values: Uint8Array
}

/** {"Observation Time", "Forecast Time", "coordinates": [[lon, lat, %], ...]} */
export function parseOvation(json: unknown): OvationGrid {
  if (!json || typeof json !== 'object') throw new Error('OVATION: expected an object')
  const o = json as Record<string, unknown>
  const observedMs = Date.parse(String(o['Observation Time']))
  const forecastMs = Date.parse(String(o['Forecast Time']))
  const coords = o.coordinates
  if (!Number.isFinite(observedMs) || !Number.isFinite(forecastMs) || !Array.isArray(coords)) {
    throw new Error('OVATION: missing times or coordinates')
  }
  // Points left out (as in a trimmed copy) count as 0 %.
  const values = new Uint8Array(LONS * LATS)
  let n = 0
  for (const c of coords) {
    if (!Array.isArray(c)) continue
    const lon = Math.round(Number(c[0]))
    const lat = Math.round(Number(c[1]))
    const v = Number(c[2])
    if (!(lon >= 0 && lon < LONS && lat >= -90 && lat <= 90 && Number.isFinite(v))) continue
    values[lon * LATS + lat + 90] = Math.min(Math.max(Math.round(v), 0), 100)
    n++
  }
  if (n === 0) throw new Error('OVATION: no grid points')
  return { observedMs, forecastMs, values }
}

// --- Fitting ----------------------------------------------------------------

/** Lowest geomagnetic latitude binned; the profiles run from here to 90°. */
const MLAT_MIN = 40
const MLAT_BINS = 90 - MLAT_MIN + 1
/** An MLT hour whose peak chance is below this (%) has no oval to fit; its
 * edges come from the Kp model at the fitted Kp. */
const PEAK_FLOOR = 3
/** Fractions of an hour's peak that mark its edges. The diffuse edge's
 * fraction is set so the fitted Kp (1.2) matched SWPC's observed Kp (1.0) on
 * a quiet night, peak 13 % (2026-10-20, src/__fixtures__/swpc-ovation.json).
 * One calibration point: refit it against a storm-time file when one is
 * captured. */
const EQUATORWARD_FRACTION = 0.5
const DIFFUSE_FRACTION = 0.35
const POLEWARD_FRACTION = 0.3
/** MLT hours whose diffuse edge sets the fitted Kp: around magnetic midnight,
 * where Gussenhoven's fit is tightest and the oval reaches lowest. */
const KP_HOURS = [22, 23, 0, 1, 2]
/** Sector brightness kept where the nowcast shows nothing. */
const INTENSITY_FLOOR = 0.05

export interface OvationFit {
  observedMs: number
  forecastMs: number
  /** The Kp whose diffuse edge matches the nowcast's around midnight. */
  kp: number
  /** Peak chance of aurora, %. */
  peak: number
  /** Packed like ovalTable: (diffuse, equatorward, poleward, intensity). */
  table: Float32Array
}

/** Where `profile` falls through `level` walking from bin `from` by `step`,
 * interpolated, as a latitude; the profile's end if it never does. */
function crossing(profile: Float64Array, from: number, step: 1 | -1, level: number): number {
  let i = from
  while (i + step >= 0 && i + step < profile.length) {
    const next = i + step
    if (profile[next] < level) {
      const f = (profile[i] - level) / (profile[i] - profile[next])
      return MLAT_MIN + i + step * f
    }
    i = next
  }
  return MLAT_MIN + i
}

/** Kp that puts Gussenhoven's diffuse edge at `lat` for this MLT hour. */
function kpForDiffuseEdge(lat: number, hour: number): number {
  const at0 = diffuseEquatorwardLat(0, hour)
  const slope = diffuseEquatorwardLat(1, hour) - at0
  return (lat - at0) / slope
}

export function fitOvation(grid: OvationGrid): OvationFit {
  const t = grid.forecastMs
  const pole = geomagneticAxis(t)
  // The true frame: the fit is of the data, whatever the globe is showing.
  const sun = sunDirectionLocal(t, undefined, earthSpin)
  const midnight = sun.clone().addScaledVector(pole, -sun.dot(pole)).negate().normalize()
  const dawn = new THREE.Vector3().crossVectors(pole, midnight)

  const sum = new Float64Array(OVAL_TABLE_HOURS * MLAT_BINS)
  const count = new Float64Array(OVAL_TABLE_HOURS * MLAT_BINS)
  const n = new THREE.Vector3()
  for (let lon = 0; lon < LONS; lon++) {
    for (let lat = -90; lat <= 90; lat++) {
      latLonToLocal(lat, lon, n)
      const m = n.dot(pole)
      const mlat = Math.asin(Math.min(Math.abs(m), 1)) / DEG
      if (mlat < MLAT_MIN - 0.5) continue
      const angle = Math.atan2(n.dot(dawn), n.dot(midnight))
      const hour = (Math.round((angle / (2 * Math.PI)) * 24) + 24) % 24
      const bin = hour * MLAT_BINS + Math.min(Math.round(mlat) - MLAT_MIN, MLAT_BINS - 1)
      // Rows near the geographic poles crowd many longitudes into one cell.
      const w = Math.cos(lat * DEG) + 1e-3
      sum[bin] += w * grid.values[lon * LATS + lat + 90]
      count[bin] += w
    }
  }

  // Each hour's profile, lightly smoothed across neighbouring hours.
  const raw = (h: number, b: number) => {
    const i = ((h + 24) % 24) * MLAT_BINS + b
    return count[i] > 0 ? sum[i] / count[i] : 0
  }
  const profiles = Array.from({ length: OVAL_TABLE_HOURS }, (_, h) => {
    const p = new Float64Array(MLAT_BINS)
    for (let b = 0; b < MLAT_BINS; b++) {
      p[b] = 0.25 * raw(h - 1, b) + 0.5 * raw(h, b) + 0.25 * raw(h + 1, b)
    }
    return p
  })

  const peaks = profiles.map((p) => {
    let at = 0
    for (let b = 1; b < p.length; b++) if (p[b] > p[at]) at = b
    return { at, value: p[at] }
  })
  const peak = Math.max(...peaks.map((p) => p.value))

  const edges = profiles.map((p, h) => {
    const { at, value } = peaks[h]
    if (value < PEAK_FLOOR) return null
    return {
      diffuse: crossing(p, at, -1, DIFFUSE_FRACTION * value),
      equatorward: crossing(p, at, -1, EQUATORWARD_FRACTION * value),
      poleward: crossing(p, at, 1, POLEWARD_FRACTION * value),
    }
  })

  const kps = KP_HOURS.flatMap((h) => {
    const e = edges[h]
    return e ? [kpForDiffuseEdge(e.diffuse, h)] : []
  })
  const kp = kps.length
    ? Math.min(Math.max(kps.reduce((a, b) => a + b, 0) / kps.length, 0), 9)
    : 0
  const level = auroraActivity(kp)

  const table = new Float32Array(OVAL_TABLE_HOURS * 4)
  edges.forEach((e, h) => {
    const model = ovalAt(kp, h)
    const poleward = e ? e.poleward : model.polewardLat
    const equatorward = Math.min(e ? e.equatorward : model.equatorwardLat, poleward - 1)
    const diffuse = Math.min(e ? e.diffuse : model.diffuseLat, equatorward)
    const shape = peak > 0 ? peaks[h].value / peak : 0
    table[h * 4] = diffuse
    table[h * 4 + 1] = equatorward
    table[h * 4 + 2] = poleward
    table[h * 4 + 3] = level * (INTENSITY_FLOOR + (1 - INTENSITY_FLOOR) * shape)
  })

  return { observedMs: grid.observedMs, forecastMs: grid.forecastMs, kp, peak, table }
}

// --- Blending with the Kp model ---------------------------------------------

/** The nowcast counts fully from a little before its observation to a little
 * after its forecast time, then fades out over OVATION_FADE_MS. */
export const OVATION_MARGIN_MS = 30 * MINUTE
export const OVATION_FADE_MS = 2 * HOUR

/** How much the nowcast should count at `simMs`, 0..1. */
export function ovationWeight(fit: OvationFit, simMs: number): number {
  const from = fit.observedMs - OVATION_MARGIN_MS
  const to = fit.forecastMs + OVATION_MARGIN_MS
  const outside = simMs < from ? from - simMs : simMs > to ? simMs - to : 0
  return Math.max(0, 1 - outside / OVATION_FADE_MS)
}

/** Blends `fit`'s table into `table` (an ovalTable) by `weight`, in place. */
export function blendOvalTable(table: Float32Array, fit: OvationFit, weight: number) {
  for (let i = 0; i < table.length; i++) {
    table[i] += weight * (fit.table[i] - table[i])
  }
  return table
}

// --- Feed -------------------------------------------------------------------

/** Sim times this close to now may use the nowcast, so it is fetched. */
export const OVATION_WANT_MS = 3 * HOUR
/** How long the wanted nowcast must stay wanted before a later download. */
export const OVATION_SETTLE_MS = 1500
export const OVATION_RETRY_MS = 5 * MINUTE
/** SWPC updates the nowcast every few minutes; this is plenty for the oval. */
export const OVATION_REFRESH_MS = 10 * MINUTE

export interface OvationFeedDeps {
  load: () => Promise<OvationFit>
}

/** The latest nowcast fit for every View's aurora. tick() is cheap. */
export function createOvationFeed({ load }: OvationFeedDeps) {
  let fit: OvationFit | null = null
  let loading = false
  let failed = false
  /** Wall ms of the last finished attempt; -Infinity before the first. */
  let at = -Infinity
  let wantedSince: number | null = null
  let generation = 0
  let wall = 0

  function due(wallMs: number) {
    if (loading) return false
    if (failed) return wallMs - at >= OVATION_RETRY_MS
    return wallMs - at >= OVATION_REFRESH_MS
  }

  return {
    /** The latest fit (it may be for another time: see ovationWeight), or
     * null. Downloads while the sim time is near now. */
    tick(simMs: number, jumpToMs: number | null, wallMs: number, nowMs: number) {
      wall = wallMs
      const target = jumpToMs ?? simMs
      if (Math.abs(target - nowMs) > OVATION_WANT_MS || !due(wallMs)) {
        wantedSince = null
        return fit
      }
      wantedSince ??= wallMs
      // The first download starts at once; later ones once settled.
      if (at === -Infinity || wallMs - wantedSince >= OVATION_SETTLE_MS) {
        wantedSince = null
        loading = true
        const gen = generation
        load().then(
          (next) => {
            if (gen !== generation) return
            fit = next
            loading = false
            failed = false
            at = wall
          },
          (err: unknown) => {
            if (gen !== generation) return
            console.warn('[aurora] OVATION download failed', err)
            loading = false
            failed = true
            at = wall
          }
        )
      }
      return fit
    },
    /** Drops an in-flight download's result; a loaded fit is kept. */
    deactivate() {
      generation++
      loading = false
      wantedSince = null
    },
  }
}

export type OvationFeed = ReturnType<typeof createOvationFeed>
