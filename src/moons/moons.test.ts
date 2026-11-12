import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { JupiterMoons, RotationAxis, Rotation_EQJ_ECT, RotateVector, Vector } from 'astronomy-engine'
import { PLANETS, PLANET_KEYS, planetPosition, sceneRadius } from '../planets'
import { moonPosition as earthMoonPosition, eclipticToScene } from '../ephemeris'
import { flightRadii, positionsFor } from '../flight-scale'
import type { DistanceScale } from '../distance-scale'
import { DEFAULT_TRUESCALE, MAX_TRUESCALE, towardTrue } from '../truescale'
import { EARTH_KM_PER_UNIT } from '../surface-handover'
import {
  MOONS,
  MOON_KEYS,
  MOON_PARENTS,
  MOON_RADIUS_FLOOR,
  MOON_RADIUS_MIN,
  MOON_ORBIT_GAP,
  MOON_SIZE_TRUENESS,
  SYSTEM_EXPANSION_MAX,
  clampedSceneRadius,
  expansionForExtent,
  compactMoonRadiiAt,
  moonOffsetInto,
  moonOrbitPath,
  moonOrientationInto,
  moonOrbitRadius,
  moonOrbitRadiiAt,
  moonPosition,
  moonRadiiAt,
  moonRadius,
  moonSystemExtent,
  moonTrueOffsetKm,
  moonExpansion,
  moonsOf,
  setMoonExpansion,
  type MoonKey,
  type MoonParent,
} from './moons'

const DAY = 86_400_000
const DATES = [Date.UTC(2026, 9, 22, 12), Date.UTC(1987, 2, 3), Date.UTC(2051, 6, 9, 18)]
const GALILEANS = ['io', 'europa', 'ganymede', 'callisto'] as const

const offset = (key: MoonKey, t: number, scale: DistanceScale = 'system') =>
  moonOffsetInto(key, t, new THREE.Vector3(), scale)

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

// The parent's mean radius, km.
const parentKm = (parent: MoonParent) => PLANETS[parent].diameter / 2000
const SCALES = [0, 0.5, DEFAULT_TRUESCALE, MAX_TRUESCALE]

// Per view: the drawn radii, the compact ones they start from, and the
// parents' radii they are true against.
const VIEWS: readonly {
  name: string
  radius: Readonly<Record<MoonKey, number>>
  compact: Readonly<Record<MoonKey, number>>
  planet: (parent: MoonParent) => number
}[] = [
  {
    name: 'system',
    radius: Object.fromEntries(MOON_KEYS.map((key) => [key, moonRadius(key, 'system')])) as Record<MoonKey, number>,
    compact: Object.fromEntries(
      MOON_KEYS.map((key) => [key, clampedSceneRadius(2 * MOONS[key].radiusKm)])
    ) as Record<MoonKey, number>,
    planet: (parent) => PLANETS[parent].radius,
  },
  ...SCALES.map((a) => ({
    name: `flight at a = ${a}`,
    radius: moonRadiiAt(a),
    compact: compactMoonRadiiAt(a),
    planet: (parent: MoonParent) => flightRadii(a)[parent],
  })),
]

// A moon's true radius beside its parent drawn at planet(parent).
const trueRadius = (key: MoonKey, planet: (parent: MoonParent) => number) =>
  (MOONS[key].radiusKm / parentKm(MOONS[key].parent)) * planet(MOONS[key].parent)

describe('compact moon radius', () => {
  it('is positive and in size order, never below the floor', () => {
    const bySize = [...MOON_KEYS].sort((a, b) => MOONS[a].radiusKm - MOONS[b].radiusKm)
    const compact = compactMoonRadiiAt(0)
    for (let i = 0; i < bySize.length; i++) {
      expect(compact[bySize[i]]).toBeGreaterThanOrEqual(MOON_RADIUS_FLOOR)
      if (i > 0) expect(compact[bySize[i]]).toBeGreaterThan(compact[bySize[i - 1]])
    }
    // sceneRadius alone would be ≤ 0 for Phobos.
    expect(sceneRadius(22_160)).toBeLessThan(0)
    expect(compact.phobos).toBeCloseTo(0.236, 3)
  })

  it('keeps the shared log scale for the large moons, and meets it continuously', () => {
    for (const key of ['io', 'europa', 'ganymede', 'callisto', 'titan', 'triton'] as const) {
      expect(compactMoonRadiiAt(0)[key]).toBe(sceneRadius(2 * MOONS[key].radiusKm * 1000))
    }
    expect(clampedSceneRadius(2662 - 1e-6)).toBeCloseTo(clampedSceneRadius(2662 + 1e-6), 6)
    for (let d = 10; d < 6000; d *= 1.05) {
      expect(clampedSceneRadius(d * 1.05)).toBeGreaterThan(clampedSceneRadius(d))
    }
  })
})

describe('moon radius (tides-ufyr.6.2)', () => {
  it.each(VIEWS.map((view) => [view.name, view] as const))(
    'is MOON_SIZE_TRUENESS of the way from compact toward true, floored (%s)',
    (_, { radius, compact, planet }) => {
      for (const key of MOON_KEYS) {
        expect(radius[key], key).toBe(
          Math.max(MOON_RADIUS_MIN, towardTrue(compact[key], trueRadius(key, planet), MOON_SIZE_TRUENESS))
        )
      }
    }
  )

  it.each(VIEWS.map((view) => [view.name, view] as const))(
    'is never under MOON_RADIUS_MIN and keeps size order within each parent (%s)',
    (_, { radius }) => {
      for (const parent of MOON_PARENTS) {
        const bySize = [...moonsOf(parent)].sort((a, b) => MOONS[a].radiusKm - MOONS[b].radiusKm)
        for (let i = 0; i < bySize.length; i++) {
          expect(radius[bySize[i]], bySize[i]).toBeGreaterThanOrEqual(MOON_RADIUS_MIN)
          if (i === 0) continue
          // Strictly larger, unless both sit on the floor (Phobos and Deimos).
          if (radius[bySize[i]] > MOON_RADIUS_MIN) {
            expect(radius[bySize[i]], bySize[i]).toBeGreaterThan(radius[bySize[i - 1]])
          } else {
            expect(radius[bySize[i - 1]], bySize[i - 1]).toBe(MOON_RADIUS_MIN)
          }
        }
      }
    }
  )

  it.each(VIEWS.map((view) => [view.name, view] as const))(
    'is strictly closer to true beside its planet than the compact radius, in log space (%s)',
    (_, { radius, compact, planet }) => {
      for (const key of MOON_KEYS) {
        const truth = trueRadius(key, planet)
        expect(Math.abs(Math.log(radius[key] / truth)), key).toBeLessThan(
          Math.abs(Math.log(compact[key] / truth))
        )
      }
    }
  )

  it('draws Io ~1/18 of Jupiter’s radius in the system view (true 1/38), against 1/6 compact', () => {
    const [system] = VIEWS
    expect(system.compact.io / PLANETS.jupiter.radius).toBeCloseTo(0.164, 3)
    expect(system.radius.io / PLANETS.jupiter.radius).toBeLessThan(0.06)
    expect(system.radius.phobos).toBe(MOON_RADIUS_MIN)
    expect(system.radius.mimas).toBeLessThan(0.07)
  })
})

// The compact log map's orbit radii from before tides-ufyr.6.2: the system
// view keeps them bit for bit (its 1900–2100 clearance below holds on them).
const SYSTEM_ORBIT_RADII: Readonly<Record<MoonKey, number>> = {
  phobos: 2.840028045442723,
  deimos: 4.840028045442724,
  io: 8.6193607395064,
  europa: 11.724120034789891,
  ganymede: 14.845277490387602,
  callisto: 18.619360739506398,
  mimas: 15.595913631975884,
  enceladus: 16.859013938853597,
  tethys: 17.94362489828941,
  dione: 19.20075957877306,
  rhea: 20.89704950321743,
  titan: 25.1654757389664,
  iapetus: 30.595913631975883,
  miranda: 11.424746359344814,
  ariel: 13.976110826995372,
  umbriel: 16.209258654173464,
  titania: 19.494471027203858,
  oberon: 21.424746359344816,
  triton: 6.606150319354498,
}

describe('orbit radius (log map)', () => {
  it('is the compact log map exactly as before', () => {
    for (const key of MOON_KEYS) expect(moonOrbitRadius(key, 'system'), key).toBe(SYSTEM_ORBIT_RADII[key])
  })

  it('keeps order, clears the planet and its rings, and keeps neighbours apart', () => {
    for (const parent of MOON_PARENTS) {
      const planet = PLANETS[parent]
      const keys = moonsOf(parent)
      const clear = planet.radius * (planet.rings?.outer ?? 1)
      // The map's floor is set by the compact radius; the drawn moon is smaller.
      expect(moonOrbitRadius(keys[0], 'system') - compactMoonRadiiAt(0)[keys[0]]).toBeCloseTo(
        clear + MOON_ORBIT_GAP[parent],
        9
      )
      expect(moonOrbitRadius(keys[0], 'system') - moonRadius(keys[0], 'system')).toBeGreaterThan(
        clear + MOON_ORBIT_GAP[parent]
      )
      for (let i = 1; i < keys.length; i++) {
        const gap =
          moonOrbitRadius(keys[i], 'system') -
          moonOrbitRadius(keys[i - 1], 'system') -
          moonRadius(keys[i], 'system') -
          moonRadius(keys[i - 1], 'system')
        expect(gap).toBeGreaterThan(0.2)
      }
      const last = keys[keys.length - 1]
      expect(moonSystemExtent(parent, 'system')).toBe(
        moonOrbitRadius(last, 'system') + moonRadius(last, 'system')
      )
    }
    // Saturn's innermost moon clears the A ring's outer edge (2.27 R).
    expect(moonOrbitRadius('mimas', 'system') - moonRadius('mimas', 'system')).toBeGreaterThan(
      PLANETS.saturn.radius * 2.27
    )
  })

  it('puts every moon at its orbit radius from the parent', () => {
    for (const t of DATES) {
      for (const key of MOON_KEYS) {
        expect(offset(key, t).length()).toBeCloseTo(moonOrbitRadius(key, 'system'), 9)
      }
    }
  })
})

describe('system expansion (tides-ufyr.6.3)', () => {
  afterEach(() => {
    for (const parent of MOON_PARENTS) setMoonExpansion(parent, 0)
  })
  const STEPS = [0, 0.25, 0.5, 0.75, 1].map((share) => share * SYSTEM_EXPANSION_MAX)
  const radiusOf = (key: MoonKey) => (MOONS[key].aKm / parentKm(MOONS[key].parent)) * PLANETS[MOONS[key].parent].radius

  it('starts at, and comes back to, the compact map bit for bit', () => {
    for (const parent of MOON_PARENTS) expect(moonExpansion(parent)).toBe(0)
    setMoonExpansion('saturn', 0.37)
    setMoonExpansion('saturn', 0)
    for (const key of MOON_KEYS) expect(moonOrbitRadius(key, 'system'), key).toBe(SYSTEM_ORBIT_RADII[key])
  })

  it('moves each orbit that share of the way toward true spacing in log space', () => {
    for (const parent of MOON_PARENTS) setMoonExpansion(parent, SYSTEM_EXPANSION_MAX)
    for (const key of MOON_KEYS) {
      expect(moonOrbitRadius(key, 'system'), key).toBeCloseTo(
        towardTrue(SYSTEM_ORBIT_RADII[key], radiusOf(key), SYSTEM_EXPANSION_MAX),
        9
      )
    }
    const inRadii = (key: MoonKey) => moonOrbitRadius(key, 'system') / PLANETS[MOONS[key].parent].radius
    expect(inRadii('io')).toBeCloseTo(3.3, 1)
    expect(inRadii('callisto')).toBeCloseTo(11, 0)
    expect(inRadii('titan')).toBeCloseTo(10.8, 1)
    expect(inRadii('iapetus')).toBeCloseTo(22, 0)
    expect(inRadii('triton')).toBeCloseTo(5.55, 1)
  })

  it.each(STEPS)('keeps order, clearance and gaps at e = %s', (e) => {
    for (const parent of MOON_PARENTS) {
      setMoonExpansion(parent, e)
      const planet = PLANETS[parent]
      const keys = moonsOf(parent)
      expect(moonOrbitRadius(keys[0], 'system') - moonRadius(keys[0], 'system')).toBeGreaterThan(
        planet.radius * (planet.rings?.outer ?? 1) + MOON_ORBIT_GAP[parent]
      )
      for (let i = 1; i < keys.length; i++) {
        const gap =
          moonOrbitRadius(keys[i], 'system') -
          moonOrbitRadius(keys[i - 1], 'system') -
          moonRadius(keys[i], 'system') -
          moonRadius(keys[i - 1], 'system')
        expect(gap, `${keys[i - 1]}–${keys[i]}`).toBeGreaterThan(0.2)
      }
      // The outermost moon is the system's extent (expansionForExtent's closed form).
      const last = keys[keys.length - 1]
      const extent = Math.max(...keys.map((key) => moonOrbitRadius(key, 'system') + moonRadius(key, 'system')))
      expect(moonSystemExtent(parent, 'system')).toBe(extent)
      expect(extent).toBe(moonOrbitRadius(last, 'system') + moonRadius(last, 'system'))
      for (const t of DATES) {
        for (const key of keys) expect(offset(key, t).length()).toBeCloseTo(moonOrbitRadius(key, 'system'), 9)
      }
    }
  })

  it('grows every system’s extent with e, and expansionForExtent inverts it', () => {
    for (const parent of MOON_PARENTS) {
      let previous = -Infinity
      for (const e of STEPS) {
        setMoonExpansion(parent, e)
        const extent = moonSystemExtent(parent, 'system')
        expect(extent, `${parent} at ${e}`).toBeGreaterThan(previous)
        expect(expansionForExtent(parent, extent), `${parent} at ${e}`).toBeCloseTo(e, 9)
        previous = extent
      }
      expect(expansionForExtent(parent, previous * 2)).toBe(SYSTEM_EXPANSION_MAX)
      setMoonExpansion(parent, 0)
      expect(expansionForExtent(parent, moonSystemExtent(parent, 'system') - 0.01)).toBe(0)
    }
  })

  it('leaves the flight scale alone', () => {
    const flight = MOON_KEYS.map((key) => moonOrbitRadius(key, 'flight'))
    const flightExtent = MOON_PARENTS.map((parent) => moonSystemExtent(parent, 'flight'))
    for (const parent of MOON_PARENTS) setMoonExpansion(parent, SYSTEM_EXPANSION_MAX)
    expect(MOON_KEYS.map((key) => moonOrbitRadius(key, 'flight'))).toEqual(flight)
    expect(MOON_PARENTS.map((parent) => moonSystemExtent(parent, 'flight'))).toEqual(flightExtent)
  })

  it('does nothing, and says so, for an unchanged expansion', () => {
    expect(setMoonExpansion('jupiter', 0)).toBe(false)
    expect(setMoonExpansion('jupiter', 0.3)).toBe(true)
    const radii = moonsOf('jupiter').map((key) => moonOrbitRadius(key, 'system'))
    expect(setMoonExpansion('jupiter', 0.3)).toBe(false)
    expect(moonsOf('jupiter').map((key) => moonOrbitRadius(key, 'system'))).toEqual(radii)
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
    const r = GALILEANS.map((key) => moonOrbitRadius(key, 'system'))
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
      expect(later.distanceTo(offset(key, t)) / moonOrbitRadius(key, 'system')).toBeLessThan(1e-3)
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

describe('flight sizes (tides-o39, tides-ufyr.6.2)', () => {
  it('are their own table: the system radii at a = 0, but at true spacing', () => {
    for (const key of MOON_KEYS) {
      expect(moonRadiiAt(0)[key]).toBe(moonRadius(key, 'system'))
      expect(moonRadius(key, 'flight')).toBe(moonRadius(key, 'system'))
      expect(moonOrbitRadius(key, 'flight')).toBe(moonOrbitRadiiAt(0)[key])
      expect(moonOrbitRadius(key, 'flight')).toBeGreaterThan(moonOrbitRadius(key, 'system'))
    }
    for (const parent of MOON_PARENTS) {
      expect(moonSystemExtent(parent, 'flight')).toBe(
        Math.max(...moonsOf(parent).map((key) => moonOrbitRadius(key, 'flight') + moonRadius(key, 'flight')))
      )
    }
  })

  it.each(SCALES)('puts every moon at its true spacing in planet radii at a = %f', (a) => {
    const orbit = moonOrbitRadiiAt(a)
    const planetRadius = flightRadii(a)
    for (const key of MOON_KEYS) {
      const { parent, aKm } = MOONS[key]
      expect(orbit[key] / planetRadius[parent], key).toBeCloseTo(aKm / parentKm(parent), 12)
    }
    expect(orbit.callisto / planetRadius.jupiter).toBeCloseTo(26.9, 1)
    expect(orbit.iapetus / planetRadius.saturn).toBeCloseTo(61, 0)
    expect(orbit.triton / planetRadius.neptune).toBeCloseTo(14.4, 1)
  })

  it('puts Callisto ~540 and Iapetus ~1065 units out at the default truescale', () => {
    const orbit = moonOrbitRadiiAt(DEFAULT_TRUESCALE)
    expect(orbit.callisto).toBeGreaterThan(530)
    expect(orbit.callisto).toBeLessThan(550)
    expect(orbit.iapetus).toBeGreaterThan(1050)
    expect(orbit.iapetus).toBeLessThan(1080)
  })

  it.each([0.5, MAX_TRUESCALE])('slides the compact radii toward true, floored, at a = %f', (a) => {
    const radius = compactMoonRadiiAt(a)
    for (const key of MOON_KEYS) {
      const scene = compactMoonRadiiAt(0)[key]
      const truth = MOONS[key].radiusKm / EARTH_KM_PER_UNIT
      expect(radius[key]).toBeGreaterThanOrEqual(MOON_RADIUS_FLOOR)
      // Between the compact radius and the true one (or the floor).
      expect(radius[key]).toBeLessThanOrEqual(Math.max(scene, truth) + 1e-12)
      expect(radius[key]).toBeGreaterThanOrEqual(Math.min(scene, Math.max(truth, MOON_RADIUS_FLOOR)) - 1e-12)
    }
    // Ganymede is the largest: true ~1.22 units against a compact 1.63.
    expect(radius.ganymede).toBeLessThan(compactMoonRadiiAt(0).ganymede)
    expect(radius.phobos).toBe(MOON_RADIUS_FLOOR)
  })

  it.each(SCALES)(
    'keeps each system clear of its grown planet and rings, its moons apart, at a = %f',
    (a) => {
      const radius = moonRadiiAt(a)
      const orbit = moonOrbitRadiiAt(a)
      const planetRadius = flightRadii(a)
      for (const parent of MOON_PARENTS) {
        const keys = moonsOf(parent)
        const clear = planetRadius[parent] * (PLANETS[parent].rings?.outer ?? 1)
        expect(orbit[keys[0]] - radius[keys[0]], parent).toBeGreaterThan(clear + 0.2)
        for (let i = 1; i < keys.length; i++) {
          const gap = orbit[keys[i]] - orbit[keys[i - 1]] - radius[keys[i]] - radius[keys[i - 1]]
          expect(gap, keys[i]).toBeGreaterThan(0.2)
        }
      }
    }
  )
})

describe('positions and orbit paths', () => {
  it.each(['system', 'flight'] as const)('sits at the %s parent position plus the offset', (scale) => {
    const t = DATES[0]
    for (const key of MOON_KEYS) {
      const parent = positionsFor(scale).positionAt[MOONS[key].parent](t)
      const expected = new THREE.Vector3(...parent).add(offset(key, t, scale))
      const actual = new THREE.Vector3(...moonPosition(key, t, scale))
      expect(actual.distanceTo(expected)).toBeLessThan(1e-9)
    }
  })

  it('draws an orbit loop through the moon, at its radius, the way it moves', () => {
    for (const t of DATES) {
      for (const key of MOON_KEYS) {
        const path = moonOrbitPath(key, t, 64, 'system')
        expect(path).toHaveLength(192)
        const live = offset(key, t)
        const first = new THREE.Vector3().fromArray(path, 0)
        expect(first.distanceTo(live)).toBeLessThan(1e-5)
        for (let k = 0; k < 64; k++) {
          expect(new THREE.Vector3().fromArray(path, k * 3).length()).toBeCloseTo(
            moonOrbitRadius(key, 'system'),
            4
          )
        }
        // The second point is where the moon heads next.
        const second = new THREE.Vector3().fromArray(path, 3)
        const soon = offset(key, t + (MOONS[key].periodDays * DAY) / 64)
        expect(second.distanceTo(soon) / moonOrbitRadius(key, 'system')).toBeLessThan(0.02)
      }
    }
  })

  it('writes into `out` when given', () => {
    const out = new Float32Array(32 * 3)
    expect(moonOrbitPath('titan', DATES[0], 32, 'system', out)).toBe(out)
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
        widen(systemBand, parent, r - moonRadius(key, 'system'), r + moonRadius(key, 'system'))
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
    const reach = moonSystemExtent(a, 'system') + moonSystemExtent(b, 'system')
    let touching = 0
    for (let i = 0; i < times.length; i++) {
      if (centres[a][i].distanceTo(centres[b][i]) < reach) touching++
    }
    expect(touching / times.length).toBeLessThan(0.03)
  })
})

describe('tidally locked orientation', () => {
  const X = new THREE.Vector3(1, 0, 0)
  const Y = new THREE.Vector3(0, 1, 0)
  const Z = new THREE.Vector3(0, 0, 1)

  it.each(DATES)('turns longitude 0 toward the parent and north to the IAU pole (%i)', (t) => {
    const q = new THREE.Quaternion()
    for (const key of MOON_KEYS) {
      const { parent, retrograde } = MOONS[key]
      moonOrientationInto(key, t, q)
      const lon0 = X.clone().applyQuaternion(q)
      const north = Y.clone().applyQuaternion(q)
      expect(lon0.dot(offset(key, t).normalize())).toBeCloseTo(-1, 6)
      // Triton's orbit is 23° off Neptune's equator, Iapetus' 15.47° off Saturn's.
      const iau = eclipticToScene(
        RotateVector(Rotation_EQJ_ECT(new Date(t)), RotationAxis(PLANETS[parent].body, new Date(t)).north),
        new THREE.Vector3()
      )
      expect(north.dot(iau)).toBeGreaterThan(0.9)
      // Seen from IAU north, a moon orbiting counterclockwise leads with
      // 90° W (local +Z); Uranus' moons and Triton orbit clockwise.
      const leading = Z.clone().applyQuaternion(q).dot(orbitNormal(key, t).cross(offset(key, t)).normalize())
      const clockwise = parent === 'uranus' || retrograde
      expect(leading).toBeCloseTo(clockwise ? -1 : 1, 2)
    }
  })
})
