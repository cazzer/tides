import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { JupiterMoons, RotationAxis, Rotation_EQJ_ECT, RotateVector, Vector } from 'astronomy-engine'
import { PLANETS, PLANET_KEYS, planetPosition, sceneRadius } from '../planets'
import { moonPosition as earthMoonPosition, eclipticToScene } from '../ephemeris'
import { positionsFor } from '../flight-scale'
import {
  MOONS,
  MOON_KEYS,
  MOON_PARENTS,
  MOON_RADIUS_FLOOR,
  MOON_ORBIT_GAP,
  clampedSceneRadius,
  moonOffsetInto,
  moonOrbitPath,
  moonOrbitRadius,
  moonPosition,
  moonRadius,
  moonSystemExtent,
  moonTrueOffsetKm,
  moonsOf,
  type MoonKey,
  type MoonParent,
} from './moons'

const DAY = 86_400_000
const DATES = [Date.UTC(2026, 9, 22, 12), Date.UTC(1987, 2, 3), Date.UTC(2051, 6, 9, 18)]
const GALILEANS = ['io', 'europa', 'ganymede', 'callisto'] as const

const offset = (key: MoonKey, t: number) => moonOffsetInto(key, t, new THREE.Vector3())

// The IAU pole flipped to whichever way the planet actually spins, from
// RotationAxis alone (the sign of W's rate), independent of moons.ts.
function spinPole(parent: MoonParent, t: number): THREE.Vector3 {
  const body = PLANETS[parent].body
  const date = new Date(t)
  const { north, spin } = RotationAxis(body, date)
  const later = RotationAxis(body, new Date(t + 3_600_000)).spin
  const rate = ((later - spin + 540) % 360) - 180
  const pole = eclipticToScene(RotateVector(Rotation_EQJ_ECT(date), north), new THREE.Vector3())
  return pole.multiplyScalar(Math.sign(rate))
}

// The orbit's angular momentum direction from two nearby offsets.
function orbitNormal(key: MoonKey, t: number): THREE.Vector3 {
  const dt = (MOONS[key].periodDays * DAY) / 200
  return offset(key, t).cross(offset(key, t + dt)).normalize()
}

describe('moon table', () => {
  it('has the 19 major moons, grouped by parent outward, each ordered by distance', () => {
    expect(MOON_KEYS).toHaveLength(19)
    expect(MOON_KEYS).not.toContain('charon')
    expect(MOON_PARENTS.flatMap((parent) => moonsOf(parent))).toEqual([...MOON_KEYS])
    for (const parent of MOON_PARENTS) {
      const a = moonsOf(parent).map((key) => MOONS[key].aKm)
      expect(a).toEqual([...a].sort((x, y) => x - y))
    }
    expect(moonsOf('neptune')).toEqual(['triton'])
    for (const key of MOON_KEYS) expect(MOONS[key].key).toBe(key)
  })
})

describe('moon radius', () => {
  it('is positive and in size order, never below the floor', () => {
    const bySize = [...MOON_KEYS].sort((a, b) => MOONS[a].radiusKm - MOONS[b].radiusKm)
    for (let i = 0; i < bySize.length; i++) {
      expect(moonRadius(bySize[i])).toBeGreaterThanOrEqual(MOON_RADIUS_FLOOR)
      if (i > 0) expect(moonRadius(bySize[i])).toBeGreaterThan(moonRadius(bySize[i - 1]))
    }
    // sceneRadius alone would be ≤ 0 for Phobos.
    expect(sceneRadius(22_160)).toBeLessThan(0)
    expect(moonRadius('phobos')).toBeCloseTo(0.236, 3)
  })

  it('keeps the shared log scale for the large moons, and meets it continuously', () => {
    for (const key of ['io', 'europa', 'ganymede', 'callisto', 'titan', 'triton'] as const) {
      expect(moonRadius(key)).toBe(sceneRadius(2 * MOONS[key].radiusKm * 1000))
    }
    expect(clampedSceneRadius(2662 - 1e-6)).toBeCloseTo(clampedSceneRadius(2662 + 1e-6), 6)
    for (let d = 10; d < 6000; d *= 1.05) {
      expect(clampedSceneRadius(d * 1.05)).toBeGreaterThan(clampedSceneRadius(d))
    }
  })
})

describe('orbit radius (log map)', () => {
  it('keeps order, clears the planet and its rings, and keeps neighbours apart', () => {
    for (const parent of MOON_PARENTS) {
      const planet = PLANETS[parent]
      const keys = moonsOf(parent)
      const clear = planet.radius * (planet.rings?.outer ?? 1)
      expect(moonOrbitRadius(keys[0]) - moonRadius(keys[0])).toBeCloseTo(
        clear + MOON_ORBIT_GAP[parent],
        9
      )
      for (let i = 1; i < keys.length; i++) {
        const gap =
          moonOrbitRadius(keys[i]) -
          moonOrbitRadius(keys[i - 1]) -
          moonRadius(keys[i]) -
          moonRadius(keys[i - 1])
        expect(gap).toBeGreaterThan(0.2)
      }
      const last = keys[keys.length - 1]
      expect(moonSystemExtent(parent)).toBe(moonOrbitRadius(last) + moonRadius(last))
    }
    // Saturn's innermost moon clears the A ring's outer edge (2.27 R).
    expect(moonOrbitRadius('mimas') - moonRadius('mimas')).toBeGreaterThan(
      PLANETS.saturn.radius * 2.27
    )
  })

  it('puts every moon at its orbit radius from the parent', () => {
    for (const t of DATES) {
      for (const key of MOON_KEYS) {
        expect(offset(key, t).length()).toBeCloseTo(moonOrbitRadius(key), 9)
      }
    }
  })
})

describe('Galilean moons', () => {
  it.each(DATES)('point where JupiterMoons puts them (%i)', (t) => {
    const date = new Date(t)
    const rot = Rotation_EQJ_ECT(date)
    const jm = JupiterMoons(date)
    for (const key of GALILEANS) {
      const { x, y, z, t: time } = jm[key]
      const truth = eclipticToScene(RotateVector(rot, new Vector(x, y, z, time)), new THREE.Vector3())
      expect(offset(key, t).angleTo(truth)).toBeLessThan(1e-6)
      // True km offset: JupiterMoons' AU in km along the same axes.
      const km = moonTrueOffsetKm(key, t, new THREE.Vector3())
      expect(km.angleTo(truth)).toBeLessThan(1e-6)
      expect(km.length() / MOONS[key].aKm).toBeGreaterThan(0.98)
      expect(km.length() / MOONS[key].aKm).toBeLessThan(1.02)
    }
  })

  it('keeps their order outward', () => {
    const r = GALILEANS.map(moonOrbitRadius)
    expect(r).toEqual([...r].sort((a, b) => a - b))
  })
})

describe('orbit sense and plane', () => {
  it.each(DATES)('orbits the way the parent spins, Uranus included; Triton against (%i)', (t) => {
    for (const key of MOON_KEYS) {
      const { parent, retrograde } = MOONS[key]
      const along = orbitNormal(key, t).dot(spinPole(parent, t))
      if (retrograde) expect(along).toBeLessThan(0)
      // cos 15.47°: Iapetus is the most inclined.
      else expect(along).toBeGreaterThan(0.96)
    }
    expect(MOONS.triton.retrograde).toBe(true)
    // Uranus' moons go clockwise about its IAU north pole.
    const iauUranus = eclipticToScene(
      RotateVector(Rotation_EQJ_ECT(new Date(t)), RotationAxis(PLANETS.uranus.body, new Date(t)).north),
      new THREE.Vector3()
    )
    expect(orbitNormal('titania', t).dot(iauUranus)).toBeLessThan(-0.99)
  })

  it('inclines Iapetus 15.47° and Triton 156.885° to their parent’s equator', () => {
    const t = DATES[0]
    const deg = (key: MoonKey) =>
      THREE.MathUtils.radToDeg(orbitNormal(key, t).angleTo(spinPole(MOONS[key].parent, t)))
    expect(deg('iapetus')).toBeCloseTo(15.47, 1)
    expect(deg('triton')).toBeCloseTo(156.885, 1)
    expect(deg('titan')).toBeLessThan(0.5)
  })

  it('tilts Iapetus’s orbit ~17.3° to the ecliptic, as the real one is', () => {
    for (const t of DATES) {
      const deg = THREE.MathUtils.radToDeg(orbitNormal('iapetus', t).angleTo(new THREE.Vector3(0, 1, 0)))
      expect(deg).toBeGreaterThan(16.5)
      expect(deg).toBeLessThan(18.5)
    }
  })

  // The equator's node on the ecliptic (e1 = Y × pole, normalised) is only
  // well defined while no parent's pole is near the ecliptic's.
  it('has every mean-orbit parent’s pole well off the ecliptic pole', () => {
    for (const parent of ['mars', 'saturn', 'uranus', 'neptune'] as const) {
      for (const t of DATES) {
        const cross = new THREE.Vector3(0, 1, 0).cross(spinPole(parent, t)).length()
        expect(cross, parent).toBeGreaterThan(0.3)
      }
    }
  })

  it('comes back to the same place after one period', () => {
    const t = DATES[0]
    for (const key of MOON_KEYS) {
      if ((GALILEANS as readonly string[]).includes(key)) continue
      const later = offset(key, t + MOONS[key].periodDays * DAY)
      expect(later.distanceTo(offset(key, t)) / moonOrbitRadius(key)).toBeLessThan(1e-3)
    }
  })

  it('moves at sim speed: a quarter period turns a moon ~90°', () => {
    const t = DATES[0]
    for (const key of ['phobos', 'titan', 'oberon', 'triton'] as const) {
      const turn = offset(key, t).angleTo(offset(key, t + (MOONS[key].periodDays * DAY) / 4))
      expect(THREE.MathUtils.radToDeg(turn)).toBeCloseTo(90, 0)
    }
  })
})

describe('positions and orbit paths', () => {
  it.each(['system', 'flight'] as const)('sits at the %s parent position plus the offset', (scale) => {
    const t = DATES[0]
    for (const key of MOON_KEYS) {
      const parent = positionsFor(scale).positionAt[MOONS[key].parent](t)
      const expected = new THREE.Vector3(...parent).add(offset(key, t))
      const actual = new THREE.Vector3(...moonPosition(key, t, scale))
      expect(actual.distanceTo(expected)).toBeLessThan(1e-9)
    }
  })

  it('draws an orbit loop through the moon, at its radius, the way it moves', () => {
    for (const t of DATES) {
      for (const key of MOON_KEYS) {
        const path = moonOrbitPath(key, t, 64)
        expect(path).toHaveLength(192)
        const live = offset(key, t)
        const first = new THREE.Vector3().fromArray(path, 0)
        expect(first.distanceTo(live)).toBeLessThan(1e-5)
        for (let k = 0; k < 64; k++) {
          expect(new THREE.Vector3().fromArray(path, k * 3).length()).toBeCloseTo(
            moonOrbitRadius(key),
            4
          )
        }
        // The second point is where the moon heads next.
        const second = new THREE.Vector3().fromArray(path, 3)
        const soon = offset(key, t + (MOONS[key].periodDays * DAY) / 64)
        expect(second.distanceTo(soon) / moonOrbitRadius(key)).toBeLessThan(0.02)
      }
    }
  })

  it('writes into `out` when given', () => {
    const out = new Float32Array(32 * 3)
    expect(moonOrbitPath('titan', DATES[0], 32, out)).toBe(out)
  })

  it('gives non-Galilean true offsets at the true semi-major axis', () => {
    const v = new THREE.Vector3()
    for (const key of ['phobos', 'titan', 'oberon', 'triton'] as const) {
      moonTrueOffsetKm(key, DATES[0], v)
      expect(v.length()).toBeCloseTo(MOONS[key].aKm, 3)
      expect(v.angleTo(offset(key, DATES[0]))).toBeLessThan(1e-9)
    }
  })
})

describe('system view clearance, 1900–2100', () => {
  const START = Date.UTC(1900, 0, 1)
  const END = Date.UTC(2100, 0, 1)
  const STEP = 23 * DAY
  const times: number[] = []
  for (let t = START; t <= END; t += STEP) times.push(t)

  // Radial band [min, max] from the Sun of each planet's sphere (ring edge
  // for Saturn and Uranus), and of each moon system's spheres.
  const planetBand: Record<string, [number, number]> = {}
  const systemBand: Record<string, [number, number]> = {}
  const centres: Record<MoonParent, THREE.Vector3[]> = {
    mars: [],
    jupiter: [],
    saturn: [],
    uranus: [],
    neptune: [],
  }
  const widen = (bands: Record<string, [number, number]>, key: string, lo: number, hi: number) => {
    const band = (bands[key] ??= [Infinity, -Infinity])
    band[0] = Math.min(band[0], lo)
    band[1] = Math.max(band[1], hi)
  }
  for (const t of times) {
    for (const key of PLANET_KEYS) {
      const { body, radius, rings } = PLANETS[key]
      const r = Math.hypot(...planetPosition(body)(t))
      const reach = radius * (rings?.outer ?? 1)
      widen(planetBand, key, r - reach, r + reach)
    }
    const moonR = Math.hypot(...earthMoonPosition(t))
    // Earth stays at 50; its Moon (radius 1) swings around it.
    widen(planetBand, 'earth-moon', Math.min(50 - 2.95, moonR - 1), Math.max(50 + 2.95, moonR + 1))
    for (const parent of MOON_PARENTS) {
      centres[parent].push(new THREE.Vector3(...positionsFor('system').positionAt[parent](t)))
      for (const key of moonsOf(parent)) {
        const r = Math.hypot(...moonPosition(key, t, 'system'))
        widen(systemBand, parent, r - moonRadius(key), r + moonRadius(key))
      }
    }
  }

  it('keeps every moon system 2+ units clear of every other planet’s band and the Earth–Moon band', () => {
    for (const parent of MOON_PARENTS) {
      const [lo, hi] = systemBand[parent]
      for (const [other, [olo, ohi]] of Object.entries(planetBand)) {
        if (other === parent) continue
        const clearance = Math.max(olo - hi, lo - ohi)
        expect(clearance, `${parent} system vs ${other}`).toBeGreaterThan(2)
      }
    }
  })

  it('keeps Mars’ system off the Earth–Moon band and Uranus’ off Neptune’s system', () => {
    expect(systemBand.mars[0]).toBeGreaterThan(planetBand['earth-moon'][1])
    expect(systemBand.uranus[1]).toBeLessThan(systemBand.neptune[0])
  })

  // The documented exception (moons.ts header): at a great conjunction the
  // outermost circles of neighbouring systems can touch.
  it.each([
    ['jupiter', 'saturn'],
    ['saturn', 'uranus'],
  ] as const)('lets the %s and %s systems touch under 3%% of the time', (a, b) => {
    const reach = moonSystemExtent(a) + moonSystemExtent(b)
    let touching = 0
    for (let i = 0; i < times.length; i++) {
      if (centres[a][i].distanceTo(centres[b][i]) < reach) touching++
    }
    expect(touching / times.length).toBeLessThan(0.03)
  })
})
