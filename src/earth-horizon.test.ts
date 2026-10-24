import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TERRAIN_DISPLACEMENT } from './cloud-layer'
import type { DemLevel } from './earth-dem'
import {
  HORIZON_BITS,
  HORIZON_DIRECTIONS,
  HORIZON_WIDTH,
  bakeHorizon,
  decodeEarthHorizon,
  horizonAngle,
  horizonAt,
  horizonTangentScale,
  packEarthHorizon,
  skyVisibility,
  sunVisibility,
  unpackEarthHorizon,
  type EarthHorizon,
  type HorizonBakeOptions,
} from './earth-horizon'
import { sceneRadius } from './planets'
import { earthHorizonTexture } from './renderers/earthHorizonTexture'

const D = Math.PI / 180
const N = 0
const E = 2
const S = 4
const W = 6
// The ground's exaggeration: about 25x.
const E_REF = TERRAIN_DISPLACEMENT / sceneRadius(12742000)

const ASSET = new URL('./assets/earth-horizon-1k.bin', import.meta.url)
const shippedFile = readFileSync(ASSET)
const shipped = await decodeEarthHorizon(shippedFile)

/** A flat level of width × height with `raise(x, y)` added. */
function level(width: number, height: number, raise: (x: number, y: number) => number = () => 0): DemLevel {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = raise(x, y)
  return { width, height, data }
}

// 1.4° texels: wide enough for a quick bake, searched further to match.
const WIDE: HorizonBakeOptions = { eRef: E_REF, radiusKm: 1000, firstKm: 50 }

/** Every direction's angle at texel x, y (radians). */
const at = (map: EarthHorizon, x: number, y: number) => horizonAt(map, x, y)

describe('Earth horizon format', () => {
  it('round-trips through its packing', () => {
    const map: EarthHorizon = {
      width: 3,
      height: 2,
      directions: 8,
      bits: 6,
      eRef: 0.025,
      angles: Uint8Array.from({ length: 48 }, (_, k) => (k * 7) % 64),
    }
    const back = unpackEarthHorizon(packEarthHorizon(map))
    expect(back).toEqual({ ...map, eRef: Math.fround(0.025) })
  })

  it('rejects a file that is not one', () => {
    expect(() => unpackEarthHorizon(new Uint8Array(20))).toThrow()
    const packed = packEarthHorizon({ width: 1, height: 1, directions: 8, bits: 6, eRef: 1, angles: new Uint8Array(8) })
    expect(() => unpackEarthHorizon(packed.subarray(0, packed.length - 1))).toThrow()
  })
})

describe('horizon bake', () => {
  it('reads nothing over flat ground and the sea', () => {
    const map = bakeHorizon(level(64, 32, () => 0.3), WIDE)
    expect(map.angles.every((a) => a === 0)).toBe(true)
    expect(map).toMatchObject({ width: 64, height: 32, directions: HORIZON_DIRECTIONS, bits: HORIZON_BITS })
  })

  it("shadows a north-south ridge's east side toward the west at a low Sun only", () => {
    const ridge = bakeHorizon(level(256, 128, (x) => (x === 128 ? 0.25 : 0)), WIDE)
    const lee = at(ridge, 129, 64)
    expect(lee[W] / D).toBeGreaterThan(10)
    expect(lee[W] / D).toBeLessThan(25)
    expect(lee[E]).toBe(0)
    expect(sunVisibility(lee, 1, 270 * D, 5 * D)).toBe(0)
    expect(sunVisibility(lee, 1, 270 * D, 30 * D)).toBe(1)
    // The Sun rising in the east is clear of it, as is the ridge itself.
    expect(sunVisibility(lee, 1, 90 * D, 5 * D)).toBe(1)
    expect(at(ridge, 128, 64).every((a) => a === 0)).toBe(true)
  })

  it('leaves a valley less of the sky than the crests either side', () => {
    const valley = bakeHorizon(level(256, 128, (x) => (x === 127 || x === 129 ? 0.6 : 0)), WIDE)
    const floor = skyVisibility(at(valley, 128, 64), 1)
    expect(skyVisibility(at(valley, 127, 64), 1)).toBe(1)
    expect(floor).toBeLessThan(0.9)
    // Steeper with the exaggeration.
    expect(skyVisibility(at(valley, 128, 64), 2)).toBeLessThan(floor)
  })

  it('sees a ridge on the date line from across it', () => {
    const ridge = bakeHorizon(level(256, 128, (x) => (x === 0 ? 0.25 : 0)), WIDE)
    const west = at(ridge, 255, 64)
    expect(west[E] / D).toBeGreaterThan(10)
    expect(sunVisibility(west, 1, 90 * D, 5 * D)).toBe(0)
    expect(at(ridge, 1, 64)[W]).toBe(west[E])
  })

  it('sees a peak near the pole from the far meridian, across the pole', () => {
    // 0.5° texels; the peak at 89.75°N, 0.25°E; the eye at 88.25°N, 179.75°W.
    const polar = bakeHorizon(level(720, 360, (x, y) => (x === 360 && y === 0 ? 1 : 0)), { eRef: E_REF })
    const eye = at(polar, 0, 3)
    expect(eye[N] / D).toBeGreaterThan(20)
    expect(eye[S]).toBe(0)
  })

  it('takes a map to another exaggeration by scaling its tangents', () => {
    const hills = level(256, 128, (x, y) => 0.15 * (1 + Math.sin(x * 0.37) * Math.cos(y * 0.53 + x * 0.11)))
    const at25 = bakeHorizon(hills, WIDE)
    const at10 = bakeHorizon(hills, { ...WIDE, eRef: (E_REF * 10) / 25 })
    const step = horizonAngle(1, HORIZON_BITS)
    let worst = 0
    let total = 0
    for (let k = 0; k < at25.angles.length; k++) {
      const scaled = Math.atan(0.4 * Math.tan(horizonAngle(at25.angles[k], HORIZON_BITS)))
      const error = Math.abs(scaled - horizonAngle(at10.angles[k], HORIZON_BITS))
      worst = Math.max(worst, error)
      total += error
    }
    expect(worst).toBeLessThanOrEqual(step)
    expect(total / at25.angles.length).toBeLessThan(step / 3)
    expect(horizonTangentScale(TERRAIN_DISPLACEMENT * 0.4, sceneRadius(12742000), E_REF)).toBeCloseTo(0.4, 6)
  })
})

describe('shading from the horizon', () => {
  const flat = new Array(8).fill(0)
  const range = [0, 0, 0, 0, 0, 0, 20 * D, 0]

  it('leaves unobstructed ground exactly as lit as before, at any Sun', () => {
    for (const elevation of [-10, -0.5, 0, 0.5, 3, 60]) expect(sunVisibility(flat, 1, 1.3, elevation * D)).toBe(1)
    expect(skyVisibility(flat, 1)).toBe(1)
  })

  it('softens the edge and blends between directions', () => {
    expect(sunVisibility(range, 1, 270 * D, 20 * D)).toBeCloseTo(0.5, 6)
    // Half-way to the next direction, the horizon is half as high.
    expect(sunVisibility(range, 1, 292.5 * D, 10 * D)).toBeCloseTo(0.5, 6)
    expect(sunVisibility(range, 1, 315 * D, 3 * D)).toBe(1)
  })
})

describe('shipped horizon map', () => {
  const texel = (lat: number, lon: number) =>
    at(
      shipped,
      Math.floor(((lon + 180) / 360) * shipped.width),
      Math.floor(((90 - lat) / 180) * shipped.height)
    )

  it('is the size the renderer expects, at the ground exaggeration, within its budget', () => {
    expect(shipped).toMatchObject({ width: HORIZON_WIDTH, height: HORIZON_WIDTH / 2, directions: 8, bits: 6 })
    expect(shipped.eRef).toBeCloseTo(E_REF, 6)
    expect(shippedFile.length).toBeLessThanOrEqual(500_000)
  })

  it('stands the Andes over Mendoza to the west and Santiago to the east', () => {
    const mendoza = texel(-32.89, -68.83)
    const santiago = texel(-33.45, -70.67)
    expect(Math.max(mendoza[W], mendoza[W + 1]) / D).toBeGreaterThan(30)
    expect(Math.max(santiago[E - 1], santiago[E]) / D).toBeGreaterThan(30)
    expect(mendoza[E] / D).toBeLessThan(10)
    expect(skyVisibility(santiago, 1)).toBeLessThan(0.9)
    expect(texel(0, -150).every((a) => a === 0)).toBe(true)
  })
})

describe('horizon texture', () => {
  it('packs N-SE into layer 0 and S-NW into layer 1, rows south first', () => {
    const angles = new Uint8Array(8 * 2 * 2)
    // Texel x = 1 of the north row: direction d holds 10 + d.
    for (let d = 0; d < 8; d++) angles[d * 4 + 1] = 10 + d
    const texture = earthHorizonTexture({ width: 2, height: 2, directions: 8, bits: 6, eRef: 1, angles })
    const data = texture.image.data as Uint8Array
    // Layer l, row 1 (north, as v = 1), column 1, channel c.
    const read = (l: number, c: number) => data[l * 16 + (1 * 2 + 1) * 4 + c]
    expect([0, 1, 2, 3].map((c) => read(0, c))).toEqual([10, 11, 12, 13])
    expect([0, 1, 2, 3].map((c) => read(1, c))).toEqual([14, 15, 16, 17])
    expect(texture.image.depth).toBe(2)
  })
})
