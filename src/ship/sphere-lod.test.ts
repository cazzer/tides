import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CLOUD_FLAT_ALTITUDE, CLOUD_LAYER_TOP, SHEET_GROUND_SPHERE } from '../cloud-layer'
import { COLLISION_MARGIN } from './flight'
import { EARTH_COLLISION_RADIUS, EARTH_GROUND_CLEARANCE, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE } from './ship-bodies'
import { NEAR_SHARE } from './ship-session'
import { limbFacetPx, type SphereSegments } from './limb-detail'
import { EARTH_BASE_SEGMENTS } from './terrain-floor'
import { SUN_FRINGE, SUN_SEGMENTS, SUN_SHELL, sunShellScale } from '../renderers/sun-spicules'
import {
  SPHERE_LOD_FACET_PX,
  SPHERE_LOD_HYSTERESIS,
  STOP_TOP_LEVEL_SHARE,
  bodySphereGeometry,
  bodySphereUsers,
  drawsCoarseWhereTopForced,
  forceTopSphere,
  forcesTopLevel,
  pickSphereLevel,
  retainBodySphere,
  screenFacetPx,
  sphereLevelFor,
  sphereLevelStep,
  sphereLevels,
} from './sphere-lod'

const SCREEN_PX = 2532
const FOV = 45
const TOP: SphereSegments = [128, 128]
const LEVELS = sphereLevels(TOP)

function cameraAt(distance: number, aspect = 390 / 844): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.01, 1e6)
  camera.position.set(0, 0, distance)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

const origin = new THREE.Vector3()
const facetsAt = (distance: number, radius = 1) => (segments: SphereSegments) =>
  screenFacetPx(segments, cameraAt(distance), origin, radius, SCREEN_PX)

// The facets' sag under the sphere, as a share of its radius: each facet's
// nearest point to the centre.
function lowestFacet([width, height]: SphereSegments): number {
  const sphere = new THREE.SphereGeometry(1, width, height)
  const position = sphere.getAttribute('position')
  const index = sphere.getIndex()!
  const triangle = new THREE.Triangle()
  const nearest = new THREE.Vector3()
  let lowest = Infinity
  for (let i = 0; i < index.count; i += 3) {
    triangle.setFromAttributeAndIndices(position, index.getX(i), index.getX(i + 1), index.getX(i + 2))
    lowest = Math.min(lowest, triangle.closestPointToPoint(origin, nearest).length())
  }
  sphere.dispose()
  return lowest
}

describe('sphereLevels', () => {
  it('halves from the top down to 32', () => {
    expect(sphereLevels([128, 128])).toEqual([
      [128, 128],
      [64, 64],
      [32, 32],
    ])
    expect(sphereLevels([96, 48])).toEqual([[96, 48]])
    expect(sphereLevels([64, 32])).toEqual([[64, 32]])
  })
})

describe('screenFacetPx', () => {
  it('is limbFacetPx with the body on the view axis', () => {
    for (const distance of [1.5, 10, 300]) {
      for (const segments of LEVELS) {
        expect(screenFacetPx(segments, cameraAt(distance), origin, 1, SCREEN_PX)).toBeCloseTo(
          limbFacetPx(segments, distance, SCREEN_PX, FOV),
          12
        )
      }
    }
  })

  it('stretches off the axis, as far as the corner and no further', () => {
    const camera = cameraAt(100)
    // At the same distance from the eye, `degrees` off the axis.
    const at = (degrees: number) => {
      const angle = (degrees * Math.PI) / 180
      const centre = new THREE.Vector3(100 * Math.sin(angle), 0, 100 - 100 * Math.cos(angle))
      return screenFacetPx(TOP, camera, centre, 1, SCREEN_PX)
    }
    const onAxis = at(0)
    expect(at(5)).toBeGreaterThan(onAxis)
    expect(at(15)).toBeGreaterThan(at(5))
    // Past the corner (and behind) it is the corner's.
    const tanHalf = Math.tan((FOV / 2) * (Math.PI / 180))
    const corner = 1 + tanHalf * tanHalf * (1 + camera.aspect * camera.aspect)
    expect(at(80)).toBeCloseTo(onAxis * corner, 6)
    expect(at(170)).toBeCloseTo(onAxis * corner, 6)
    expect(at(15)).toBeLessThan(at(80))
  })

  it("measures an orthographic view by its px per unit", () => {
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100)
    camera.zoom = 2
    camera.updateProjectionMatrix()
    const [width, height] = TOP
    const depth = 1 - Math.cos(0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height))
    expect(screenFacetPx(TOP, camera, origin, 3, 1000)).toBeCloseTo((depth * 3 * 1000 * 2) / 10, 12)
  })

  it('is infinite from inside the sphere', () => {
    expect(screenFacetPx(TOP, cameraAt(0.5), origin, 1, SCREEN_PX)).toBe(Infinity)
  })
})

describe('pickSphereLevel', () => {
  // Facets in proportion to each level's sag, scaled to put the level `at` at `px`.
  const sag = ([width, height]: SphereSegments) => 1 - Math.cos(0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height))
  const scaled = (at: number, px: number) => (segments: SphereSegments) => (px * sag(segments)) / sag(LEVELS[at])

  it('goes finer at once past the bound, to the coarsest level within it', () => {
    expect(pickSphereLevel(LEVELS, 2, scaled(2, SPHERE_LOD_FACET_PX * 1.01))).toBe(1)
    expect(pickSphereLevel(LEVELS, 2, scaled(0, SPHERE_LOD_FACET_PX * 1.01))).toBe(0)
    expect(pickSphereLevel(LEVELS, 1, scaled(1, SPHERE_LOD_FACET_PX * 1.01))).toBe(0)
  })

  it('holds its level inside the hysteresis band', () => {
    const inBand = (SPHERE_LOD_FACET_PX * (1 + 1 / SPHERE_LOD_HYSTERESIS)) / 2
    expect(pickSphereLevel(LEVELS, 1, scaled(2, inBand))).toBe(1)
    expect(pickSphereLevel(LEVELS, 2, scaled(2, inBand))).toBe(2)
    expect(pickSphereLevel(LEVELS, 0, scaled(1, inBand))).toBe(0)
    expect(pickSphereLevel(LEVELS, 1, scaled(1, inBand))).toBe(1)
  })

  it('goes coarser once under the bound over the hysteresis, as far as it may', () => {
    const under = (0.99 * SPHERE_LOD_FACET_PX) / SPHERE_LOD_HYSTERESIS
    expect(pickSphereLevel(LEVELS, 0, scaled(1, under))).toBe(1)
    expect(pickSphereLevel(LEVELS, 0, scaled(2, under))).toBe(2)
  })

  it('coarsens monotonically going out and refines going in', () => {
    const distances = Array.from({ length: 400 }, (_, i) => 1.05 * 1.03 ** i)
    let level = 0
    let last = 0
    for (const distance of distances) {
      level = pickSphereLevel(LEVELS, level, facetsAt(distance))
      expect(level).toBeGreaterThanOrEqual(last)
      last = level
    }
    expect(level).toBe(LEVELS.length - 1)
    for (const distance of [...distances].reverse()) {
      level = pickSphereLevel(LEVELS, level, facetsAt(distance))
      expect(level).toBeLessThanOrEqual(last)
      last = level
    }
    expect(level).toBe(0)
  })

  it('never draws a level past the bound', () => {
    let level = 0
    for (let i = 0; i < 400; i++) {
      const facets = facetsAt(1.05 * 1.03 ** i)
      level = pickSphereLevel(LEVELS, level, facets)
      if (level > 0) expect(facets(LEVELS[level])).toBeLessThanOrEqual(SPHERE_LOD_FACET_PX)
    }
  })

  it('draws the top level from inside', () => {
    expect(pickSphereLevel(LEVELS, 2, facetsAt(0.5))).toBe(0)
  })
})

describe('the top level where it must be drawn', () => {
  const nothing = () => 0

  it("is Earth's at and under the cloud tops, as the sheet's early out needs", () => {
    // A coarser globe sags under the sphere the flat sheet ends its rays at.
    expect(lowestFacet(EARTH_BASE_SEGMENTS)).toBeGreaterThan(SHEET_GROUND_SPHERE)
    expect(lowestFacet([64, 64])).toBeLessThan(SHEET_GROUND_SPHERE)
    expect(EARTH_TOP_LEVEL_ALTITUDE).toBeGreaterThanOrEqual(CLOUD_LAYER_TOP)
    expect(CLOUD_LAYER_TOP).toBeGreaterThan(CLOUD_FLAT_ALTITUDE)
    for (const altitude of [0, CLOUD_FLAT_ALTITUDE, CLOUD_LAYER_TOP]) {
      expect(forcesTopLevel(EARTH_RADIUS + altitude, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE)).toBe(true)
      // Whatever the facets say.
      expect(sphereLevelFor(LEVELS, 2, EARTH_RADIUS + altitude, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE, nothing)).toBe(0)
    }
    expect(sphereLevelFor(LEVELS, 0, 3 * EARTH_RADIUS, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE, nothing)).toBe(2)
  })

  it("is Earth's near either tier's stop, whose floor is the top level's", () => {
    for (const stop of [EARTH_COLLISION_RADIUS, EARTH_RADIUS + EARTH_GROUND_CLEARANCE]) {
      expect(sphereLevelFor(LEVELS, 2, stop * SPHERE_LOD_HYSTERESIS, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE, nothing)).toBe(0)
    }
  })

  it("is the Sun's near the ship's stop, where a coarser shell would reach the near plane", () => {
    const radius = 7
    const within = radius * STOP_TOP_LEVEL_SHARE
    // At the stop the near plane stands NEAR_SHARE of the gap off the eye.
    const clearsNear = (segments: SphereSegments, eyeOverR: number) =>
      eyeOverR - sunShellScale(segments) > NEAR_SHARE * (eyeOverR - 1)
    expect(clearsNear([32, 32], COLLISION_MARGIN)).toBe(false)
    expect(sphereLevelFor(LEVELS, 2, radius * COLLISION_MARGIN, radius, within, nothing)).toBe(0)
    // Past it, every level's shell clears the near plane.
    const past = 1 + STOP_TOP_LEVEL_SHARE * 1.000001
    expect(sphereLevelFor(LEVELS, 0, radius * past, radius, within, nothing)).toBe(2)
    for (const segments of sphereLevels(SUN_SEGMENTS)) expect(clearsNear(segments, past)).toBe(true)
  })
})

describe("a frame's level, by the camera and the body as they stand", () => {
  // Earth's ground as the system view holds it: in a scaled parent.
  function earthAt(levelSegments: SphereSegments) {
    const parent = new THREE.Group()
    parent.scale.setScalar(2)
    parent.position.set(50, 0, 0)
    const ground = new THREE.Mesh(bodySphereGeometry(EARTH_RADIUS, levelSegments))
    const glow = new THREE.Mesh(ground.geometry)
    const other = new THREE.Mesh(new THREE.SphereGeometry(1))
    parent.add(ground, glow, other)
    parent.updateMatrixWorld(true)
    return { ground, glow, other }
  }
  // Looking at Earth's centre from `altitude` over its ground, its own units.
  const eyeAt = (altitude: number) => {
    const camera = new THREE.PerspectiveCamera(FOV, 390 / 844, 1e-4, 1e6)
    camera.position.set(50, 0, 2 * (EARTH_RADIUS + altitude))
    camera.lookAt(50, 0, 0)
    camera.updateMatrixWorld()
    return camera
  }
  // Earth's radius in device px, from where its centre is `distance` (world units) away.
  const altitudeForPx = (px: number) => {
    const pxPerRadian = SCREEN_PX / 2 / Math.tan((FOV / 2) * (Math.PI / 180))
    return EARTH_RADIUS / Math.sin(px / pxPerRadian) - EARTH_RADIUS
  }

  it('is the top under the sheet whatever the level drawn, and coarse far off', () => {
    const { ground } = earthAt([32, 32])
    for (const altitude of [0.5 * CLOUD_FLAT_ALTITUDE, CLOUD_LAYER_TOP]) {
      expect(sphereLevelStep(LEVELS, 2, eyeAt(altitude), ground, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE, SCREEN_PX)).toBe(0)
    }
    expect(sphereLevelStep(LEVELS, 0, eyeAt(altitudeForPx(20)), ground, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE, SCREEN_PX)).toBe(2)
    expect(sphereLevelStep(LEVELS, 0, eyeAt(altitudeForPx(80)), ground, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE, SCREEN_PX)).toBe(1)
    expect(sphereLevelStep(LEVELS, 2, eyeAt(altitudeForPx(400)), ground, EARTH_RADIUS, EARTH_TOP_LEVEL_ALTITUDE, SCREEN_PX)).toBe(0)
  })

  it('catches a jump under the sheet at draw time and puts the top on every mesh drawing that sphere', () => {
    const { ground, glow, other } = earthAt([32, 32])
    const coarse = ground.geometry
    const otherSphere = other.geometry
    const top = bodySphereGeometry(EARTH_RADIUS, TOP)
    // Far off, a coarse level stands.
    expect(drawsCoarseWhereTopForced(eyeAt(altitudeForPx(20)), ground, EARTH_RADIUS, TOP, EARTH_TOP_LEVEL_ALTITUDE)).toBe(false)
    // Jumped straight under the sheet: caught before the draw.
    const under = eyeAt(0.5 * CLOUD_FLAT_ALTITUDE)
    expect(drawsCoarseWhereTopForced(under, ground, EARTH_RADIUS, TOP, EARTH_TOP_LEVEL_ALTITUDE)).toBe(true)
    forceTopSphere(ground, top)
    expect(ground.geometry).toBe(top)
    expect(glow.geometry).toBe(top)
    expect(other.geometry).toBe(otherSphere)
    expect(coarse).not.toBe(top)
    // Drawing the top, or a limb sphere (no segments), there's nothing to catch.
    expect(drawsCoarseWhereTopForced(under, ground, EARTH_RADIUS, TOP, EARTH_TOP_LEVEL_ALTITUDE)).toBe(false)
    ground.geometry = new THREE.BufferGeometry()
    expect(drawsCoarseWhereTopForced(under, ground, EARTH_RADIUS, TOP, EARTH_TOP_LEVEL_ALTITUDE)).toBe(false)
  })
})

describe("the Sun's shell per level", () => {
  it('holds the tallest jets over every level, the top at SUN_SHELL', () => {
    const levels = sphereLevels(SUN_SEGMENTS)
    expect(levels).toHaveLength(3)
    expect(sunShellScale(levels[0])).toBe(SUN_SHELL)
    for (const segments of levels) {
      const shell = sunShellScale(segments)
      expect(shell * lowestFacet(segments)).toBeGreaterThanOrEqual(1 + SUN_FRINGE)
    }
    // Each level culls and picks by its own shell, which its draw sets uShell to.
    for (const segments of levels) {
      const shell = sunShellScale(segments)
      const sphere = bodySphereGeometry(7, segments, shell)
      expect(sphere.userData.shell).toBe(shell)
      expect(sphere.boundingSphere!.radius).toBeCloseTo(7 * shell, 5)
      expect(sphere).not.toBe(bodySphereGeometry(7, segments))
    }
    const renderer = readFileSync(new URL('../renderers/SunRenderer.tsx', import.meta.url), 'utf8')
    expect(renderer).toMatch(/uShell\.value = geometry\.userData\.shell/)
  })
})

describe('the shared body spheres', () => {
  it('are shared by radius and segments, with their segments, and disposed with their last user', () => {
    const a = bodySphereGeometry(0.123, [64, 64])
    expect(bodySphereGeometry(0.123, [64, 64])).toBe(a)
    expect(bodySphereGeometry(0.123, [32, 32])).not.toBe(a)
    expect(a.userData.segments).toEqual([64, 64])
    let disposed = 0
    a.addEventListener('dispose', () => disposed++)
    const releaseOne = retainBodySphere(a)
    const releaseTwo = retainBodySphere(a)
    expect(bodySphereUsers(0.123, [64, 64])).toBe(2)
    releaseOne()
    releaseOne()
    expect(disposed).toBe(0)
    releaseTwo()
    expect(disposed).toBe(1)
    expect(bodySphereUsers(0.123, [64, 64])).toBe(0)
    // Retained again after its dispose (StrictMode's replayed effects), it is the shared one once more.
    const releaseAgain = retainBodySphere(a)
    expect(bodySphereGeometry(0.123, [64, 64])).toBe(a)
    releaseAgain()
  })

  it("swap to the limb sphere by the top level's segments, whatever the level drawn", () => {
    const source = readFileSync(new URL('./limb-detail.ts', import.meta.url), 'utf8')
    // (No hook renderer in the tests: the wiring, by its text.)
    const sized = source.slice(source.indexOf('export function useSizedBodySphere('))
    expect(sized).toMatch(/useBodySphereAt\(key, radius, \[width, height\], level, swapFloor\)/)
    const at = source.slice(source.indexOf('function useBodySphereAt('))
    expect(at).toMatch(/useRetainedBodySphere\(radius, level\)/)
    expect(at).toMatch(/useWantsLimbSphere\(key, radius, top, swapFloor\)/)
  })
})
