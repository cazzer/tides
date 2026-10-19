import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  airMass,
  CLOUD_CLEARANCE,
  CLOUD_FLAT_ALTITUDE,
  CLOUD_LAYER_TOP,
  CLOUD_UNITS_PER_KM,
  cloudColumn,
  cloudShape,
  cloudTopKm,
  defaultTopKm,
  directionToUv,
  distanceToRadius,
  driftOffset,
  horizonDipSin,
  MAX_CLOUD_TOP_KM,
  maxTopKm,
  shadowCaster,
  sunlightTint,
  TERRAIN_DISPLACEMENT,
  TERRAIN_MAX_GREY,
  type Vec3,
} from './cloud-layer'

const DEG = Math.PI / 180

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('directionToUv', () => {
  it('matches SphereGeometry vertex by vertex', () => {
    const geometry = new THREE.SphereGeometry(1, 24, 12)
    const pos = geometry.attributes.position
    const uv = geometry.attributes.uv
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      // The poles and the seam have no single u.
      if (Math.abs(y) > 0.999) continue
      const u = uv.getX(i)
      if (u < 1e-6 || u > 1 - 1e-6) continue
      const [gotU, gotV] = directionToUv([pos.getX(i), y, pos.getZ(i)])
      expect(gotU).toBeCloseTo(u, 6)
      expect(gotV).toBeCloseTo(uv.getY(i), 6)
    }
  })

  it('puts Greenwich at +X and east toward -Z', () => {
    expect(directionToUv([1, 0, 0])).toEqual([0.5, 0.5])
    expect(directionToUv([0, 0, -1])[0]).toBeCloseTo(0.75)
    expect(directionToUv([0, 1, 0])[1]).toBeCloseTo(1)
  })
})

describe('cloud tops', () => {
  it('uses the measured height where the satellites are trusted', () => {
    expect(cloudTopKm(0.5, 1, 0.8, 1)).toBeCloseTo(0.5 * MAX_CLOUD_TOP_KM)
    // Daytime low cloud reads ~0 from IR; it still has some height.
    expect(cloudTopKm(0, 1, 0.8, 1)).toBeGreaterThanOrEqual(1)
  })

  it('falls back to brightness without coverage or heights', () => {
    expect(cloudTopKm(0.5, 0, 0.8, 1)).toBeCloseTo(defaultTopKm(0.8))
    // A grey texture's R and B are its brightness, not heights.
    expect(cloudTopKm(0.8, 0.8, 0.8, 0)).toBeCloseTo(defaultTopKm(0.8))
    expect(cloudTopKm(0.5, 0.5, 0.8, 1)).toBeCloseTo(
      (defaultTopKm(0.8) + 0.5 * MAX_CLOUD_TOP_KM) / 2
    )
  })

  it('gives thicker cloud taller tops and thin edges low ones', () => {
    expect(defaultTopKm(1)).toBeGreaterThan(defaultTopKm(0.3))
    expect(cloudShape(0)).toBeLessThan(cloudShape(0.3))
    expect(cloudShape(1)).toBe(1)
  })

  it('stays inside the layer and above the ground', () => {
    for (const grey of [0, 0.4, TERRAIN_MAX_GREY]) {
      const { base, top } = cloudColumn(1, maxTopKm(true), grey)
      expect(base).toBeCloseTo(grey * TERRAIN_DISPLACEMENT + CLOUD_CLEARANCE)
      expect(top).toBeLessThanOrEqual(CLOUD_LAYER_TOP + 1e-9)
      expect(base).toBeGreaterThan(grey * TERRAIN_DISPLACEMENT)
    }
  })

  it('keeps the flat shell clear of the highest ground (tides-7oi)', () => {
    expect(CLOUD_FLAT_ALTITUDE).toBeGreaterThan(TERRAIN_MAX_GREY * TERRAIN_DISPLACEMENT)
    expect(CLOUD_FLAT_ALTITUDE).toBeLessThan(CLOUD_LAYER_TOP)
  })

  it('bounds the march by what the texture can hold', () => {
    expect(maxTopKm(true)).toBe(MAX_CLOUD_TOP_KM)
    expect(maxTopKm(false)).toBe(defaultTopKm(1))
  })
})

describe('shadowCaster', () => {
  const R = 2.95
  const ground: Vec3 = [1, 0, 0]

  it('is straight up with the Sun overhead', () => {
    const p = shadowCaster(ground, [1, 0, 0], R, R, 0.03)
    expect(p[0]).toBeCloseTo(1)
  })

  it('lies toward the Sun, about height x tan(zenith) away', () => {
    const h = 0.004
    for (const zenithDeg of [20, 45, 70]) {
      const z = zenithDeg * DEG
      // The Sun to the east (-Z) of the point, at this zenith angle.
      const sun: Vec3 = [Math.cos(z), 0, -Math.sin(z)]
      const p = shadowCaster(ground, sun, R, R, h)
      expect(directionToUv(p)[0]).toBeGreaterThan(0.5) // east
      const arc = Math.acos(Math.min(1, dot(p, ground))) * R
      expect(arc).toBeCloseTo(h * Math.tan(z), 3)
    }
  })

  it('reaches further as the Sun gets lower, and further for higher cloud', () => {
    const arc = (zenithDeg: number, h: number) => {
      const z = zenithDeg * DEG
      const p = shadowCaster(ground, [Math.cos(z), 0, -Math.sin(z)], R, R, h)
      return Math.acos(Math.min(1, dot(p, ground)))
    }
    expect(arc(80, 0.03)).toBeGreaterThan(arc(60, 0.03))
    expect(arc(89.9, 0.03)).toBeGreaterThan(arc(80, 0.03))
    expect(arc(60, 0.06)).toBeGreaterThan(arc(60, 0.03))
    // At the terminator it's the horizon distance to that height.
    expect(arc(90, 0.03)).toBeCloseTo(Math.acos(R / (R + 0.03)), 6)
  })

  it('starts from raised ground', () => {
    const sun = unit([1, 0, -1])
    const t = distanceToRadius(R + 0.02, Math.SQRT1_2, R + 0.05)
    const p: Vec3 = [(R + 0.02) + sun[0] * t, 0, sun[2] * t]
    expect(Math.hypot(...p)).toBeCloseTo(R + 0.05, 9)
    expect(shadowCaster(ground, sun, R + 0.02, R, 0.05)).toEqual(unit(p))
  })
})

describe('static cloud drift', () => {
  it('maps the drift to a texture offset in [0, 1)', () => {
    expect(driftOffset(0)).toBe(0)
    expect(driftOffset(Math.PI)).toBeCloseTo(0.5)
    expect(driftOffset(2 * Math.PI + 0.1)).toBeCloseTo(0.1 / (2 * Math.PI))
  })

  it('moves clouds east as the old mesh rotation did', () => {
    // rotation.y = θ carried texture u = 0.5 (local +X) to local
    // (cos θ, 0, -sin θ), i.e. east; the shader reads u - offset there.
    const theta = 0.3
    const seenAt = directionToUv([Math.cos(theta), 0, -Math.sin(theta)])[0]
    expect(seenAt - driftOffset(theta)).toBeCloseTo(0.5)
  })
})

describe('sunlight on cloud tops', () => {
  it('lights tops a little past the ground terminator', () => {
    expect(horizonDipSin(0)).toBe(0)
    expect(horizonDipSin(10)).toBeGreaterThan(horizonDipSin(2))
    // 10 km sees about 3.2 degrees past the horizon.
    expect(Math.asin(horizonDipSin(10)) / DEG).toBeCloseTo(3.2, 1)
  })

  it('is white overhead and reddens toward the horizon', () => {
    const noon = sunlightTint(1, 2)
    for (const c of noon) expect(c).toBeCloseTo(1, 4)
    const low = sunlightTint(Math.cos(85 * DEG), 2)
    expect(low[0]).toBeCloseTo(1)
    expect(low[1]).toBeLessThan(low[0])
    expect(low[2]).toBeLessThan(low[1])
    const horizon = sunlightTint(0, 2)
    expect(horizon[2]).toBeLessThan(low[2])
  })

  it('reddens less for higher cloud', () => {
    expect(sunlightTint(0.05, 12)[2]).toBeGreaterThan(sunlightTint(0.05, 1)[2])
  })

  it('has a sane air mass', () => {
    expect(airMass(1)).toBeCloseTo(1, 2)
    expect(airMass(0)).toBeCloseTo(38, 0)
    expect(airMass(-0.05)).toBe(airMass(0))
  })
})

it('exaggerates cloud tops less than the terrain', () => {
  expect(CLOUD_UNITS_PER_KM).toBeLessThan(TERRAIN_DISPLACEMENT / 6.5)
})
