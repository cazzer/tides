// The sea's wave climate (tides-d9f.5): how rough the open ocean runs, where,
// and which way its waves travel (tides-nh8.2), so the water's glint and
// swell can differ between the Southern Ocean and the doldrums.
//
// The layout alone (no asset), so scripts/build-wave-climate.mjs can run on
// a checkout without one; ./waterClimate.ts loads the asset through it.
//
// Baked offline by scripts/build-wave-climate.mjs from four days of
// Open-Meteo Marine data (Météo-France MFWAM), a season apart, into
// src/assets/earth-wave-climate.bin: two planes of CLIMATE_COLS ×
// CLIMATE_ROWS RGBA8 texels of CLIMATE_STEP degrees, rows north to south,
// columns east from longitude −180°. This module is the source of truth for
// that layout: the script encodes through it and the page decodes through
// it. Plane 0 (the GPU's):
//
//   R  wind-wave height, sqrt(H / WIND_WAVE_MAX_M) · 255
//   G  cos θ of the dominant waves' heading θ, 127.5 + 127.5 x
//   B  sin θ, likewise
//   A  swell height, sqrt(H / SWELL_MAX_M) · 255
//
// and plane 1 (the CPU's, for the drawn waves under the eye):
//
//   R  cos θ of the wind waves' heading, 127.5 + 127.5 x
//   G  sin θ, likewise
//   B  cos θ of the swell's heading, likewise
//   A  sin θ, likewise
//
// A heading θ is the compass bearing the waves travel toward (clockwise
// from north toward east: the API's direction, where they come from, turned
// round). Heights are means over the days; each heading is the mean of its
// days' unit vectors, weighted by that day's height of the same waves (the
// dominant's by the total), so its length says how settled it is. Land and
// ice are filled from the nearest sea so filtering doesn't pull coasts
// toward calm.
export const CLIMATE_COLS = 48
export const CLIMATE_ROWS = 24
export const CLIMATE_STEP = 7.5
export const CLIMATE_PLANE_BYTES = CLIMATE_COLS * CLIMATE_ROWS * 4
export const CLIMATE_BYTES = 2 * CLIMATE_PLANE_BYTES

/** The days sampled: a season apart, so the means span the year. */
export const DAYS = ['2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15'] as const

/** The heights (m) the asset's bytes run to. */
export const WIND_WAVE_MAX_M = 6
export const SWELL_MAX_M = 8

/** The global ocean medians of the asset's wind-wave and swell heights (m),
 * printed by scripts/build-wave-climate.mjs; the scales are relative to them. */
export const WIND_WAVE_REF_M = 1.2
export const SWELL_REF_M = 2.05

/** Longitude (degrees east) of column i's texel centre. */
export function texelLon(i: number): number {
  return -180 + CLIMATE_STEP * (i + 0.5)
}

/** Latitude (degrees north) of row j's texel centre. */
export function texelLat(j: number): number {
  return 90 - CLIMATE_STEP * (j + 0.5)
}

/** One day's sample at a texel centre; null over land or ice. */
export interface WaveDay {
  waveHeight: number | null
  windWave: number | null
  swell: number | null
  /** Compass bearings (degrees) the dominant waves, the wind waves and the
   * swell come from. */
  direction: number | null
  windDirection: number | null
  swellDirection: number | null
}

/** A texel's climate: heights in metres, and the headings the dominant
 * waves, the wind waves and the swell travel toward as (cos θ, sin θ) of
 * length at most 1. */
export interface ClimateCell {
  windWave: number
  swell: number
  waveCos: number
  waveSin: number
  windCos: number
  windSin: number
  swellCos: number
  swellSin: number
}


const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** The climate of a texel's days, or null if no day saw sea there. */
export function climateCell(days: readonly WaveDay[]): ClimateCell | null {
  const wind = days.flatMap((d) => (d.windWave === null ? [] : [d.windWave]))
  const swell = days.flatMap((d) => (d.swell === null ? [] : [d.swell]))
  if (wind.length === 0 || swell.length === 0) return null
  const wave = heading(days.map((d) => [d.waveHeight, d.direction]))
  const windHeading = heading(days.map((d) => [d.windWave, d.windDirection]))
  const swellHeading = heading(days.map((d) => [d.swell, d.swellDirection]))
  return {
    windWave: mean(wind),
    swell: mean(swell),
    waveCos: wave[0],
    waveSin: wave[1],
    windCos: windHeading[0],
    windSin: windHeading[1],
    swellCos: swellHeading[0],
    swellSin: swellHeading[1],
  }
}

/** The mean heading (cos θ, sin θ) of days' (height, direction the waves
 * come from) pairs, weighted by height: the direction turned round. */
function heading(days: readonly [number | null, number | null][]): [number, number] {
  let weight = 0
  let c = 0
  let s = 0
  for (const [height, from] of days) {
    if (height === null || from === null) continue
    const toward = (from + 180) * (Math.PI / 180)
    weight += height
    c += height * Math.cos(toward)
    s += height * Math.sin(toward)
  }
  return weight > 0 ? [c / weight, s / weight] : [0, 0]
}

const meanCell = (cells: readonly ClimateCell[]): ClimateCell => ({
  windWave: mean(cells.map((c) => c.windWave)),
  swell: mean(cells.map((c) => c.swell)),
  waveCos: mean(cells.map((c) => c.waveCos)),
  waveSin: mean(cells.map((c) => c.waveSin)),
  windCos: mean(cells.map((c) => c.windCos)),
  windSin: mean(cells.map((c) => c.windSin)),
  swellCos: mean(cells.map((c) => c.swellCos)),
  swellSin: mean(cells.map((c) => c.swellSin)),
})

/** Fills the null texels (land, ice) by repeatedly averaging their known
 * 4-neighbours, wrapping in longitude, until every texel is known. */
export function fillGaps(cells: readonly (ClimateCell | null)[]): ClimateCell[] {
  if (cells.length !== CLIMATE_COLS * CLIMATE_ROWS) {
    throw new Error(`wave climate: ${cells.length} texels, expected ${CLIMATE_COLS * CLIMATE_ROWS}`)
  }
  if (cells.every((c) => c === null)) throw new Error('wave climate: no sea at all')
  let known = cells.slice()
  while (known.some((c) => c === null)) {
    const next = known.slice()
    for (let j = 0; j < CLIMATE_ROWS; j++) {
      for (let i = 0; i < CLIMATE_COLS; i++) {
        if (known[j * CLIMATE_COLS + i] !== null) continue
        const around = [
          known[j * CLIMATE_COLS + ((i + 1) % CLIMATE_COLS)],
          known[j * CLIMATE_COLS + ((i + CLIMATE_COLS - 1) % CLIMATE_COLS)],
          j > 0 ? known[(j - 1) * CLIMATE_COLS + i] : null,
          j < CLIMATE_ROWS - 1 ? known[(j + 1) * CLIMATE_COLS + i] : null,
        ].filter((c): c is ClimateCell => c !== null)
        if (around.length === 0) continue
        next[j * CLIMATE_COLS + i] = meanCell(around)
      }
    }
    known = next
  }
  return known as ClimateCell[]
}

const byte = (x: number) => Math.round(Math.min(255, Math.max(0, x)))
const signed = (x: number) => byte(127.5 + 127.5 * x)
const unsigned = (b: number) => (b - 127.5) / 127.5

/** The asset's bytes of the texels' climates, gaps filled. */
export function encode(cells: readonly (ClimateCell | null)[]): Uint8Array {
  const filled = fillGaps(cells)
  const out = new Uint8Array(CLIMATE_BYTES)
  filled.forEach((c, k) => {
    out.set([byte(Math.sqrt(c.windWave / WIND_WAVE_MAX_M) * 255), signed(c.waveCos), signed(c.waveSin), byte(Math.sqrt(c.swell / SWELL_MAX_M) * 255)], k * 4)
    out.set([signed(c.windCos), signed(c.windSin), signed(c.swellCos), signed(c.swellSin)], CLIMATE_PLANE_BYTES + k * 4)
  })
  return out
}

/** The texels' climates of the asset's bytes. */
export function decode(bytes: Uint8Array): ClimateCell[] {
  if (bytes.length !== CLIMATE_BYTES) {
    throw new Error(`wave climate: ${bytes.length} bytes, expected ${CLIMATE_BYTES}`)
  }
  return Array.from({ length: CLIMATE_COLS * CLIMATE_ROWS }, (_, k) => {
    const [r, g, b, a] = bytes.subarray(k * 4, k * 4 + 4)
    const [wc, ws, sc, ss] = bytes.subarray(CLIMATE_PLANE_BYTES + k * 4, CLIMATE_PLANE_BYTES + k * 4 + 4)
    return {
      windWave: WIND_WAVE_MAX_M * (r / 255) ** 2,
      swell: SWELL_MAX_M * (a / 255) ** 2,
      waveCos: unsigned(g),
      waveSin: unsigned(b),
      windCos: unsigned(wc),
      windSin: unsigned(ws),
      swellCos: unsigned(sc),
      swellSin: unsigned(ss),
    }
  })
}

/** A heading's compass bearing (degrees, 0 to 360) of its (cos θ, sin θ). */
export function bearing(cos: number, sin: number): number {
  const deg = Math.atan2(sin, cos) * (180 / Math.PI)
  return deg < 0 ? deg + 360 : deg
}

export const GRAVITY = 9.81

/** Cox and Munk's mean square slope of a sea whose wind waves run H metres
 * high, through the wind U of a fully developed sea (H = 0.21 U² / g). */
export function coxMunkMss(windWaveM: number): number {
  const wind = Math.sqrt((GRAVITY * Math.max(0, windWaveM)) / 0.21)
  return 0.003 + 0.00512 * wind
}

/** The slope variance relative to the median sea's. */
export function mssScale(windWaveM: number): number {
  return Math.min(2, Math.max(0.5, coxMunkMss(windWaveM) / coxMunkMss(WIND_WAVE_REF_M)))
}

/** The swell's amplitude relative to the median sea's. */
export function swellScale(swellM: number): number {
  return Math.min(2, Math.max(0.4, swellM / SWELL_REF_M))
}

type Vec3 = readonly [number, number, number]

/** waterClimateAt()'s texture coordinates of a local direction (lon 0 on +X,
 * east toward −Z, north on +Y): u from longitude −180°, v = 0 at the north,
 * where the asset's first row lies (uploaded without a flip). */
export function climateUv([x, y, z]: Vec3): [number, number] {
  const u = Math.atan2(z, -x) / (2 * Math.PI)
  return [u - Math.floor(u), 0.5 - Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI]
}

/** Unit east and north tangents at a local direction (not at the poles). */
export function localEastNorth([x, y, z]: Vec3): { east: [number, number, number]; north: [number, number, number] } {
  const length = Math.hypot(x, y, z)
  const [ux, uy, uz] = [x / length, y / length, z / length]
  const flat = Math.hypot(ux, uz)
  const east: [number, number, number] = [uz / flat, 0, -ux / flat]
  const north: [number, number, number] = [
    uy * east[2] - uz * east[1],
    uz * east[0] - ux * east[2],
    ux * east[1] - uy * east[0],
  ]
  return { east, north }
}


/** The climate at a local direction as waterClimateAt() reads it, on the
 * CPU (tides-nh8.1): bilinear between texel centres, the longitude wrapped,
 * the latitude clamped. */
export function climateAt(cells: readonly ClimateCell[], up: Vec3): ClimateCell {
  const [u, v] = climateUv(up)
  const x = u * CLIMATE_COLS - 0.5
  const y = Math.min(Math.max(v * CLIMATE_ROWS - 0.5, 0), CLIMATE_ROWS - 1)
  const i = Math.floor(x)
  const j = Math.min(Math.floor(y), CLIMATE_ROWS - 2)
  const fx = x - i
  const fy = y - j
  const at = (col: number, row: number) => cells[row * CLIMATE_COLS + ((col + CLIMATE_COLS) % CLIMATE_COLS)]
  const corners: [ClimateCell, number][] = [
    [at(i, j), (1 - fx) * (1 - fy)],
    [at(i + 1, j), fx * (1 - fy)],
    [at(i, j + 1), (1 - fx) * fy],
    [at(i + 1, j + 1), fx * fy],
  ]
  const blend = (key: keyof ClimateCell) => corners.reduce((sum, [c, weight]) => sum + c[key] * weight, 0)
  return {
    windWave: blend('windWave'),
    swell: blend('swell'),
    waveCos: blend('waveCos'),
    waveSin: blend('waveSin'),
    windCos: blend('windCos'),
    windSin: blend('windSin'),
    swellCos: blend('swellCos'),
    swellSin: blend('swellSin'),
  }
}
