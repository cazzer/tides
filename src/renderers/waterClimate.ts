// The sea's wave climate (tides-d9f.5): how rough the open ocean runs, where,
// and along which axis its waves travel, so the water's glint and swell can
// differ between the Southern Ocean and the doldrums.
//
// Baked offline by scripts/build-wave-climate.mjs from four days of
// Open-Meteo Marine data (Météo-France MFWAM), a season apart, into
// src/assets/earth-wave-climate.bin: CLIMATE_COLS × CLIMATE_ROWS RGBA8
// texels of CLIMATE_STEP degrees, rows north to south, columns east from
// longitude −180°. This module is the source of truth for that layout: the
// script encodes through it and the page decodes through it.
//
//   R  wind-wave height, sqrt(H / WIND_WAVE_MAX_M) · 255
//   G  cos 2θ of the dominant wave direction θ (compass), 127.5 + 127.5 x
//   B  sin 2θ, likewise
//   A  swell height, sqrt(H / SWELL_MAX_M) · 255
//
// Heights are means over the days; the direction is an axis (waves running
// either way along it look alike), the doubled angle averaged weighted by
// each day's total wave height, so its length says how settled it is.
// Land and ice are filled from the nearest sea so filtering doesn't pull
// coasts toward calm.
import * as THREE from 'three'
import climateUrl from '../assets/earth-wave-climate.bin?url&inline'

export const CLIMATE_COLS = 48
export const CLIMATE_ROWS = 24
export const CLIMATE_STEP = 7.5
export const CLIMATE_BYTES = CLIMATE_COLS * CLIMATE_ROWS * 4

/** The days sampled: a season apart, so the means span the year. */
export const DAYS = ['2025-01-15', '2025-04-15', '2025-07-15', '2025-10-15'] as const

const WIND_WAVE_MAX_M = 6
const SWELL_MAX_M = 8

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
  /** Compass bearing (degrees) of the dominant waves. */
  direction: number | null
}

/** A texel's climate: heights in metres, the axis as (cos 2θ, sin 2θ) of
 * length at most 1. */
export interface ClimateCell {
  windWave: number
  swell: number
  axisCos: number
  axisSin: number
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** The climate of a texel's days, or null if no day saw sea there. */
export function climateCell(days: readonly WaveDay[]): ClimateCell | null {
  const wind = days.flatMap((d) => (d.windWave === null ? [] : [d.windWave]))
  const swell = days.flatMap((d) => (d.swell === null ? [] : [d.swell]))
  if (wind.length === 0 || swell.length === 0) return null
  let weight = 0
  let c = 0
  let s = 0
  for (const d of days) {
    if (d.waveHeight === null || d.direction === null) continue
    const twice = 2 * d.direction * (Math.PI / 180)
    weight += d.waveHeight
    c += d.waveHeight * Math.cos(twice)
    s += d.waveHeight * Math.sin(twice)
  }
  return {
    windWave: mean(wind),
    swell: mean(swell),
    axisCos: weight > 0 ? c / weight : 0,
    axisSin: weight > 0 ? s / weight : 0,
  }
}

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
        next[j * CLIMATE_COLS + i] = {
          windWave: mean(around.map((c) => c.windWave)),
          swell: mean(around.map((c) => c.swell)),
          axisCos: mean(around.map((c) => c.axisCos)),
          axisSin: mean(around.map((c) => c.axisSin)),
        }
      }
    }
    known = next
  }
  return known as ClimateCell[]
}

const byte = (x: number) => Math.round(Math.min(255, Math.max(0, x)))

/** The asset's bytes of the texels' climates, gaps filled. */
export function encode(cells: readonly (ClimateCell | null)[]): Uint8Array {
  const filled = fillGaps(cells)
  const out = new Uint8Array(CLIMATE_BYTES)
  filled.forEach((c, k) => {
    out[k * 4] = byte(Math.sqrt(c.windWave / WIND_WAVE_MAX_M) * 255)
    out[k * 4 + 1] = byte(127.5 + 127.5 * c.axisCos)
    out[k * 4 + 2] = byte(127.5 + 127.5 * c.axisSin)
    out[k * 4 + 3] = byte(Math.sqrt(c.swell / SWELL_MAX_M) * 255)
  })
  return out
}

/** The texels' climates of the asset's bytes. */
export function decode(bytes: Uint8Array): ClimateCell[] {
  if (bytes.length !== CLIMATE_BYTES) {
    throw new Error(`wave climate: ${bytes.length} bytes, expected ${CLIMATE_BYTES}`)
  }
  return Array.from({ length: CLIMATE_COLS * CLIMATE_ROWS }, (_, k) => ({
    windWave: WIND_WAVE_MAX_M * (bytes[k * 4] / 255) ** 2,
    axisCos: (bytes[k * 4 + 1] - 127.5) / 127.5,
    axisSin: (bytes[k * 4 + 2] - 127.5) / 127.5,
    swell: SWELL_MAX_M * (bytes[k * 4 + 3] / 255) ** 2,
  }))
}

const GRAVITY = 9.81

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

/** The asset as a texture for waterClimateAt(). */
export function climateTexture(): THREE.DataTexture {
  const rgba = Uint8Array.from(atob(climateUrl.slice(climateUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
  if (rgba.length !== CLIMATE_BYTES) {
    throw new Error(`wave climate: ${rgba.length} bytes, expected ${CLIMATE_BYTES}`)
  }
  const texture = new THREE.DataTexture(rgba, CLIMATE_COLS, CLIMATE_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.unpackAlignment = 1
  texture.flipY = false
  texture.needsUpdate = true
  return texture
}

const f = (x: number) => x.toFixed(6)

/** The texture's lookup: waterClimateAt(up) is the raw texel at a local unit
 * direction, waterClimateDecode() its wind-wave and swell heights (m) and
 * doubled-angle axis (cos 2θ, sin 2θ; θ clockwise from north toward east). */
export const WATER_CLIMATE_GLSL = /* glsl */ `
uniform sampler2D uWaterClimate;

// climateUv() (./waterClimate.ts): v = 0 at the north, the asset's first row.
vec4 waterClimateAt(vec3 up) {
  float u = atan(up.z, -up.x) / 6.283185307179586;
  float v = 0.5 - asin(clamp(up.y, -1.0, 1.0)) / 3.141592653589793;
  return texture2D(uWaterClimate, vec2(fract(u), v));
}

vec4 waterClimateDecode(vec4 texel) {
  return vec4(
    ${f(WIND_WAVE_MAX_M)} * texel.r * texel.r,
    ${f(SWELL_MAX_M)} * texel.a * texel.a,
    texel.gb * 2.0 - 1.0
  );
}
`
