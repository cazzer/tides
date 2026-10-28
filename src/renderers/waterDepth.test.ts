// The sea's depth under the water's body (tides-d9f.6): the encoding, the
// floor's ramp (the open ocean's exactly the old WATER_DEEP), and the
// shipped maps (scripts/build-earth-bathy.mjs) on the right grid.
import { readFileSync, statSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  decodeWaterDepth,
  encodeWaterDepth,
  WATER_DEEP,
  WATER_DEPTH_GLSL,
  WATER_DEPTH_MAX,
  WATER_DEPTH_NEUTRAL,
  WATER_DEPTH_SAMPLE,
  WATER_SHALLOW,
  WATER_SHELF,
  WATER_TRENCH,
  waterFloor,
} from './waterDepth'

const luma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

describe('the depth\'s encoding', () => {
  it('runs 0 to 255 over 0 to WATER_DEPTH_MAX, monotonically, and round trips', () => {
    expect(encodeWaterDepth(0)).toBe(0)
    expect(encodeWaterDepth(-50)).toBe(0)
    expect(encodeWaterDepth(WATER_DEPTH_MAX)).toBe(255)
    expect(encodeWaterDepth(2 * WATER_DEPTH_MAX)).toBe(255)
    let last = 0
    for (let m = 0; m <= WATER_DEPTH_MAX; m += 10) {
      const level = encodeWaterDepth(m)
      expect(level).toBeGreaterThanOrEqual(last)
      last = level
    }
    for (let level = 0; level <= 255; level++) expect(encodeWaterDepth(decodeWaterDepth(level))).toBe(level)
  })

  it('gives the shallows the finer steps', () => {
    expect(decodeWaterDepth(1)).toBeLessThan(0.2)
    expect(decodeWaterDepth(20) - decodeWaterDepth(19)).toBeLessThan(7)
  })
})

describe('the floor', () => {
  it('runs turquoise, shelf blue, deep water, trench navy', () => {
    waterFloor(0).forEach((x, i) => expect(x).toBeCloseTo(WATER_SHALLOW[i], 12))
    waterFloor(200).forEach((x, i) => expect(x).toBeCloseTo(WATER_SHELF[i], 12))
    waterFloor(9000).forEach((x, i) => expect(x).toBeCloseTo(WATER_TRENCH[i], 12))
    waterFloor(11000).forEach((x, i) => expect(x).toBeCloseTo(WATER_TRENCH[i], 12))
  })

  it('is exactly the old deep water over the open ocean, and the neutral fill', () => {
    for (let d = 2000; d <= 5500; d += 250) expect(waterFloor(d)).toEqual([...WATER_DEEP])
    expect(waterFloor(decodeWaterDepth(encodeWaterDepth(WATER_DEPTH_NEUTRAL)))).toEqual([...WATER_DEEP])
  })

  it('never lightens with depth', () => {
    let last = Infinity
    for (let d = 0; d <= WATER_DEPTH_MAX; d += 25) {
      const l = luma(waterFloor(d))
      expect(l).toBeLessThanOrEqual(last + 1e-15)
      last = l
    }
  })

  it('has its GLSL twin and each chain\'s sample', () => {
    expect(WATER_DEPTH_GLSL).toContain('uniform sampler2D uWaterDepth;')
    expect(WATER_DEPTH_GLSL).toContain('vec3 waterFloor(float d)')
    expect(WATER_DEPTH_SAMPLE.globe).toContain('#ifdef USE_SPECULARMAP')
    expect(WATER_DEPTH_SAMPLE.globe).toContain('texture2D(uWaterDepth, vSpecularMapUv).r')
    expect(WATER_DEPTH_SAMPLE.tiles).toContain('surfaceGlobeTex(uWaterDepth, surfaceGlobeUv).r')
  })
})

/** An 8-bit grey PNG's levels (no interlace): enough for the shipped maps. */
function decodeGreyPng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  let width = 0
  let height = 0
  let depth = 0
  let colour = -1
  let interlace = -1
  const data: Buffer[] = []
  for (let p = 8; p < bytes.length; ) {
    const length = bytes.readUInt32BE(p)
    const type = bytes.toString('latin1', p + 4, p + 8)
    const body = bytes.subarray(p + 8, p + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]
      colour = body[9]
      interlace = body[12]
    } else if (type === 'IDAT') data.push(body)
    p += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const levels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)]
    const row = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1))
    const out = y * width
    for (let x = 0; x < width; x++) {
      const a = x ? levels[out + x - 1] : 0
      const b = y ? levels[out - width + x] : 0
      const c = x && y ? levels[out - width + x - 1] : 0
      let predict = 0
      if (filter === 1) predict = a
      else if (filter === 2) predict = b
      else if (filter === 3) predict = (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        predict = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      levels[out + x] = (row[x] + predict) & 255
    }
  }
  return { width, height, depth, colour, interlace, levels }
}

describe('the shipped depth maps', () => {
  const MAPS = [
    ['earth-bathy-4k.png', 4096, 2048, 2.5e6],
    ['earth-bathy-2k.png', 2048, 1024, 1e6],
  ] as const
  for (const [name, w, h, budget] of MAPS) {
    it(`${name}: ${w} x ${h} 8-bit grey, on the elevation map's grid`, () => {
      const url = new URL(`../assets/${name}`, import.meta.url)
      expect(statSync(url).size).toBeLessThan(budget)
      const png = decodeGreyPng(readFileSync(url))
      expect([png.width, png.height, png.depth, png.colour, png.interlace]).toEqual([w, h, 8, 0, 0])
      const at = (lat: number, lon: number) =>
        png.levels[Math.min(h - 1, Math.floor(((90 - lat) / 180) * h)) * w + Math.min(w - 1, Math.floor(((lon + 180) / 360) * w))]
      expect(at(11.35, 142.2), 'Challenger Deep').toBeGreaterThan(encodeWaterDepth(8000))
      expect(at(24.0, -77.8), 'Great Bahama Bank').toBeLessThan(encodeWaterDepth(30))
      expect(at(0, -150), 'mid-Pacific').toBeGreaterThanOrEqual(encodeWaterDepth(3500))
      expect(at(0, -150), 'mid-Pacific').toBeLessThanOrEqual(encodeWaterDepth(6000))
      expect(at(47.7, -87.5), 'Lake Superior').toBe(encodeWaterDepth(WATER_DEPTH_NEUTRAL))
    })
  }
})
