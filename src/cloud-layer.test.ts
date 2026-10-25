import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  airMass,
  CEILING_ARC_DEG,
  CEILING_GREY_MARGIN,
  ceilingReach,
  cloudCeiling,
  CLOUD_CLEARANCE,
  CLOUD_FLAT_ALTITUDE,
  CLOUD_LAYER_TOP,
  CLOUD_UNITS_PER_KM,
  cloudColumn,
  cloudFrame,
  DETAIL_OCTAVES,
  DETAIL_OCTAVES_FLAT,
  detailOctaveWeight,
  detailOctaveWeights,
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
  sunbeamAirMass,
  sunbeamTangentKm,
  sunlightTint,
  sunsetDipSin,
  sunVisibility,
  TERRAIN_DISPLACEMENT,
  TERRAIN_MAX_GREY,
  TERRAIN_MAX_GREY_FLAT,
  TERRAIN_READ_TEXELS,
  type Vec3,
} from './cloud-layer'
import { decodeEarthDem, demLevel } from './earth-dem'

const DEG = Math.PI / 180

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
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

  it('keeps the flat shell the clearance over the highest ground (tides-7oi)', () => {
    expect(CLOUD_FLAT_ALTITUDE - TERRAIN_MAX_GREY_FLAT * TERRAIN_DISPLACEMENT).toBeGreaterThanOrEqual(CLOUD_CLEARANCE)
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
    expect(low[0]).toBeGreaterThan(0.9)
    expect(low[0]).toBeLessThanOrEqual(1)
    expect(low[1]).toBeLessThan(low[0])
    expect(low[2]).toBeLessThan(low[1])
    const horizon = sunlightTint(0, 2)
    expect(horizon[2]).toBeLessThan(low[2])
  })

  it('reddens less for higher cloud', () => {
    expect(sunlightTint(0.05, 12)[2]).toBeGreaterThan(sunlightTint(0.05, 1)[2])
  })

  it('dims the terminator rather than lifting it to full brightness', () => {
    // Sun on the horizon of a 2 km top: warm and well under noon's white.
    const horizon = sunlightTint(0, 2)
    expect(horizon[0]).toBeLessThan(0.5)
    expect(horizon[1]).toBeLessThan(0.25 * horizon[0])
    // Past it, the beam grazes the ground and fades fast.
    const past = sunlightTint(-0.03, 10)
    expect(past[0]).toBeLessThan(0.75 * sunlightTint(0, 10)[0])
    expect(sunlightTint(-0.05, 10)[0]).toBeLessThan(0.2)
  })

  it('crosses the horizon without a jump', () => {
    for (const km of [0.5, 2, 12]) {
      expect(sunbeamTangentKm(1e-9, km)).toBeCloseTo(km, 6)
      expect(sunbeamTangentKm(-1e-9, km)).toBeCloseTo(km, 6)
      expect(sunbeamAirMass(-1e-9, km)).toBeCloseTo(sunbeamAirMass(1e-9, km), 3)
      expect(sunbeamAirMass(-0.02, km)).toBeGreaterThan(sunbeamAirMass(0, km))
    }
  })

  it('lights only tall tops past the terminator, in a thin band', () => {
    // A 10 km beam that must clear 2 km of haze: ~2.9° past the horizon.
    expect(Math.asin(sunsetDipSin(10)) / DEG).toBeCloseTo(2.9, 1)
    expect(sunsetDipSin(1.5)).toBe(0)
    expect(sunVisibility(0.05, 1)).toBe(1)
    expect(sunVisibility(-0.02, 2)).toBe(0)
    expect(sunVisibility(-0.03, 12)).toBe(1)
    expect(sunVisibility(-0.07, 12)).toBe(0)
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

describe('cloud detail octaves', () => {
  // The static map's texel on Earth's 2.95-unit sphere.
  const texel = (2 * Math.PI * 2.951) / 2048

  it('adds none until the map is magnified past 1.5 px a texel', () => {
    expect(detailOctaveWeights(texel * 10, texel, DETAIL_OCTAVES)).toEqual([])
    expect(detailOctaveWeights(texel / 1.4, texel, DETAIL_OCTAVES)).toEqual([])
    expect(detailOctaveWeights(texel / 2, texel, DETAIL_OCTAVES).length).toBeGreaterThan(0)
  })

  it('fills down to a few pixels at the ship stop, capped on the flat shell', () => {
    // The stop on a retina screen: ~53 px a cloud texel (tides-p0p).
    const footprint = texel / 53
    const relief = detailOctaveWeights(footprint, texel, DETAIL_OCTAVES)
    expect(relief).toHaveLength(DETAIL_OCTAVES)
    expect(relief[0]).toBe(1)
    expect(detailOctaveWeights(footprint, texel, DETAIL_OCTAVES_FLAT)).toHaveLength(
      DETAIL_OCTAVES_FLAT
    )
  })

  it('never draws a wave under three pixels', () => {
    for (const pixels of [3, 2, 1, 0.5]) expect(detailOctaveWeight(1, pixels)).toBe(0)
    expect(detailOctaveWeight(1, 6)).toBe(1)
  })

  it('turns with the drift, so the noise moves with the painted clouds', () => {
    for (const turns of [0, 0.13, 0.5, 0.97]) {
      for (const dir of [[1, 0, 0], [0.3, 0.8, -0.52], [-0.6, -0.7, 0.39]] as Vec3[]) {
        const n = Math.hypot(...dir)
        const unit = dir.map((v) => v / n) as Vec3
        const [u, v] = directionToUv(unit)
        const [uf, vf] = directionToUv(cloudFrame(unit, turns))
        const du = uf - (u - turns)
        expect(du - Math.round(du)).toBeCloseTo(0, 9)
        expect(vf).toBeCloseTo(v, 9)
        // And back.
        cloudFrame(cloudFrame(unit, turns), -turns).forEach((c, i) => expect(c).toBeCloseTo(unit[i], 9))
      }
    }
  })
})

// earth-dem-max.bin as grey, the cloud ceiling's source.
const demMax = demLevel(await decodeEarthDem(readFileSync(new URL('./assets/earth-dem-max.bin', import.meta.url))))

describe('cloud ceiling', () => {
  // ship/terrain-floor.ts TERRAIN_MAP_SIZE.
  const W = 512
  const H = 256
  const pooled = demMax.data
  const ceiling = cloudCeiling(pooled, W, H)
  const atUv = (grid: Uint8Array, w: number, h: number, [u, v]: [number, number]) =>
    grid[Math.min(h - 1, Math.floor((1 - v) * h)) * w + Math.min(w - 1, Math.floor(u * w))]
  // The march's ground read at uv (cloudShaders.ts cloudTerrain()), at its
  // worst, in grey levels: bilinear on the TERRAIN_READ_TEXELS-wide mip,
  // each of whose texels is at most the max of the pooled texels it covers.
  const k = W / TERRAIN_READ_TEXELS
  const mipTexel = (i: number, j: number) => {
    let max = 0
    for (let y = j * k; y < (j + 1) * k; y++) {
      for (let x = i * k; x < (i + 1) * k; x++) max = Math.max(max, pooled[y * W + x])
    }
    return max * 255
  }
  const groundRead = ([u, v]: [number, number]) => {
    const w = TERRAIN_READ_TEXELS
    const h = w / 2
    const x = u * w - 0.5
    const y = Math.min(Math.max((1 - v) * h - 0.5, 0), h - 1)
    const i0 = Math.floor(x)
    const j0 = Math.floor(y)
    let max = 0
    for (const i of [i0, i0 + 1]) {
      for (const j of [j0, Math.min(j0 + 1, h - 1)]) max = Math.max(max, mipTexel((i + w) % w, j))
    }
    return max
  }
  // A seeded generator, so a failure repeats.
  let seed = 1
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const randomUnit = (): Vec3 => {
    const z = 2 * random() - 1
    const a = 2 * Math.PI * random()
    const r = Math.sqrt(1 - z * z)
    return [r * Math.cos(a), z, r * Math.sin(a)]
  }

  it('stands over the ground the march reads anywhere within its arc', () => {
    for (let n = 0; n < 20000; n++) {
      // Every tenth near a pole, where the texels crowd.
      const p = n % 10 ? randomUnit() : unit([random() - 0.5, n % 20 ? 20 : -20, random() - 0.5])
      // A point up to the arc away, in a random direction.
      const t = unit(cross(p, randomUnit()))
      const a = random() * CEILING_ARC_DEG * DEG
      const x: Vec3 = [0, 1, 2].map((c) => p[c] * Math.cos(a) + t[c] * Math.sin(a)) as Vec3
      expect(atUv(ceiling, W, H, directionToUv(p))).toBeGreaterThanOrEqual(
        groundRead(directionToUv(x)) + CEILING_GREY_MARGIN
      )
    }
  })

  it('lies low over open ocean and over the highest ground at the top', () => {
    const at = (latDeg: number, lonDeg: number) =>
      atUv(ceiling, W, H, [(lonDeg + 180) / 360, 0.5 + latDeg / 180])
    expect(at(0, -150)).toBeLessThanOrEqual(CEILING_GREY_MARGIN + 4)
    expect(at(-45, -120)).toBeLessThanOrEqual(CEILING_GREY_MARGIN + 4)
    expect(at(28, 87)).toBeGreaterThanOrEqual(Math.round(TERRAIN_MAX_GREY * 255))
  })

  it('ships as built (scripts/build-cloud-ceiling.mjs)', () => {
    const shipped = new Uint8Array(
      readFileSync(new URL('./assets/earth-cloud-ceiling.bin', import.meta.url))
    )
    expect(shipped.length).toBe(W * H)
    // The first texel that differs, if any.
    expect(shipped.findIndex((grey, k) => grey !== ceiling[k])).toBe(-1)
  })

  it('reaches no further along a path above the sea than its arc', () => {
    const sea = 2.95
    const reach = ceilingReach(sea)
    for (let n = 0; n < 2000; n++) {
      const q = randomUnit().map((c) => c * sea * (1 + 0.1 * random())) as Vec3
      const d = randomUnit()
      const s = reach * random()
      const e: Vec3 = [q[0] + d[0] * s, q[1] + d[1] * s, q[2] + d[2] * s]
      // Only paths that stay above the sea (the march's skips do).
      const b = -(q[0] * d[0] + q[1] * d[1] + q[2] * d[2])
      const nearest = b > 0 && b < s ? q.map((c, i) => c + d[i] * b) : null
      if (Math.hypot(...e) < sea || (nearest && Math.hypot(...nearest) < sea)) continue
      const angle = Math.acos(
        Math.min(1, (q[0] * e[0] + q[1] * e[1] + q[2] * e[2]) / Math.hypot(...q) / Math.hypot(...e))
      )
      expect(angle).toBeLessThanOrEqual(CEILING_ARC_DEG * DEG + 1e-12)
    }
  })
})
