// The night's lights as points (tides-zmw.23): the eye's cell from the CPU,
// the tiles' offset from it in float32, and the field's energy, each against
// a TypeScript copy of the GLSL.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { EARTH_KM_PER_UNIT } from '../surface-handover'
import { EARTH_RADIUS_KM } from '../cloud-layer'
import { GIBS_GROUND_WIDTH } from '../gibs-patch'
import { surfaceGlobeUv } from './surface/tile-material'
import {
  NIGHT_POINTS_BLUR_PX,
  NIGHT_POINTS_CELL0_M,
  NIGHT_POINTS_CELL_PX,
  NIGHT_POINTS_CELLS_U,
  NIGHT_POINTS_CELLS_V,
  NIGHT_POINTS_COS_MIN,
  NIGHT_POINTS_FADE_FROM,
  NIGHT_POINTS_GLSL,
  NIGHT_POINTS_LEVEL_MAX,
  NIGHT_POINTS_PEAK,
  NIGHT_POINTS_PIXEL_M_FULL,
  NIGHT_POINTS_PIXEL_M_OFF,
  NIGHT_POINTS_RADIUS_M,
  NIGHT_POINTS_RESIDUAL,
  NIGHT_POINTS_SOFT,
  NIGHT_POINTS_TEXEL_PX_FULL,
  NIGHT_POINTS_TEXEL_PX_START,
  nightPointsEye,
} from './nightPoints'

const D = Math.PI / 180
const R = EARTH_RADIUS_KM / EARTH_KM_PER_UNIT
const METRE = 1 / (EARTH_KM_PER_UNIT * 1000)

/** A direction in the ground's frame (lon 0 at +X, east towards -Z, Y north). */
const dir = (lat: number, lon: number) =>
  new THREE.Vector3(Math.cos(lat * D) * Math.cos(lon * D), Math.sin(lat * D), -Math.cos(lat * D) * Math.sin(lon * D))

/** The cell coordinate of a point in the ground's frame, in double. */
const cellOf = (p: THREE.Vector3) => {
  const uv = surfaceGlobeUv(p)
  return [uv.x * NIGHT_POINTS_CELLS_U, uv.y * NIGHT_POINTS_CELLS_V]
}
const wrapU = (du: number) => du - NIGHT_POINTS_CELLS_U * Math.round(du / NIGHT_POINTS_CELLS_U)

const CITIES: [number, number][] = [
  [40.71, -74.01],
  [51.5, -0.1],
  [35.68, 139.69],
  [-33.87, 151.21],
  [64.15, -21.94],
  [0.3, 32.6],
  [-36.85, 179.9],
  [52.0, -179.9],
]

describe("the eye's cell (nightPointsEye)", () => {
  it('splits surfaceGlobeUv times the cells into whole cells and a fraction', () => {
    const eye = new THREE.Vector4()
    for (const [lat, lon] of [...CITIES, [10, 180], [10, -180], [-5, 179.9999999]]) {
      for (const height of [30 * METRE, 10_000 * METRE]) {
        const p = dir(lat, lon).multiplyScalar(R + height)
        nightPointsEye(p, eye)
        const [u, v] = cellOf(p)
        expect(Number.isInteger(eye.x) && Number.isInteger(eye.y)).toBe(true)
        expect(eye.x).toBeGreaterThanOrEqual(0)
        expect(eye.x).toBeLessThan(NIGHT_POINTS_CELLS_U)
        for (const frac of [eye.z, eye.w]) {
          expect(frac).toBeGreaterThanOrEqual(0)
          expect(frac).toBeLessThan(1)
        }
        expect(Math.abs(wrapU(eye.x + eye.z - u))).toBeLessThan(1e-6)
        expect(Math.abs(eye.y + eye.w - v)).toBeLessThan(1e-6)
        // As float32 holds them: the whole cells exactly, the fraction to
        // far under a millimetre.
        expect(Math.fround(eye.x)).toBe(eye.x)
        expect(Math.abs(Math.fround(eye.z) - eye.z) * NIGHT_POINTS_CELL0_M).toBeLessThan(1e-5)
      }
    }
  })
})

// nightPointsOffset as the GPU evaluates it: every operation rounded to
// float32 (F; the identity for the algebra in double), in the GLSL's order.
const F32 = Math.fround
function offset(e: THREE.Vector3, r: THREE.Vector3, F: (x: number) => number = F32): [number, number] {
  const [ex, ey, ez] = [F(e.x), F(e.y), F(e.z)]
  const [rx, ry, rz] = [F(r.x), F(r.y), F(r.z)]
  const rhoE2 = F(F(ex * ex) + F(ez * ez))
  const rhoE = F(Math.sqrt(rhoE2))
  const px = F(ex + rx)
  const pz = F(ez + rz)
  const rhoP = F(Math.sqrt(F(F(px * px) + F(pz * pz))))
  const du = F(Math.atan2(F(F(ez * rx) - F(ex * rz)), F(F(rhoE2 + F(ex * rx)) + F(ez * rz))))
  const dRho = F(F(F(F(2 * F(F(ex * rx) + F(ez * rz))) + F(rx * rx)) + F(rz * rz)) / F(rhoP + rhoE))
  const dv = F(Math.atan2(F(F(rhoE * ry) - F(ey * dRho)), F(F(rhoE * rhoP) + F(ey * F(ey + ry)))))
  return [F(F(du * F(1 / (2 * Math.PI))) * NIGHT_POINTS_CELLS_U), F(F(dv * F(1 / Math.PI)) * NIGHT_POINTS_CELLS_V)]
}

describe("the tiles' cell coordinate (nightPointsOffset)", () => {
  it('is in the GLSL as copied here', () => {
    const g = NIGHT_POINTS_GLSL.offsetHead
    expect(g).toContain('float du = atan(e.z * r.x - e.x * r.z, rhoE2 + e.x * r.x + e.z * r.z);')
    expect(g).toContain('float dRho = (2.0 * (e.x * r.x + e.z * r.z) + r.x * r.x + r.z * r.z) / (rhoP + rhoE);')
    expect(g).toContain('float dv = atan(rhoE * r.y - e.y * dRho, rhoE * rhoP + e.y * (e.y + r.y));')
    expect(g).not.toMatch(/dFd|fwidth/)
  })

  // The shader's whole chain: the eye's cell in double from the CPU (as
  // float32 takes it), the eye and the ray as float32 uniforms and ray, the
  // offset in float32; against the ground point's cell in double.
  it('finds a ground point to a centimetre out to 20 km (a part in 3 million to 500 km), at the antimeridian too', () => {
    const eye4 = new THREE.Vector4()
    let worstNear = 0
    for (const [lat, lon] of CITIES) {
      for (const height of [30, 2_000, 12_000]) {
        const eye = dir(lat, lon).multiplyScalar(R + height * METRE)
        nightPointsEye(eye, eye4)
        const eyeF = new THREE.Vector3(F32(eye.x), F32(eye.y), F32(eye.z))
        for (const distance of [1, 30, 1_000, 20_000, 100_000, 500_000]) {
          for (const bearing of [0, 1.1, 2.5, 4.4]) {
            // A point at `distance` along the ground, and down to it.
            const angle = distance / 1000 / EARTH_RADIUS_KM
            const east = new THREE.Vector3(0, 1, 0).cross(eye).normalize()
            const north = eye.clone().cross(east).normalize()
            const along = east.multiplyScalar(Math.sin(bearing)).add(north.multiplyScalar(Math.cos(bearing)))
            const ground = eye
              .clone()
              .normalize()
              .multiplyScalar(Math.cos(angle))
              .addScaledVector(along, Math.sin(angle))
              .multiplyScalar(R + 50 * METRE)
            const ray = ground.clone().sub(eye)
            // The algebra itself, in double, from the rounded eye.
            const [au, av] = offset(eyeF, ray, (x) => x)
            const [eu, ev] = cellOf(eyeF)
            const [gu, gv] = cellOf(eyeF.clone().add(ray))
            expect(Math.abs(wrapU(au - (gu - eu))) + Math.abs(av - (gv - ev))).toBeLessThan(1e-6 / NIGHT_POINTS_CELL0_M)
            const [ou, ov] = offset(eyeF, ray)
            const u = eye4.x + F32(F32(eye4.z) + ou)
            const v = eye4.y + F32(F32(eye4.w) + ov)
            const [tu, tv] = cellOf(ground)
            const k = Math.cos(Math.asin(ground.y / ground.length()))
            const error = Math.hypot(wrapU(u - tu) * k, v - tv) * NIGHT_POINTS_CELL0_M
            // float32 rounds the ray itself by ~6e-8 of its length, and the
            // formula's few roundings add to it: ~1 mm near the eye, 6 mm at
            // 20 km, 13 cm at 500 km, where a pixel is hundreds of metres.
            expect(error, `${lat},${lon} ${height} m up, ${distance} m away`).toBeLessThan(Math.max(0.01, 3e-7 * distance))
            if (distance <= 20_000) worstNear = Math.max(worstNear, error)
          }
        }
      }
    }
    expect(worstNear).toBeLessThan(0.01)
  })
})

// The field (NIGHT_POINTS_GLSL.head) in double, line for line.
function hash(x: number, y: number, z: number): [number, number, number] {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0
  y = (Math.imul(y, 1664525) + 1013904223) >>> 0
  z = (Math.imul(z, 1664525) + 1013904223) >>> 0
  x = (x + Math.imul(y, z)) >>> 0
  y = (y + Math.imul(z, x)) >>> 0
  z = (z + Math.imul(x, y)) >>> 0
  x = (x ^ (x >>> 16)) >>> 0
  y = (y ^ (y >>> 16)) >>> 0
  z = (z ^ (z >>> 16)) >>> 0
  x = (x + Math.imul(y, z)) >>> 0
  y = (y + Math.imul(z, x)) >>> 0
  z = (z + Math.imul(x, y)) >>> 0
  return [(x >>> 8) / 2 ** 24, (y >>> 8) / 2 ** 24, (z >>> 8) / 2 ** 24]
}

type V2 = [number, number]
const RADIUS_CELLS0 = NIGHT_POINTS_RADIUS_M / NIGHT_POINTS_CELL0_M
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** nightPointsLevel; `reach` cells each way of the pixel's own two (the
 * GLSL's is 0: its 2x2), and `only` the cells (whole ids) it passes. */
function level(
  l: number,
  base: V2,
  local: V2,
  dx: V2,
  dy: V2,
  k: number,
  lum: number,
  reach = 0,
  only?: (x: number, y: number) => boolean
) {
  const s = 2 ** (2 * l)
  const hi = [Math.floor(base[0] / s), Math.floor(base[1] / s)]
  const at = [(base[0] - hi[0] * s + local[0]) / s, (base[1] - hi[1] * s + local[1]) / s]
  const mdx = [(dx[0] * k) / s, dx[1] / s]
  const mdy = [(dy[0] * k) / s, dy[1] / s]
  const r = Math.min(RADIUS_CELLS0 / s, 0.3 * k)
  const b2 = NIGHT_POINTS_BLUR_PX ** 2
  const a = r * r + b2 * (mdx[0] * mdx[0] + mdy[0] * mdy[0])
  const c = b2 * (mdx[0] * mdx[1] + mdy[0] * mdy[1])
  const d = r * r + b2 * (mdx[1] * mdx[1] + mdy[1] * mdy[1])
  const det = a * d - c * c
  const W = ((Math.PI / 3) * Math.sqrt(det)) / k
  const p = Math.min(lum / (W * NIGHT_POINTS_PEAK), 1)
  const under = Math.max(NIGHT_POINTS_SOFT - p, 0)
  const over = Math.max(p - (1 - NIGHT_POINTS_SOFT), 0)
  const lit = p + (under * under - over * over) / (4 * NIGHT_POINTS_SOFT)
  const wrap = (NIGHT_POINTS_CELLS_U >> (2 * l)) - 1
  const c0 = [Math.floor(at[0] - 0.5), Math.floor(at[1] - 0.5)]
  let sum = 0
  for (let j = -reach; j < 2 + reach; j++) {
    for (let i = -reach; i < 2 + reach; i++) {
      const cell = [c0[0] + i, c0[1] + j]
      if (only && !only(hi[0] + cell[0], hi[1] + cell[1])) continue
      const h = hash((hi[0] + cell[0]) & wrap, (hi[1] + cell[1]) >>> 0, l)
      const e = [(cell[0] + h[0] - at[0]) * k, cell[1] + h[1] - at[1]]
      // e' S^-1 e, S = [[a, c], [c, d]].
      const q = Math.max(1 - (d * e[0] * e[0] - 2 * c * e[0] * e[1] + a * e[1] * e[1]) / det, 0)
      sum += q * q * Math.min(Math.max((p - h[2]) / (2 * NIGHT_POINTS_SOFT) + 0.5, 0), 1)
    }
  }
  return { n: sum / (W * lit), p, lit }
}

/** nightPoints, with the levels it picks. */
function points(lum: number, fine: number, base: V2, local: V2, dx: V2, dy: V2, v: number, mapWidth: number, reach = 0) {
  const pixel = Math.log2(Math.max(Math.hypot(...dx), Math.hypot(...dy)))
  const texel =
    Math.log2(NIGHT_POINTS_CELLS_U / mapWidth) * (1 - fine) + Math.log2(NIGHT_POINTS_CELLS_U / GIBS_GROUND_WIDTH) * fine
  const breakup =
    smoothstep(Math.log2(NIGHT_POINTS_TEXEL_PX_START), Math.log2(NIGHT_POINTS_TEXEL_PX_FULL), texel - pixel) *
    (1 -
      smoothstep(
        Math.log2(NIGHT_POINTS_PIXEL_M_FULL / NIGHT_POINTS_CELL0_M),
        Math.log2(NIGHT_POINTS_PIXEL_M_OFF / NIGHT_POINTS_CELL0_M),
        pixel
      ))
  if (breakup <= 0 || lum <= 0) return { n: 1, levels: [] as number[] }
  const k = Math.max(Math.sin(v * Math.PI), NIGHT_POINTS_COS_MIN)
  const x = 0.5 * Math.log2((NIGHT_POINTS_CELL_PX * Math.hypot(dx[0] * k, dx[1], dy[0] * k, dy[1])) / k)
  const above = Math.floor(x) + 1
  const l0 = Math.min(Math.max(above, 0), NIGHT_POINTS_LEVEL_MAX)
  const t = above < 0 || above >= NIGHT_POINTS_LEVEL_MAX ? 0 : smoothstep(NIGHT_POINTS_FADE_FROM, 1, x - Math.floor(x))
  let n = 0
  const levels: number[] = []
  if (t < 1) {
    n += (1 - t) * level(l0, base, local, dx, dy, k, lum, reach).n
    levels.push(l0)
  }
  if (t > 0) {
    n += t * level(l0 + 1, base, local, dx, dy, k, lum, reach).n
    levels.push(l0 + 1)
  }
  return { n: NIGHT_POINTS_RESIDUAL + (1 - NIGHT_POINTS_RESIDUAL) * n, breakup, levels }
}

/** A deterministic uniform [0, 1). */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return hash(s, 7, 11)[0]
  }
}

describe('the field of lights', () => {
  it('is in the GLSL as copied here', () => {
    const g = NIGHT_POINTS_GLSL.head
    expect(g).toContain('float W = 1.047198 * sqrt(determinant(S)) / k;')
    expect(g).toContain('float lit = p + (under * under - over * over) / 0.200000;')
    expect(g).toContain('sum += q * q * clamp((p - h.z) / 0.100000 + 0.5, 0.0, 1.0);')
    expect(g).toContain('return sum / (W * lit);')
    expect(g).toContain(
      'float t = above < 0.0 || above >= 5.000000 ? 0.0 : smoothstep(0.700000, 1.0, fract(x));'
    )
    expect(g).not.toMatch(/dFd|fwidth/)
  })

  it("lights the cells the threshold's soft edge lets through on average: lit", () => {
    for (const p of [0.001, 0.02, 0.05, 0.3, 0.97, 1]) {
      let sum = 0
      const N = 100_000
      for (let i = 0; i < N; i++) {
        const h = (i + 0.5) / N
        sum += Math.min(Math.max((p - h) / (2 * NIGHT_POINTS_SOFT) + 0.5, 0), 1)
      }
      const under = Math.max(NIGHT_POINTS_SOFT - p, 0)
      const over = Math.max(p - (1 - NIGHT_POINTS_SOFT), 0)
      expect(sum / N).toBeCloseTo(p + (under * under - over * over) / (4 * NIGHT_POINTS_SOFT), 6)
    }
  })

  // Each light's kernel, over the cell coordinate, is W: the light of the
  // cells a level holds, integrated, is what their thresholds let through
  // over lit. Integrated finely over a few cells (and a cell round them, for
  // the kernels that spill out), counting only their own lights.
  it("integrates each light to W, so a level's cells hold the light their thresholds let through", () => {
    const cases: { l: number; k: number; dx: V2; dy: V2; lum: number }[] = [
      { l: 0, k: 1, dx: [0.01, 0], dy: [0, 0.01], lum: 0.3 },
      { l: 1, k: 0.6, dx: [0.3, 0.1], dy: [-0.2, 0.5], lum: 0.05 },
      { l: 2, k: 0.25, dx: [1.2, -0.4], dy: [0.9, 3.1], lum: 1 },
      { l: 3, k: 0.9, dx: [4, 0], dy: [0, 9], lum: 0.002 },
    ]
    for (const { l, k, dx, dy, lum } of cases) {
      const s = 4 ** l
      const M = 4
      const base: V2 = [1000 * s, 2000 * s]
      const inside = (x: number, y: number) => x >= 1000 && x < 1000 + M && y >= 2000 && y < 2000 + M
      // The kernel's narrowest half-width in cells, from a probe.
      const probe = level(l, base, [0, 0], dx, dy, k, lum)
      const r = Math.min(RADIUS_CELLS0 / s, 0.3 * k)
      const half = Math.max(r, (NIGHT_POINTS_BLUR_PX * Math.min(Math.hypot(...dx), Math.hypot(...dy)) * k) / s)
      const step = Math.min(half / 6, 0.02)
      let integral = 0
      for (let y = -1 + step / 2; y < M + 1; y += step) {
        for (let x = -1 + step / 2; x < M + 1; x += step) {
          integral += level(l, base, [x * s, y * s], dx, dy, k, lum, 0, inside).n * step * step
        }
      }
      let expected = 0
      for (let j = 0; j < M; j++) {
        for (let i = 0; i < M; i++) {
          const h = hash(1000 + i, 2000 + j, l)
          expected += Math.min(Math.max((probe.p - h[2]) / (2 * NIGHT_POINTS_SOFT) + 0.5, 0), 1) / probe.lit
        }
      }
      expect(integral, `level ${l}`).toBeCloseTo(expected, 2)
    }
  })

  it('lights lit of the cells on average by their hashed thresholds', () => {
    for (const p of [0.01, 0.2, 0.8, 1]) {
      const under = Math.max(NIGHT_POINTS_SOFT - p, 0)
      const over = Math.max(p - (1 - NIGHT_POINTS_SOFT), 0)
      const lit = p + (under * under - over * over) / (4 * NIGHT_POINTS_SOFT)
      const N = 200_000
      let sum = 0
      for (let i = 0; i < N; i++) {
        const h = hash((i * 7919) & (NIGHT_POINTS_CELLS_U - 1), 100_000 + (i >> 9), i % 3)
        sum += Math.min(Math.max((p - h[2]) / (2 * NIGHT_POINTS_SOFT) + 0.5, 0), 1)
      }
      expect(Math.abs(sum / N - lit)).toBeLessThan(4 * Math.sqrt(lit / N))
    }
  })

  // The whole chain at random ground points: its mean is the glow's, 1, to
  // within the sample's own error.
  it("keeps the texel's light on average across latitudes, densities, zooms and footprints", () => {
    const rand = random(1)
    for (const v of [0.5, 0.7, 0.9]) {
      for (const lum of [0.02, 0.2, 1]) {
        for (const scale of [0.004, 0.05, 0.7, 3]) {
          // A footprint stretched and turned: dx and dy in cells.
          const turn = rand() * Math.PI
          const dx: V2 = [scale * Math.cos(turn), scale * Math.sin(turn)]
          const dy: V2 = [-2.5 * scale * Math.sin(turn), 2.5 * scale * Math.cos(turn)]
          const N = 30_000
          let sum = 0
          let squares = 0
          for (let i = 0; i < N; i++) {
            const base: V2 = [Math.floor(rand() * NIGHT_POINTS_CELLS_U), Math.floor(rand() * 1000) + 100_000]
            const local: V2 = [rand() * 4096, rand() * 4096]
            const n = points(lum, 0, base, local, dx, dy, v, 10_800).n
            sum += n
            squares += n * n
          }
          const mean = sum / N
          const error = Math.sqrt((squares / N - mean * mean) / N)
          expect(Math.abs(mean - 1), `v ${v} lum ${lum} scale ${scale}: ${mean} ± ${error}`).toBeLessThan(4 * error)
        }
      }
    }
  })

  it('needs no cells but the 2x2 nearest the pixel: a 6x6 search sums the same', () => {
    const rand = random(2)
    for (let i = 0; i < 4000; i++) {
      // Up to the breakup's end, at any latitude, stretched any way.
      const scale = 2 ** (rand() * 16 - 10)
      const turn = rand() * Math.PI
      const stretch = 1 + 3 * rand()
      const dx: V2 = [scale * Math.cos(turn), scale * Math.sin(turn)]
      const dy: V2 = [-stretch * scale * Math.sin(turn), stretch * scale * Math.cos(turn)]
      const base: V2 = [Math.floor(rand() * NIGHT_POINTS_CELLS_U), Math.floor(rand() * NIGHT_POINTS_CELLS_V)]
      const local: V2 = [rand() * 100 - 50, rand() * 100 - 50]
      const v = 0.05 + 0.9 * rand()
      const lum = rand()
      const a = points(lum, 0, base, local, dx, dy, v, 10_800)
      const b = points(lum, 0, base, local, dx, dy, v, 10_800, 2)
      expect(b.n).toBeCloseTo(a.n, 12)
    }
  })

  it("is exactly the glow (1) where a texel is 2 px or less, and from 1 km pixels up", () => {
    const at: V2 = [1234.5, 678.9]
    // The base map (10800 px: ~48.5 cells a texel) seen at 2 px a texel.
    const texel = NIGHT_POINTS_CELLS_U / 10_800
    expect(points(0.5, 0, [0, 0], at, [texel / 2, 0], [0, texel / 2], 0.5, 10_800).n).toBe(1)
    // VIIRS (~6.4 cells a texel) where it covers.
    const fine = NIGHT_POINTS_CELLS_U / GIBS_GROUND_WIDTH
    expect(points(0.5, 1, [0, 0], at, [fine / 2, 0], [0, fine / 2], 0.5, 10_800).n).toBe(1)
    expect(points(0.5, 1, [0, 0], at, [fine / 4, 0], [0, fine / 4], 0.5, 10_800).n).not.toBe(1)
    const off = NIGHT_POINTS_PIXEL_M_OFF / NIGHT_POINTS_CELL0_M
    expect(points(0.5, 0, [0, 0], at, [off, 0], [0, off], 0.5, 86_400).n).toBe(1)
  })

  it('picks the same lights at a cell whichever way its coordinate is split, and across the antimeridian', () => {
    const dx: V2 = [0.03, 0]
    const dy: V2 = [0, 0.05]
    const local: V2 = [0.37, 0.81]
    // The globe's (all local) and the tiles' (whole cells apart).
    const cell: V2 = [300_123, 150_456]
    const globe = points(0.4, 0, [0, 0], [cell[0] + local[0], cell[1] + local[1]], dx, dy, 0.6, 10_800).n
    const tiles = points(0.4, 0, cell, local, dx, dy, 0.6, 10_800).n
    expect(tiles).toBeCloseTo(globe, 9)
    // One cell west of the antimeridian, from either side.
    const west = points(0.4, 0, [NIGHT_POINTS_CELLS_U - 1, 1000], [0.5, 0.5], dx, dy, 0.6, 10_800).n
    const wrapped = points(0.4, 0, [0, 1000], [-0.5, 0.5], dx, dy, 0.6, 10_800).n
    expect(wrapped).toBeCloseTo(west, 9)
  })

  it('keeps every constant consistent with the 2x2 search and the hash', () => {
    // The column wraps by a mask at every level.
    expect(Number.isInteger(Math.log2(NIGHT_POINTS_CELLS_U))).toBe(true)
    expect(NIGHT_POINTS_CELLS_U >> (2 * NIGHT_POINTS_LEVEL_MAX)).toBeGreaterThanOrEqual(1)
    expect(NIGHT_POINTS_CELLS_V * 2).toBe(NIGHT_POINTS_CELLS_U)
    // A kernel picked by the level fits within half a cell: radius at most
    // 0.3 k, blur at most BLUR_PX / CELL_PX of k.
    expect(Math.hypot(0.3, NIGHT_POINTS_BLUR_PX / NIGHT_POINTS_CELL_PX)).toBeLessThan(0.5)
    // The coarsest level still holds the largest footprint the breakup is
    // on for (both derivatives at the off edge, at COS_MIN).
    const off = NIGHT_POINTS_PIXEL_M_OFF / NIGHT_POINTS_CELL0_M
    const x = 0.5 * Math.log2((NIGHT_POINTS_CELL_PX * Math.SQRT2 * off) / NIGHT_POINTS_COS_MIN)
    expect(x).toBeLessThan(NIGHT_POINTS_LEVEL_MAX)
    expect(NIGHT_POINTS_TEXEL_PX_START).toBeLessThan(NIGHT_POINTS_TEXEL_PX_FULL)
    expect(NIGHT_POINTS_PIXEL_M_FULL).toBeLessThan(NIGHT_POINTS_PIXEL_M_OFF)
    expect(NIGHT_POINTS_CELL0_M).toBeCloseTo(76.35, 1)
  })
})
