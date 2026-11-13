import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import { latLonToLocal } from './aurora'
import { directionToUv } from './cloud-layer'
import { flashSeed, hashKey, pulseCount } from './lightning'
import {
  flashHalfSize,
  flashShape,
  flashTangentBasis,
  limbShear,
  MAX_FLASH_FRACTION,
  MIN_FLASH_PX,
  unwrapU,
} from './lightning-patch'

const e1 = new THREE.Vector3()
const e2 = new THREE.Vector3()
const cross = new THREE.Vector3()

function expectBasis(dir: THREE.Vector3, angle: number) {
  flashTangentBasis(dir, angle, e1, e2)
  for (const v of [e1, e2]) {
    expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true)
    expect(v.length()).toBeCloseTo(1, 9)
    expect(v.dot(dir)).toBeCloseTo(0, 9)
  }
  expect(e1.dot(e2)).toBeCloseTo(0, 9)
  // Right-handed: e1 × e2 = dir.
  cross.crossVectors(e1, e2)
  expect(cross.distanceTo(dir)).toBeLessThan(1e-9)
}

// Scene units per CSS px at depth `depth`, as the vertex shader has it.
const perspectivePx = (fovDeg: number, depth: number, vh: number) => (2 * Math.tan((fovDeg * Math.PI) / 360) * depth) / vh

const glsl = (name: string) =>
  readFileSync(new URL(`./shaders/lightning/${name}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')

describe('lightning patch', () => {
  test('the tangent basis is orthonormal, in the plane, right-handed', () => {
    const dir = new THREE.Vector3()
    for (const [lat, lon] of [
      [0, 0],
      [30, -90],
      [-45, 120],
      [70, 179.9],
      [-89, -10],
    ]) {
      latLonToLocal(lat, lon, dir)
      for (const angle of [0, 0.7, 2, 4.5]) expectBasis(dir, angle)
    }
  })

  test('unturned at (0, 0): east is -Z, north +Y; e1 · east is cos θ', () => {
    const dir = latLonToLocal(0, 0, new THREE.Vector3())
    flashTangentBasis(dir, 0, e1, e2)
    expect(e1.distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-12)
    expect(e2.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-12)
    // East is toward increasing longitude.
    const ahead = latLonToLocal(0, 1, new THREE.Vector3())
    expect(ahead.sub(dir).dot(e1)).toBeGreaterThan(0)
    const east = new THREE.Vector3()
    const north = new THREE.Vector3()
    latLonToLocal(35, -60, dir)
    flashTangentBasis(dir, 0, east, north)
    for (const angle of [0.3, 1.9, 3.5, 5.8]) {
      flashTangentBasis(dir, angle, e1, e2)
      expect(e1.dot(east)).toBeCloseTo(Math.cos(angle), 9)
    }
  })

  test('finite at the poles and just off them', () => {
    for (const y of [1, -1, 0.99995, -0.99995]) {
      const dir = new THREE.Vector3(Math.sqrt(1 - y * y), y, 0)
      expectBasis(dir, 1.234)
      const tilted = new THREE.Vector3(0.6, 0, 0.8).multiplyScalar(Math.sqrt(1 - y * y)).setY(y)
      expectBasis(tilted, 5.1)
    }
  })

  describe('flashHalfSize', () => {
    const vw = 393
    const vh = 800
    const capPx = MAX_FLASH_FRACTION * vw

    test('an 80 km flash from the ship at 300 and 555 km is capped', () => {
      for (const depthKm of [300, 555]) {
        const pxWorld = perspectivePx(60, depthKm, vh)
        const { major, capped } = flashHalfSize(80, pxWorld, vw, vh)
        expect(capped).toBe(true)
        expect(major / pxWorld).toBeCloseTo(capPx, 9)
      }
    })

    test('floored at MIN_FLASH_PX from orbit', () => {
      const pxWorld = perspectivePx(60, 100_000, vh)
      const { major, capped } = flashHalfSize(8, pxWorld, vw, vh)
      expect(capped).toBe(false)
      expect(major / pxWorld).toBeCloseTo(MIN_FLASH_PX, 9)
    })

    test('the true size between the floor and the cap', () => {
      const pxWorld = perspectivePx(60, 2000, vh)
      const { major, capped } = flashHalfSize(20, pxWorld, vw, vh)
      expect(capped).toBe(false)
      expect(major).toBe(20)
      expect(major / pxWorld).toBeGreaterThan(MIN_FLASH_PX)
      expect(major / pxWorld).toBeLessThan(capPx)
    })

    test('the cap wins over the floor in a tiny viewport', () => {
      const pxWorld = perspectivePx(60, 100_000, 30)
      const { major, capped } = flashHalfSize(8, pxWorld, 30, 30)
      expect(capped).toBe(true)
      expect(major / pxWorld).toBeCloseTo(MAX_FLASH_FRACTION * 30, 9)
      expect(major / pxWorld).toBeLessThan(MIN_FLASH_PX)
    })

    test('orthographic, still capped', () => {
      // A main view zoomed to 500 km top to bottom.
      const pxWorld = 500 / vh
      const { major, capped } = flashHalfSize(80, pxWorld, vw, vh)
      expect(capped).toBe(true)
      expect(major / pxWorld).toBeCloseTo(capPx, 9)
    })
  })

  describe('limbShear', () => {
    const effective = (mu: number, minMu: number) => mu + limbShear(mu, minMu) * Math.sqrt(1 - mu * mu)

    test('none when already thick enough', () => {
      expect(limbShear(0.5, 0.2)).toBe(0)
      expect(limbShear(0.2, 0.2)).toBe(0)
      expect(limbShear(1, 1)).toBe(0)
    })

    test('edge on, as thick as the minimum', () => {
      for (const minMu of [0.01, 0.1, 1]) expect(effective(0, minMu)).toBeGreaterThanOrEqual(minMu - 1e-3)
      expect(effective(0.05, 0.3)).toBeCloseTo(0.3, 9)
    })

    test('finite toward face on', () => {
      for (const mu of [0.999, 0.999999, 1 - 1e-12, 1]) {
        const t = limbShear(mu, 1)
        expect(Number.isFinite(t)).toBe(true)
        expect(t).toBeLessThan(0.05)
      }
    })
  })

  test('flashShape: angles, aspects and noise offsets in range, aspect apart from the pulse count', () => {
    const h = hashKey('OR_GLM-L2-LCFA_G19_s20263170000000')
    const seeds = Array.from({ length: 3000 }, (_, i) => flashSeed(h, i))
    const shapes = seeds.map(flashShape)
    for (const s of shapes) {
      expect(s.angle).toBeGreaterThanOrEqual(0)
      expect(s.angle).toBeLessThan(2 * Math.PI)
      expect(s.aspect).toBeGreaterThanOrEqual(1)
      expect(s.aspect).toBeLessThan(1.6)
      for (const o of [s.noiseX, s.noiseY]) {
        expect(o).toBeGreaterThanOrEqual(0)
        expect(o).toBeLessThan(64)
      }
    }
    // Pearson's r between aspect and pulse count.
    const a = shapes.map((s) => s.aspect)
    const p = seeds.map(pulseCount)
    const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length
    const ma = mean(a)
    const mp = mean(p)
    let sap = 0
    let saa = 0
    let spp = 0
    for (let i = 0; i < a.length; i++) {
      sap += (a[i] - ma) * (p[i] - mp)
      saa += (a[i] - ma) ** 2
      spp += (p[i] - mp) ** 2
    }
    expect(Math.abs(sap / Math.sqrt(saa * spp))).toBeLessThan(0.1)
    // Each pulse count still sees the whole range of aspects.
    for (const k of [1, 2, 3]) {
      const ak = a.filter((_, i) => p[i] === k)
      expect(Math.min(...ak)).toBeLessThan(1.1)
      expect(Math.max(...ak)).toBeGreaterThan(1.5)
    }
  })

  test('unwrapU: continuous across the seam', () => {
    expect(unwrapU(0.02, 0.98)).toBeCloseTo(1.02, 12)
    expect(unwrapU(0.97, 0.01)).toBeCloseTo(-0.03, 12)
    expect(unwrapU(0.4, 0.45)).toBeCloseTo(0.4, 12)
    for (let u = 0.9; u < 1.1; u += 0.01) {
      const wrapped = u - Math.floor(u)
      expect(unwrapU(wrapped, 0.995)).toBeCloseTo(u, 9)
    }
  })

  test('latLonToLocal then directionToUv is ((lon + 180) / 360, (lat + 90) / 180)', () => {
    const dir = new THREE.Vector3()
    for (const [lat, lon] of [
      [0, 0],
      [12, 90],
      [-33, -90],
      [60, 170],
      [-75, -179],
      [45, 45],
    ]) {
      latLonToLocal(lat, lon, dir)
      const [u, v] = directionToUv([dir.x, dir.y, dir.z])
      expect(unwrapU(u, (lon + 180) / 360)).toBeCloseTo((lon + 180) / 360, 9)
      expect(v).toBeCloseTo((lat + 90) / 180, 9)
    }
  })

  test('the vertex shader caps, floors and shears as these do', () => {
    const vertex = glsl('vertex.glsl')
    expect(vertex).toContain('min(max(aFlash.w * uKmToScene * sqrt(aspect), uMinPx * pxWorld)')
    expect(vertex).toContain('uMaxFrac * min(uViewportW, uViewportH) * pxWorld)')
    expect(vertex).toContain('float minMu = min(1.0, uMinEdgePx * pxWorld / minor);')
    expect(vertex).toContain('float t = max(0.0, minMu - mu) / max(sqrt(1.0 - mu * mu), 1e-3);')
    expect(vertex).toContain('corner.xyz -= nV * t * dot(corner.xyz - centre.xyz, hV);')
    expect(vertex).toContain('fract(seed * 97.31)')
    expect(vertex).toContain('1.0 + 0.6 * fract(seed * 61.7)')
    expect(vertex).toContain('vec2(fract(seed * 13.1), fract(seed * 29.7)) * 64.0')
    expect(vertex).toContain('abs(dir.y) > 0.9999')
    expect(vertex).toContain('floor(du + 0.5)')
    // Camera-facing no more, and no near fade.
    expect(vertex).not.toContain('centre.xy +=')
    expect(vertex).not.toMatch(/\bnear\b/)
    expect(vertex).not.toMatch(/\bround\(/)
  })

  test('the fragment shader: no sine, one cloud tap by gradient, derivatives before the discard', () => {
    const fragment = glsl('fragment.frag')
    expect(fragment).not.toContain('sin(')
    expect(fragment).not.toMatch(/\bround\(/)
    expect(fragment).not.toMatch(/\b(for|while)\s*\(/)
    expect(fragment).toContain('textureGrad(uCloudMap')
    expect(fragment.match(/texture\w*\(/g)).toHaveLength(1)
    const discard = fragment.indexOf('discard')
    expect(discard).toBeGreaterThan(0)
    expect(fragment.indexOf('dFdx(')).toBeGreaterThan(0)
    expect(fragment.indexOf('dFdx(')).toBeLessThan(discard)
    expect(fragment.indexOf('dFdy(')).toBeLessThan(discard)
  })
})
