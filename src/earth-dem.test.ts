import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  CEILING_ARC_DEG,
  CLOUD_FLAT_ALTITUDE,
  CEILING_GREY_MARGIN,
  TERRAIN_DISPLACEMENT,
  TERRAIN_MAX_GREY,
  TERRAIN_READ_TEXELS,
  directionToUv,
  type Vec3,
} from './cloud-layer'
import {
  DEM_METRES_PER_UNIT,
  boxMips,
  decodeEarthDem,
  demLevel,
  halveDem,
  maxPoolDem,
  packEarthDem,
  toHalfBits,
  unpackEarthDem,
  type DemLevel,
  type EarthDem,
} from './earth-dem'
import { earthDemTexture } from './renderers/earthDemTexture'

const shipped = (name: string) => decodeEarthDem(readFileSync(new URL(`./assets/${name}`, import.meta.url)))
const [dem4k, dem2k, demMax] = await Promise.all(
  ['earth-dem-4k.bin', 'earth-dem-2k.bin', 'earth-dem-max.bin'].map(shipped)
)

/** Displacement units at a latitude and longitude, from a north-first DEM. */
function heightAt({ width, height, metres }: EarthDem, lat: number, lon: number): number {
  const y = Math.min(height - 1, Math.floor(((90 - lat) / 180) * height))
  const x = Math.min(width - 1, Math.floor(((lon + 180) / 360) * width))
  return metres[y * width + x] / DEM_METRES_PER_UNIT
}

const maxOf = (values: ArrayLike<number>) => {
  let max = -Infinity
  for (let k = 0; k < values.length; k++) max = Math.max(max, values[k])
  return max
}

// The mip the cloud march reads its ground from (cloudShaders.ts cloudTerrain()).
const readMip = (dem: EarthDem) => boxMips(demLevel(dem)).find((level) => level.width === TERRAIN_READ_TEXELS)!
const marchMips = [readMip(dem4k), readMip(dem2k)]

describe('Earth DEM format', () => {
  it('round-trips heights through its packing, deltas wrapping both ways', () => {
    const metres = Uint16Array.from({ length: 24 }, (_, k) => [0, 65535, 1, 8848, 0, 300][k % 6] + (k % 5))
    const dem = { width: 6, height: 4, metres }
    expect(unpackEarthDem(packEarthDem(dem))).toEqual(dem)
  })

  it('rejects a file that is not one', () => {
    expect(() => unpackEarthDem(new Uint8Array(16))).toThrow()
    const packed = packEarthDem({ width: 2, height: 1, metres: Uint16Array.of(1, 2) })
    expect(() => unpackEarthDem(packed.subarray(0, packed.length - 1))).toThrow()
  })

  it('builds box mips down to 1 × 1, each the mean of the texels it covers', () => {
    const base: DemLevel = { width: 8, height: 4, data: Float32Array.from({ length: 32 }, (_, k) => k) }
    const mips = boxMips(base)
    expect(mips.map(({ width, height }) => [width, height])).toEqual([
      [8, 4],
      [4, 2],
      [2, 1],
      [1, 1],
    ])
    expect(mips[1].data[0]).toBeCloseTo((0 + 1 + 8 + 9) / 4, 6)
    expect(mips[3].data[0]).toBeCloseTo(15.5, 6)
  })
})

describe('shipped Earth DEMs (scripts/build-earth-dem.mjs)', () => {
  it('ship as built: the 2k map is the 4k one halved, the max map its 8 × 8 maxima', () => {
    expect([dem4k.width, dem4k.height, dem2k.width, dem2k.height, demMax.width, demMax.height]).toEqual([
      4096, 2048, 2048, 1024, 512, 256,
    ])
    // The first height that differs, if any.
    const differs = (a: EarthDem, b: EarthDem) => a.metres.findIndex((m, k) => m !== b.metres[k])
    expect(differs(dem2k, halveDem(dem4k))).toBe(-1)
    expect(differs(demMax, maxPoolDem(dem4k, 8))).toBe(-1)
    // So the max map bounds the 2k one too.
    expect(maxPoolDem(dem2k, 4).metres.findIndex((m, k) => m > demMax.metres[k])).toBe(-1)
  })

  it('stands the peaks the 8-bit bump map clipped, and the plateaus where they are', () => {
    expect(heightAt(dem4k, 27.988, 86.925)).toBeGreaterThan(0.9) // Everest
    expect(heightAt(dem4k, 35.881, 76.513)).toBeGreaterThan(0.85) // K2
    const altiplano = heightAt(dem4k, -17.5, -67.5)
    expect(altiplano).toBeGreaterThan(0.55)
    expect(altiplano).toBeLessThan(0.65)
    const canyon = heightAt(dem4k, 36.1, -112.1)
    expect(canyon).toBeGreaterThan(0.2)
    expect(canyon).toBeLessThan(0.35)
    expect(heightAt(dem4k, -89.9, 0)).toBeCloseTo(0.43, 1) // the south pole's ice
  })

  it('holds the sea and land below it at 0', () => {
    expect(heightAt(dem4k, 31.5, 35.5)).toBe(0) // Dead Sea
    expect(heightAt(dem4k, 0, -150)).toBe(0)
    expect(heightAt(dem4k, -45, -120)).toBe(0)
    expect(heightAt(dem4k, 88, 0)).toBe(0) // north of Web Mercator's reach
  })

  it('joins the polar cap without a step at 85°S, and the date line without a seam', () => {
    const { width, height, metres } = dem4k
    const rowStep = (j: number) => {
      let sum = 0
      for (let i = 0; i < width; i++) sum += Math.abs(metres[j * width + i] - metres[(j + 1) * width + i])
      return sum / width
    }
    // The row where Web Mercator stops, against the rows around it: the
    // cap and the DEM differ by ~75 m on average, which a hard seam would
    // add to its step.
    const seam = Math.floor(((90 - 85.05) / 180) * height) + Math.floor(height / 2) - 1
    let around = 0
    for (const d of [-6, -5, -4, -3, -2, 2, 3, 4, 5, 6]) around += rowStep(seam + d) / 10
    for (const d of [-1, 0, 1]) expect(rowStep(seam + d)).toBeLessThan(1.25 * around)
    let dateLine = 0
    let meridian = 0
    for (let j = 0; j < height; j++) {
      dateLine += Math.abs(metres[j * width] - metres[j * width + width - 1])
      meridian += Math.abs(metres[j * width + width / 2] - metres[j * width + width / 2 - 1])
    }
    expect(dateLine).toBeLessThan(1.5 * meridian)
  })

  it('reaches the texture as half floats within half a step, rows south first', () => {
    for (let m = 0; m <= 9000; m += 7) {
      const h = m / DEM_METRES_PER_UNIT
      const half = THREE.DataUtils.fromHalfFloat(toHalfBits(h))
      // A half's step is 2^-10 of its power of two.
      expect(Math.abs(half - h)).toBeLessThanOrEqual(2 ** (Math.floor(Math.log2(Math.max(h, 2 ** -14))) - 11) + 1e-12)
    }
    for (const h of [0, 2 ** -24, 2 ** -14 - 2 ** -26, 0.75, 1 - 2 ** -13, 1.5]) {
      expect(THREE.DataUtils.fromHalfFloat(toHalfBits(h))).toBeCloseTo(h, 3)
    }
    expect(toHalfBits(1 - 2 ** -13)).toBe(THREE.DataUtils.toHalfFloat(1))
    const small = { width: 4, height: 2, metres: Uint16Array.of(0, 0, 0, 0, 1000, 2000, 3000, 4000) }
    const texture = earthDemTexture(small)
    const base = texture.mipmaps[0] as { data: Uint16Array; width: number }
    // A half's step is 1–2 m at these heights.
    Array.from(base.data.subarray(0, 4), THREE.DataUtils.fromHalfFloat).forEach((h, x) =>
      expect(Math.abs(h * DEM_METRES_PER_UNIT - 1000 * (x + 1))).toBeLessThan(1)
    )
    expect(texture.mipmaps.length).toBe(3)
    expect(texture.type).toBe(THREE.HalfFloatType)
    expect(texture.format).toBe(THREE.RedFormat)
    expect(texture.generateMipmaps).toBe(false)
    texture.dispose()
  })
})

// The cloud layer's bounds, still 8-bit until tides-zmw.1's second step moves
// them to the DEM: its relief bound and flat deck (TERRAIN_MAX_GREY,
// TERRAIN_MAX_GREY_FLAT, from the old bump maps) and the cloud ceiling (built
// from the DEM's max map rounded up to 8 bits).
describe('the 8-bit cloud bounds over the DEM (tides-zmw.1)', () => {
  it("keeps the march's ground under its relief bound, and the low tier's ground under the flat deck", () => {
    for (const mip of marchMips) expect(maxOf(mip.data)).toBeLessThanOrEqual(TERRAIN_MAX_GREY)
    const lowGround = maxOf(dem2k.metres) / DEM_METRES_PER_UNIT
    expect(lowGround * TERRAIN_DISPLACEMENT).toBeLessThan(CLOUD_FLAT_ALTITUDE)
  })

  it("keeps earth-cloud-ceiling.bin over the ground the march reads within its arc", () => {
    const W = 512
    const H = 256
    const ceiling = new Uint8Array(readFileSync(new URL('./assets/earth-cloud-ceiling.bin', import.meta.url)))
    const atUv = ([u, v]: [number, number]) => ceiling[Math.min(H - 1, Math.floor((1 - v) * H)) * W + Math.min(W - 1, Math.floor(u * W))]
    // The bilinear read's taps at uv, at their highest, in grey levels.
    const groundRead = ({ width, height, data }: DemLevel, [u, v]: [number, number]) => {
      const x = u * width - 0.5
      const y = Math.min(Math.max((1 - v) * height - 0.5, 0), height - 1)
      const i0 = Math.floor(x)
      const j0 = Math.floor(y)
      let max = 0
      for (const i of [i0, i0 + 1]) {
        for (const j of [j0, Math.min(j0 + 1, height - 1)]) max = Math.max(max, data[j * width + ((i + width) % width)])
      }
      return max * 255
    }
    let seed = 1
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    const unit = (p: Vec3): Vec3 => {
      const l = Math.hypot(...p)
      return [p[0] / l, p[1] / l, p[2] / l]
    }
    const randomUnit = (): Vec3 => {
      const z = 2 * random() - 1
      const a = 2 * Math.PI * random()
      const r = Math.sqrt(1 - z * z)
      return [r * Math.cos(a), z, r * Math.sin(a)]
    }
    const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    for (let n = 0; n < 20000; n++) {
      const p = n % 10 ? randomUnit() : unit([random() - 0.5, n % 20 ? 20 : -20, random() - 0.5])
      const t = unit(cross(p, randomUnit()))
      const a = (random() * CEILING_ARC_DEG * Math.PI) / 180
      const x = [0, 1, 2].map((c) => p[c] * Math.cos(a) + t[c] * Math.sin(a)) as Vec3
      for (const mip of marchMips) {
        expect(atUv(directionToUv(p))).toBeGreaterThanOrEqual(groundRead(mip, directionToUv(x)) + CEILING_GREY_MARGIN)
      }
    }
  })
})
