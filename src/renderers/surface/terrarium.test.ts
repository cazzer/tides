import { describe, expect, it } from 'vitest'
import {
  bakeTileHorizon,
  decodeTerrariumPadded,
  flatGrid,
  horizonWindow,
  resampleGrid,
  mercatorLatitude,
  terrariumElevation,
  TILE_HORIZON_DIRECTIONS,
  TILE_HORIZON_FIRST_TEXELS,
  TILE_HORIZON_RADIUS,
  TILE_HORIZON_REACH_METRES,
  TILE_HORIZON_STEP_RATIO,
  tileHorizonCode,
  tileHorizonSize,
  tileHorizonSteps,
  tileHorizonTangent,
  type HorizonJob,
  type HorizonSource,
  type PaddedGrid,
} from './terrarium'

describe('terrarium decode (tides-zmw.9.2)', () => {
  it('reads Terrarium metres', () => {
    expect(terrariumElevation(128, 0, 0)).toBe(0)
    expect(terrariumElevation(128, 100, 128)).toBe(100.5)
    expect(terrariumElevation(127, 255, 0)).toBe(-1)
    // Everest-ish
    expect(terrariumElevation(162, 144, 0)).toBe(8848)
  })

  it('pads a 2x2 tile, rows south first, edges copied into the border', () => {
    // image rows north first: north row 1000 m, 2000 m; south row 3000 m, 4000 m
    const px = (m: number) => [128 + Math.floor(m / 256), m % 256, 0, 255]
    const rgba = [...px(1000), ...px(2000), ...px(3000), ...px(4000)]
    const { data, width, height } = decodeTerrariumPadded(rgba, 2, 2)
    expect([width, height]).toEqual([4, 4])
    const rows = [0, 1, 2, 3].map((y) => Array.from(data.subarray(y * 4, y * 4 + 4)))
    expect(rows).toEqual([
      [3000, 3000, 4000, 4000],
      [3000, 3000, 4000, 4000],
      [1000, 1000, 2000, 2000],
      [1000, 1000, 2000, 2000],
    ])
  })

  it('makes a sea-level grid the size a decoded tile would be', () => {
    const grid = flatGrid(512)
    expect([grid.width, grid.height, grid.data.length]).toEqual([514, 514, 514 * 514])
    expect(grid.data.every((v) => v === 0)).toBe(true)
  })
})

describe('per-grid horizon maps (tides-zmw.9.15)', () => {
  // A 32-texel grid at level 12 (y 1472: ~45°N, ~215 m texels, so the
  // reach is ~56 texels) and its ancestor two levels up, both sampled from
  // one analytic ground in the grid's coordinates (texels from its
  // south-west corner).
  const n = 32
  const level = 12
  const gy0 = 1472
  const south = 1 - (gy0 + 1) / 2 ** level
  const north = 1 - gy0 / 2 ** level
  // the grid's rectangle in its ancestor's (x = 4k + 2, y = 4 * 368), normalized, v north
  const sub = [0.5, 0.75, 0.75, 1]
  const scale = 4
  const gridOf = (h: (gx: number, gy: number) => number): PaddedGrid => {
    const p = n + 2
    const data = new Float32Array(p * p)
    for (let j = 0; j < p; j++) for (let i = 0; i < p; i++) data[j * p + i] = h(i - 0.5, j - 0.5)
    return { data, width: p, height: p }
  }
  const ancestorOf = (h: (gx: number, gy: number) => number): PaddedGrid => {
    const p = n + 2
    const data = new Float32Array(p * p)
    // ancestor texel i's inner coordinate a = i - 0.5; the grid's g = (a - sub0 n) scale
    for (let j = 0; j < p; j++) for (let i = 0; i < p; i++) data[j * p + i] = h((i - 0.5 - sub[0] * n) * scale, (j - 0.5 - sub[1] * n) * scale)
    return { data, width: p, height: p }
  }
  const job = (context: HorizonSource[] = []): HorizonJob => ({ tileSize: n, south, north, context })
  const size = tileHorizonSize(n)
  const code = (map: Uint8Array, a: number, b: number, d: number) => map[Math.floor(d / 4) * size * size * 4 + (b * size + a) * 4 + (d % 4)]
  const hill = (cx: number, cy: number, height: number, width: number) => (gx: number, gy: number) =>
    height * Math.exp(-((gx - cx) ** 2 + (gy - cy) ** 2) / (2 * width * width))

  /** Bilinear in a padded grid at its texel coordinates (i, j), clamped. */
  const bilinear = (g: PaddedGrid, i: number, j: number) => {
    const x = Math.min(Math.max(Math.floor(i), 0), g.width - 2)
    const y = Math.min(Math.max(Math.floor(j), 0), g.height - 2)
    const at = (u: number, v: number) => g.data[v * g.width + u]
    const tx = i - x
    const ty = j - y
    return (at(x, y) * (1 - tx) + at(x + 1, y) * tx) * (1 - ty) + (at(x, y + 1) * (1 - tx) + at(x + 1, y + 1) * tx) * ty
  }
  /** The ground the bake reads: the grid inside its inner texels, the ancestor (whole) past them. */
  const dataOf = (grid: PaddedGrid, ancestor: PaddedGrid) => (gx: number, gy: number) =>
    gx >= 0.5 && gx <= n - 0.5 && gy >= 0.5 && gy <= n - 0.5
      ? bilinear(grid, gx + 0.5, gy + 0.5)
      : bilinear(ancestor, sub[0] * n + gx / scale + 0.5, sub[1] * n + gy / scale + 0.5)

  /** The true horizon of ground h, marched every 0.05 texels from the first step (nearer is the slope's own shading) out to the reach. */
  function bruteForce(h: (gx: number, gy: number) => number, a: number, b: number, d: number): number {
    const span = (n + 2) / size
    const gx = (a + 0.5) * span - 1
    const gy = (b + 0.5) * span - 1
    const lat = mercatorLatitude(south + (gy / n) * (north - south))
    const metres = (2 * Math.PI * TILE_HORIZON_RADIUS * Math.cos(lat) * (north - south)) / n
    const az = (2 * Math.PI * d) / TILE_HORIZON_DIRECTIONS
    const h0 = h(gx, gy)
    let best = 0
    for (let s = TILE_HORIZON_FIRST_TEXELS; s * metres <= TILE_HORIZON_REACH_METRES + 1e-6; s += 0.05) {
      const dist = s * metres
      best = Math.max(best, (h(gx + Math.sin(az) * s, gy + Math.cos(az) * s) - h0) / dist - dist / (2 * TILE_HORIZON_RADIUS))
    }
    return best
  }

  it('codes the tangent as t / (t + 1/GAIN), rounded down, and back', () => {
    expect(tileHorizonCode(0)).toBe(0)
    expect(tileHorizonCode(-1)).toBe(0)
    expect(tileHorizonCode(1e9)).toBe(254)
    for (const t of [0.001, 0.01, 0.05, 0.2, 1, 3]) {
      const c = tileHorizonCode(t)
      expect(tileHorizonTangent(c)).toBeLessThanOrEqual(t)
      expect(tileHorizonTangent(c + 1)).toBeGreaterThan(t)
    }
    // 1/255 near flat: under 0.03° at true scale
    expect(Math.atan(tileHorizonTangent(1))).toBeLessThan((0.03 * Math.PI) / 180)
    // a step under 0.7° to 30°, under 2° at 70°
    const step = (deg: number) => {
      const c = tileHorizonCode(Math.tan((deg * Math.PI) / 180))
      return ((Math.atan(tileHorizonTangent(c + 1)) - Math.atan(tileHorizonTangent(c))) * 180) / Math.PI
    }
    expect(step(30)).toBeLessThan(0.7)
    expect(step(70)).toBeLessThan(2)
  })

  it('steps geometrically down from exactly the reach, at the same metres on every level', () => {
    for (const m of [1, 15, 370, 5000, 20000]) {
      const steps = tileHorizonSteps(m)
      expect(steps[steps.length - 1] * m).toBeCloseTo(TILE_HORIZON_REACH_METRES, 6)
      if (steps.length > 1) expect(steps[0]).toBeGreaterThanOrEqual(TILE_HORIZON_FIRST_TEXELS)
      if (steps.length > 1) expect(steps[0]).toBeLessThanOrEqual(TILE_HORIZON_FIRST_TEXELS * 1.05)
      if (steps.length > 1) expect(steps[1] / steps[0]).toBeLessThanOrEqual(TILE_HORIZON_STEP_RATIO * 1.06)
      for (let i = 2; i < steps.length; i++) expect(steps[i] / steps[i - 1]).toBeCloseTo(TILE_HORIZON_STEP_RATIO, 9)
    }
    // a z16 grid's steps in metres hold a z12 grid's, but for its first
    const fine = tileHorizonSteps(1).map((d) => d * 1)
    const coarse = tileHorizonSteps(16).map((d) => d * 16)
    for (const d of coarse.slice(1)) expect(fine.some((e) => Math.abs(e - d) < 1e-6 * d)).toBe(true)
  })

  it('bakes the brute-force horizon of a hill in all eight directions', () => {
    // broad next to the ancestor's 4-texel spacing (it is bilinear too),
    // one narrower within the grid
    const h = (gx: number, gy: number) => 400 + hill(16, 16, 1500, 8)(gx, gy) + hill(-20, 0, 1200, 10)(gx, gy) + hill(24, 8, 300, 2)(gx, gy)
    const grid = gridOf(h)
    const ancestor = ancestorOf(h)
    const data = dataOf(grid, ancestor)
    const map = bakeTileHorizon(job([horizonWindow(ancestor, sub)]), grid)!
    expect(map).not.toBeNull()
    expect(map.length).toBe(size * size * 8)
    // never above the truth but for the code's rounding, and the steps miss
    // little of it
    const OVER = 1e-9
    let worst = 0
    const unders: number[] = []
    let shadowed = 0
    for (let b = 0; b < size; b++) for (let a = 0; a < size; a++) for (let d = 0; d < 8; d++) {
      const truth = bruteForce(data, a, b, d)
      const got = code(map, a, b, d)
      const under = Math.atan(truth) - Math.atan(tileHorizonTangent(got))
      expect(under, `a ${a} b ${b} d ${d}`).toBeGreaterThan(-OVER)
      worst = Math.max(worst, under)
      unders.push(under)
      if (got > 0) shadowed++
    }
    unders.sort((x, y) => x - y)
    expect(worst).toBeLessThan((2 * Math.PI) / 180)
    expect(unders[Math.floor(unders.length * 0.95)]).toBeLessThan((0.75 * Math.PI) / 180)
    expect(unders.reduce((x, y) => x + y, 0) / unders.length).toBeLessThan((0.2 * Math.PI) / 180)
    expect(shadowed).toBeGreaterThan(size * size)
  })

  it('reads past the grid\'s edge from its ancestor: a peak to the east shades the flat grid looking east only', () => {
    // flat land in the grid, a 2 km ridge running north-south ~2.5 km east of its east edge (in the ancestor alone)
    const h = (gx: number) => 500 + 2000 * Math.exp(-((gx - n - 12) ** 2) / (2 * 6 * 6))
    const flat = gridOf(() => 500)
    expect(bakeTileHorizon(job(), flat)).toBeNull()
    const map = bakeTileHorizon(job([horizonWindow(ancestorOf(h), sub)]), flat)!
    expect(map).not.toBeNull()
    for (let b = 0; b < size; b++) {
      expect(code(map, size - 1, b, 2)).toBeGreaterThan(0) // east
      for (let a = 0; a < size; a++) expect(code(map, a, b, 6)).toBe(0) // west
    }
    // nearer the peak, higher
    expect(code(map, size - 1, 4, 2)).toBeGreaterThan(code(map, 0, 4, 2))
  })

  it('bakes from the context alone (a grid resampled from its ancestor)', () => {
    // as SurfaceGridCache does past a coverage end: the grid resampled from
    // its ancestor, whose window then leads the context
    const h = (gx: number, gy: number) => 400 + hill(16, 16, 1500, 8)(gx, gy)
    const ancestor = ancestorOf(h)
    const resampled = bakeTileHorizon(job([horizonWindow(ancestor, sub)]), resampleGrid(ancestor, sub, n))!
    const alone = bakeTileHorizon(job([horizonWindow(ancestor, sub)]), null)!
    // the same ground but for bilinear-of-bilinear at a peak's crest, which
    // moves a horizon of a few degrees seen from just under it
    let diff = 0
    let sum = 0
    const angle = (c: number) => Math.atan(tileHorizonTangent(c))
    for (let i = 0; i < alone.length; i++) {
      const e = Math.abs(angle(alone[i]) - angle(resampled[i]))
      diff = Math.max(diff, e)
      sum += e
    }
    expect(diff).toBeLessThan((4 * Math.PI) / 180)
    expect(sum / alone.length).toBeLessThan((0.3 * Math.PI) / 180)
    expect(alone.some((v) => v > 0)).toBe(true)
  })

  it('bakes nothing for open water or flat ground', () => {
    expect(bakeTileHorizon(job(), flatGrid(n))).toBeNull()
    expect(bakeTileHorizon(job(), gridOf(() => 1200))).toBeNull()
    expect(bakeTileHorizon(job([horizonWindow(ancestorOf(() => 0), sub)]), flatGrid(n))).toBeNull()
  })

  it('maps an ancestor window\'s texels onto the grid\'s coordinates', () => {
    const ramp = (gx: number, gy: number) => 3 * gx - 7 * gy + 11
    const w = horizonWindow(ancestorOf(ramp), sub, 3)
    expect(w.scale).toBe(scale)
    // bilinear of a plane is exact: any grid point inside the window
    for (const [gx, gy] of [[0, 0], [10.3, 20.7], [-5, 29], [31.5, -2]]) {
      const lx = gx / w.scale + w.offsetX
      const ly = gy / w.scale + w.offsetY
      expect(lx).toBeGreaterThanOrEqual(w.minX)
      expect(lx).toBeLessThanOrEqual(w.maxX)
      const x = Math.floor(lx)
      const y = Math.floor(ly)
      const at = (i: number, j: number) => w.data[j * w.width + i]
      const top = at(x, y) + (at(x + 1, y) - at(x, y)) * (lx - x)
      const bot = at(x, y + 1) + (at(x + 1, y + 1) - at(x, y + 1)) * (lx - x)
      expect(top + (bot - top) * (ly - y)).toBeCloseTo(ramp(gx, gy), 3)
    }
    // three ancestor texels of margin each side of the grid's 8 (and the
    // rounding out), clipped to the padded texels north (the grid sits at its north edge)
    expect(w.width).toBe(8 + 2 * 3 + 2)
    expect(w.height).toBe(8 + 3 + 2)
  })
})
