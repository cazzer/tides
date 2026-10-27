// The night's lights as points (tides-zmw.23): the eye's cell from the CPU,
// the offset from it in float32 and its derivative, and the field's energy,
// each against a TypeScript copy of the GLSL.
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
  NIGHT_POINTS_CORE,
  NIGHT_POINTS_CORE_RADIUS_CELLS0,
  NIGHT_POINTS_COS_MIN,
  NIGHT_POINTS_FADE_FROM,
  NIGHT_POINTS_GLSL,
  NIGHT_POINTS_LEVEL_MAX,
  NIGHT_POINTS_PEAK,
  NIGHT_POINTS_PIXEL_M_FULL,
  NIGHT_POINTS_PIXEL_M_OFF,
  NIGHT_POINTS_RADIUS_CELLS0,
  NIGHT_POINTS_RESIDUAL,
  NIGHT_POINTS_SOFT,
  NIGHT_POINTS_SPACING_PX_FULL,
  NIGHT_POINTS_SPACING_PX_OFF,
  NIGHT_POINTS_SPREAD,
  NIGHT_POINTS_TEXEL_PX_FULL,
  NIGHT_POINTS_TEXEL_PX_START,
  NIGHT_POINTS_W_GROUND,
  NIGHT_POINTS_WEIGHT_NORM,
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

describe("the drawn point's cell coordinate (nightPointsOffset, nightPointsDelta)", () => {
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

  // nightPointsDelta, in double: the cells' change for a small change of the
  // point, against the difference of their cells.
  it("turns a small change of the drawn point into the cells' change, without the antimeridian's jump", () => {
    const delta = (p: THREE.Vector3, d: THREE.Vector3) => {
      const up = p.clone().normalize()
      const t = d.clone().addScaledVector(up, -up.dot(d)).divideScalar(p.length())
      const h = Math.max(up.x * up.x + up.z * up.z, 1e-12)
      return [((up.z * t.x - up.x * t.z) / h / (2 * Math.PI)) * NIGHT_POINTS_CELLS_U, (t.y / Math.sqrt(h) / Math.PI) * NIGHT_POINTS_CELLS_V]
    }
    expect(NIGHT_POINTS_GLSL.offsetHead).toContain(
      'return vec2((up.z * t.x - up.x * t.z) / h * RECIPROCAL_PI2, t.y * inversesqrt(h) * RECIPROCAL_PI) * NIGHT_POINTS_CELLS;'
    )
    for (const [lat, lon] of [...CITIES, [10, 180]]) {
      const p = dir(lat, lon).multiplyScalar(R + 200 * METRE)
      const d = new THREE.Vector3(0.3, -0.7, 0.2).multiplyScalar(METRE)
      const [du, dv] = delta(p, d)
      const [au, av] = cellOf(p)
      const [bu, bv] = cellOf(p.clone().add(d))
      expect(du).toBeCloseTo(wrapU(bu - au), 6)
      expect(dv).toBeCloseTo(bv - av, 6)
    }
  })
})

// The field (NIGHT_POINTS_GLSL.head) in double, line for line.
function mix32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = (x ^ (x >>> 15)) >>> 0
  x = Math.imul(x, 0x846ca68b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** A cell's light: its place in the cell, threshold and brightness. */
function cellLight(x: number, y: number, l: number) {
  const wrap = (NIGHT_POINTS_CELLS_U >> (2 * l)) - 1
  const h = mix32(((x & wrap) ^ mix32((y ^ (l << 24)) >>> 0)) >>> 0)
  return {
    at: [((h & 1023) + 0.5) / 1024, (((h >>> 10) & 1023) + 0.5) / 1024],
    threshold: (((h >>> 20) & 255) + 0.5) / 256,
    brightness: NIGHT_POINTS_WEIGHT_NORM * 2 ** (NIGHT_POINTS_SPREAD * ((h >>> 28) + 0.5) / 8 - NIGHT_POINTS_SPREAD),
  }
}

type V2 = [number, number]
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
const soft = (p: number, threshold: number) => Math.min(Math.max((p - threshold) / (2 * NIGHT_POINTS_SOFT) + 0.5, 0), 1)
const litOf = (p: number) => {
  const under = Math.max(NIGHT_POINTS_SOFT - p, 0)
  const over = Math.max(p - (1 - NIGHT_POINTS_SOFT), 0)
  return p + (under * under - over * over) / (4 * NIGHT_POINTS_SOFT)
}

/** An ellipse's form at level 0: radius r widened by the footprint, its
 * inverse [[a, c], [c, d]] / det and its area over k. */
function formAt(r: number, mdx: number[], mdy: number[], k: number) {
  const b2 = NIGHT_POINTS_BLUR_PX ** 2
  const a = r * r + b2 * (mdx[0] * mdx[0] + mdy[0] * mdy[0])
  const c = b2 * (mdx[0] * mdx[1] + mdy[0] * mdy[1])
  const d = r * r + b2 * (mdx[1] * mdx[1] + mdy[1] * mdy[1])
  const det = a * d - c * c
  return { a, c, d, det, A: Math.sqrt(det) / k }
}
type Form = ReturnType<typeof formAt>
/** 1 - e' S^-1 e at level l (level 0's S over 16^l), at least 0. */
const formQ = (F: Form, e: number[], s2: number) =>
  Math.max(1 - ((F.d * e[0] * e[0] - 2 * F.c * e[0] * e[1] + F.a * e[1] * e[1]) / F.det) * s2, 0)

/** Level 0's light for a footprint dx/dy (cells) at k: its glow and core. */
function lightAt(dx: V2, dy: V2, k: number, lum: number) {
  const mdx = [dx[0] * k, dx[1]]
  const mdy = [dy[0] * k, dy[1]]
  const glow = formAt(Math.min(NIGHT_POINTS_RADIUS_CELLS0, 0.3 * k), mdx, mdy, k)
  const core = formAt(Math.min(NIGHT_POINTS_CORE_RADIUS_CELLS0, 0.3 * k), mdx, mdy, k)
  return {
    k,
    glow,
    core,
    share: [((1 - NIGHT_POINTS_CORE) * 3) / Math.PI / glow.A, (NIGHT_POINTS_CORE * 3) / Math.PI / core.A],
    p0: lum / (NIGHT_POINTS_PEAK * Math.max((Math.PI / 3) * glow.A, NIGHT_POINTS_W_GROUND)),
  }
}
type Light = ReturnType<typeof lightAt>

/** nightPointsLevel; `reach` cells each way of the pixel's own two (the
 * GLSL's is 0: its 2x2), and `only` the cells (whole ids) it passes. */
function level(l: number, base: V2, local: V2, L: Light, reach = 0, only?: (x: number, y: number) => boolean) {
  const s = 4 ** l
  const s2 = s * s
  const hi = [Math.floor(base[0] / s), Math.floor(base[1] / s)]
  const at = [(base[0] - hi[0] * s + local[0]) / s, (base[1] - hi[1] * s + local[1]) / s]
  const p = Math.min(L.p0 * s2, 1)
  const lit = litOf(p)
  const c0 = [Math.floor(at[0] - 0.5), Math.floor(at[1] - 0.5)]
  let sum = 0
  for (let j = -reach; j < 2 + reach; j++) {
    for (let i = -reach; i < 2 + reach; i++) {
      const cell = [c0[0] + i, c0[1] + j]
      const [x, y] = [hi[0] + cell[0], hi[1] + cell[1]]
      if (only && !only(x, y)) continue
      const light = cellLight(x, y, l)
      const e = [(cell[0] + light.at[0] - at[0]) * L.k, cell[1] + light.at[1] - at[1]]
      const form = L.share[0] * formQ(L.glow, e, s2) ** 2 + L.share[1] * formQ(L.core, e, s2) ** 2
      sum += light.brightness * form * soft(p, light.threshold)
    }
  }
  return { n: (sum * s2) / lit, p, lit }
}

/** The smaller singular value of [a b]. */
function narrow(a: V2, b: V2) {
  const frobenius = a[0] ** 2 + a[1] ** 2 + b[0] ** 2 + b[1] ** 2
  const det = Math.abs(a[0] * b[1] - a[1] * b[0])
  return det / Math.max(Math.sqrt(0.5 * (frobenius + Math.sqrt(Math.max(frobenius ** 2 - 4 * det * det, 0)))), 1e-12)
}

/** nightPoints, with the levels it picks. */
function points(lum: number, fine: number, base: V2, local: V2, dx: V2, dy: V2, v: number, mapWidth: number, reach = 0) {
  const k = Math.max(Math.sin(v * Math.PI), NIGHT_POINTS_COS_MIN)
  const mdx: V2 = [dx[0] * k, dx[1]]
  const mdy: V2 = [dy[0] * k, dy[1]]
  const pixel = Math.log2(Math.max(narrow(dx, dy), 1e-6))
  const ground = Math.log2(Math.max(narrow(mdx, mdy), 1e-6))
  const texel =
    Math.log2(NIGHT_POINTS_CELLS_U / mapWidth) * (1 - fine) + Math.log2(NIGHT_POINTS_CELLS_U / GIBS_GROUND_WIDTH) * fine
  const footprint = Math.hypot(...mdx, ...mdy)
  const x = 0.5 * Math.log2(Math.max((NIGHT_POINTS_CELL_PX * footprint) / k, 1e-6))
  const spacing = 2 * x - ground
  const breakup =
    smoothstep(Math.log2(NIGHT_POINTS_TEXEL_PX_START), Math.log2(NIGHT_POINTS_TEXEL_PX_FULL), texel - pixel) *
    (1 -
      smoothstep(
        Math.log2(NIGHT_POINTS_PIXEL_M_FULL / NIGHT_POINTS_CELL0_M),
        Math.log2(NIGHT_POINTS_PIXEL_M_OFF / NIGHT_POINTS_CELL0_M),
        ground
      )) *
    (1 - smoothstep(NIGHT_POINTS_LEVEL_MAX - 1, NIGHT_POINTS_LEVEL_MAX, x)) *
    (1 - smoothstep(Math.log2(NIGHT_POINTS_SPACING_PX_FULL), Math.log2(NIGHT_POINTS_SPACING_PX_OFF), spacing))
  if (breakup <= 0 || lum <= 0) return { n: 1, breakup: 0, spacing: 2 ** spacing, levels: [] as number[] }
  const above = Math.floor(x) + 1
  const l0 = Math.min(Math.max(above, 0), NIGHT_POINTS_LEVEL_MAX)
  const t = above < 0 || above >= NIGHT_POINTS_LEVEL_MAX ? 0 : smoothstep(NIGHT_POINTS_FADE_FROM, 1, x - Math.floor(x))
  const L = lightAt(dx, dy, k, lum)
  let n = 0
  const levels: number[] = []
  if (t < 1) {
    n += (1 - t) * level(l0, base, local, L, reach).n
    levels.push(l0)
  }
  if (t > 0) {
    n += t * level(l0 + 1, base, local, L, reach).n
    levels.push(l0 + 1)
  }
  return { n: 1 + breakup * (NIGHT_POINTS_RESIDUAL + (1 - NIGHT_POINTS_RESIDUAL) * n - 1), breakup, spacing: 2 ** spacing, levels }
}

/** A deterministic uniform [0, 1). */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return mix32(s) / 2 ** 32
  }
}

describe('the field of lights', () => {
  it('is in the GLSL as copied here', () => {
    const g = NIGHT_POINTS_GLSL.head
    for (const line of [
      'uint h = nightPointsHash(uint(id.x & wrap) ^ nightPointsHash(uint(id.y) ^ uint(level << 24)));',
      'vec2 d = (cell + (vec2(uvec2(h, h >> 10u) & 1023u) + 0.5) / 1024.0 - at) * m;',
      'float threshold = (float((h >> 20u) & 255u) + 0.5) / 256.0;',
      'float form = share0.x * glow * glow + share0.y * core * core;',
      'float lit = p + (under * under - over * over) / 0.200000;',
      'return sum * s2 / lit;',
      'float A = sqrt(determinant(glowS)) / k;',
      'vec2 share = vec2(0.095493 / A, 0.859437 * k / sqrt(determinant(coreS)));',
      'float p0 = lum / (5.000000 * max(1.047198 * A, 0.060000));',
      'float t = above < 0 || above >= 6 ? 0.0 : smoothstep(0.700000, 1.0, fract(x));',
      'float spacing = 2.0 * x - ground;',
      '* (1.0 - smoothstep(4.584963, 6.000000, spacing))',
      '* (1.0 - smoothstep(5.000000, 6.000000, x));',
    ]) {
      expect(g, line).toContain(line)
    }
    expect(g).not.toMatch(/dFd|fwidth/)
    // Every log2 guarded against a zero footprint.
    for (const call of g.match(/log2\([^;]*/g) ?? []) {
      if (!/mapWidth|TEXEL|^log2\(\$/.test(call)) expect(call, call).toMatch(/^log2\(max\(/)
    }
  })

  it("lights the cells the threshold's soft edge lets through on average: lit", () => {
    for (const p of [0.001, 0.02, 0.05, 0.3, 0.97, 1]) {
      let sum = 0
      const N = 256
      // The thresholds are 8 bits, at their steps' centres.
      for (let i = 0; i < N; i++) sum += soft(p, (i + 0.5) / N)
      expect(sum / N).toBeCloseTo(litOf(p), 3)
    }
  })

  // Each light's glow and core, over the cell coordinate, integrate to their
  // shares of its brightness: the light of the cells a level holds, integrated,
  // is what their thresholds let through over lit. Integrated finely over a
  // few cells (and a cell round them, for the forms that spill out),
  // counting only their own lights.
  it("integrates each light to its brightness over lit, glow and core", () => {
    const cases: { l: number; k: number; dx: V2; dy: V2; lum: number }[] = [
      { l: 0, k: 0.87, dx: [0.01, 0], dy: [0, 0.01], lum: 0.3 },
      { l: 0, k: 0.5, dx: [0.001, 0], dy: [0, 0.003], lum: 0.2 },
      { l: 1, k: 0.6, dx: [0.3, 0.1], dy: [-0.2, 0.5], lum: 0.05 },
      { l: 2, k: 0.25, dx: [1.2, -0.4], dy: [0.9, 3.1], lum: 1 },
      { l: 3, k: 0.9, dx: [4, 0], dy: [0, 9], lum: 0.01 },
    ]
    for (const { l, k, dx, dy, lum } of cases) {
      const L = lightAt(dx, dy, k, lum)
      const s = 4 ** l
      const M = 3
      const base: V2 = [1000 * s, 2000 * s]
      const inside = (x: number, y: number) => x >= 1000 && x < 1000 + M && y >= 2000 && y < 2000 + M
      // The core's narrowest half-width, in level-l cells.
      const step = Math.min(Math.sqrt(Math.min(L.core.a / (k * k), L.core.d)) / s / 5, 0.02)
      let integral = 0
      for (let y = -1 + step / 2; y < M + 1; y += step) {
        for (let x = -1 + step / 2; x < M + 1; x += step) {
          integral += level(l, base, [x * s, y * s], L, 0, inside).n * step * step
        }
      }
      const { p, lit } = level(l, base, [0, 0], L)
      let expected = 0
      for (let j = 0; j < M; j++) {
        for (let i = 0; i < M; i++) {
          const light = cellLight(1000 + i, 2000 + j, l)
          expected += (light.brightness * soft(p, light.threshold)) / lit
        }
      }
      expect(expected).toBeGreaterThan(0)
      expect(Math.abs(integral / expected - 1), `level ${l}`).toBeLessThan(3e-3)
    }
  })

  it('lights lit of the cells on average by their hashed thresholds, at a mean brightness of 1', () => {
    for (const p of [0.01, 0.2, 0.8, 1]) {
      const lit = litOf(p)
      const N = 200_000
      let sum = 0
      let bright = 0
      for (let i = 0; i < N; i++) {
        const light = cellLight((i * 7919) & (NIGHT_POINTS_CELLS_U - 1), 100_000 + (i >> 9), i % 3)
        sum += soft(p, light.threshold)
        bright += light.brightness
      }
      expect(Math.abs(sum / N - lit)).toBeLessThan(4 * Math.sqrt(lit / N) + 1e-3)
      expect(bright / N).toBeCloseTo(1, 2)
    }
    const mean = Array.from({ length: 16 }, (_, i) => NIGHT_POINTS_WEIGHT_NORM * 2 ** (NIGHT_POINTS_SPREAD * ((i + 0.5) / 8 - 1)))
    expect(mean.reduce((a, b) => a + b) / 16).toBeCloseTo(1, 12)
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
          expect(Math.abs(mean - 1), `v ${v} lum ${lum} scale ${scale}: ${mean} ± ${error}`).toBeLessThan(4 * error + 2e-3)
        }
      }
    }
  })

  it('needs no cells but the 2x2 nearest the pixel: a 6x6 search sums the same', () => {
    const rand = random(2)
    for (let i = 0; i < 4000; i++) {
      // Any footprint up to the breakup's end, at any latitude, stretched
      // any way (grazing too).
      const scale = 2 ** (rand() * 16 - 10)
      const turn = rand() * Math.PI
      const stretch = 1 + 30 * rand() ** 2
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

  it('stops the breakup where a texel is 2 px or less, from 600 m pixels up (orbit), at a grazing stretch and past the coarsest level', () => {
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
    // From orbit, 1500 km over the ground straight down, on the tallest
    // screen the page draws (2880 rows: 1440 px at its pixel ratio cap, 2)
    // through the ship's 60° FOV, with the desktop's map and a phone's.
    const orbit = (1500e3 * 2 * Math.tan(Math.PI / 6)) / 2880 / NIGHT_POINTS_CELL0_M
    expect(orbit * NIGHT_POINTS_CELL0_M).toBeGreaterThan(600)
    for (const map of [10_800, 2048]) {
      // u's cells narrow by k: the same ground pixel is orbit / k of them.
      for (const v of [0.5, 0.67]) {
        const k = Math.sin(v * Math.PI)
        expect(points(0.5, 0, [0, 0], at, [orbit / k, 0], [0, orbit], v, map).n).toBe(1)
      }
    }
    // Grazing: a pixel 50 m across and 3x as long breaks the texels it
    // magnifies across; 60x as long (its cells sized by the long axis would
    // stand hundreds of pixels apart across it) it leaves the glow be.
    const across = 50 / NIGHT_POINTS_CELL0_M
    expect(points(0.5, 0, [0, 0], at, [across, 0], [0, 3 * across], 0.5, 10_800).breakup).toBe(1)
    const graze = points(0.5, 0, [0, 0], at, [across, 0], [0, 60 * across], 0.5, 10_800)
    expect(graze.n).toBe(1)
    expect(graze.spacing).toBeGreaterThan(NIGHT_POINTS_SPACING_PX_OFF)
    expect(points(0.5, 0, [0, 0], at, [across, 0], [0, 6000 * across], 0.5, 10_800).n).toBe(1)
    // No footprint at all (a degenerate quad): finite.
    expect(Number.isFinite(points(0.5, 0, [0, 0], at, [0, 0], [0, 0], 0.5, 10_800).n)).toBe(true)
  })

  // Wherever the breakup is on, the cells are at most SPACING_PX_OFF pixels
  // apart across the footprint's narrow axis at the continuous level, 4
  // times that at the level drawn (above level 0, whose cells are the
  // ground's); and a footprint stretched 60 times leaves none on at level 3
  // or coarser.
  it('keeps the lights at most a few dozen pixels apart on screen wherever they are on', () => {
    const rand = random(3)
    let on = 0
    for (let i = 0; i < 20_000; i++) {
      const scale = 2 ** (rand() * 14 - 8)
      const turn = rand() * Math.PI
      const stretch = 2 ** (rand() * 7)
      const dx: V2 = [scale * Math.cos(turn), scale * Math.sin(turn)]
      const dy: V2 = [-stretch * scale * Math.sin(turn), stretch * scale * Math.cos(turn)]
      const v = 0.08 + 0.84 * rand()
      const r = points(0.5, 0, [0, 0], [10.5, 20.5], dx, dy, v, 10_800)
      if (r.breakup > 0) {
        on++
        expect(r.spacing).toBeLessThan(NIGHT_POINTS_SPACING_PX_OFF)
        // The finer level drawn (the cross-fade's other is 4 times
        // coarser): its cell over the narrow axis on the ground. Level 0's
        // cells are the ground's, however near.
        const k = Math.max(Math.sin(v * Math.PI), NIGHT_POINTS_COS_MIN)
        const level = Math.min(...r.levels)
        if (level > 0) expect(4 ** level / narrow([dx[0] * k, dx[1]], [dy[0] * k, dy[1]])).toBeLessThan(4 * NIGHT_POINTS_SPACING_PX_OFF)
      }
      if (stretch >= 60 && r.levels.some((l) => l >= 3)) expect(r.breakup).toBe(0)
    }
    expect(on).toBeGreaterThan(2000)
    // A stretch-60 footprint at level 3 or coarser: off.
    for (const across of [2, 10, 30]) {
      const r = points(0.5, 0, [0, 0], [0.5, 0.5], [across, 0], [0, 60 * across], 0.5, 10_800)
      expect(r.breakup).toBe(0)
    }
  })

  it('picks the same lights at a cell whichever way its coordinate is split, and across the antimeridian', () => {
    const dx: V2 = [0.03, 0]
    const dy: V2 = [0, 0.05]
    const local: V2 = [0.37, 0.81]
    // All local, and whole cells apart.
    const cell: V2 = [300_123, 150_456]
    const whole = points(0.4, 0, [0, 0], [cell[0] + local[0], cell[1] + local[1]], dx, dy, 0.6, 10_800).n
    const split = points(0.4, 0, cell, local, dx, dy, 0.6, 10_800).n
    expect(split).toBeCloseTo(whole, 9)
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
    // A form picked by the level fits within half a cell: the glow at most
    // 0.3 k, the blur at most BLUR_PX / CELL_PX of k.
    expect(Math.hypot(0.3, NIGHT_POINTS_BLUR_PX / NIGHT_POINTS_CELL_PX)).toBeLessThan(0.5)
    expect(NIGHT_POINTS_TEXEL_PX_START).toBeLessThan(NIGHT_POINTS_TEXEL_PX_FULL)
    expect(NIGHT_POINTS_PIXEL_M_FULL).toBeLessThan(NIGHT_POINTS_PIXEL_M_OFF)
    expect(NIGHT_POINTS_CELL0_M).toBeCloseTo(76.35, 1)
    // Both radii within the half cell at COS_MIN, the core's inside the glow.
    expect(NIGHT_POINTS_CORE_RADIUS_CELLS0).toBeLessThan(0.3 * NIGHT_POINTS_COS_MIN)
    expect(NIGHT_POINTS_CORE_RADIUS_CELLS0).toBeLessThan(NIGHT_POINTS_RADIUS_CELLS0)
  })
})
