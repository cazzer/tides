import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import * as THREE from 'three'
import { Body, HelioVector } from 'astronomy-engine'
import { PLANET_KEYS, PLANETS, sceneRadius } from '../planets'
import { FLIGHT_UNITS_PER_AU, flightPlanetPosition } from '../flight-scale'
import { CLOUD_CLEARANCE, CLOUD_LAYER_TOP, TERRAIN_DISPLACEMENT, cloudColumn } from '../cloud-layer'
import { latLonToLocal } from '../aurora'
import { applyBodyTransform } from '../body-transform'
import { earthSpin, earthTilt } from '../ephemeris'
import { ATMOSPHERE_OUTER, AURORA_SHELL_OUTER } from '../renderers/earth-shells'
import {
  COLLISION_MARGIN,
  OVERSPEED_MAX,
  V_NORMAL,
  collisionRadius,
  floorRadius,
  speedCap,
  speedFloor,
  wellFactor,
} from './flight'
import { fovKickShare } from './dust'
import type { QualityTier } from '../quality'
import { MOONS, MOON_KEYS, isMoonKey, moonPosition, moonRadius } from '../moons/moons'
import {
  BODY_MASS_KG,
  EARTH_COLLISION_RADIUS,
  EARTH_GROUND_CLEARANCE,
  EARTH_GROUND_SPEED,
  EARTH_RADIUS,
  EARTH_SHELL_RADIUS,
  MOON_COLLISION_CLEARANCE,
  createShipBodies,
  updateShipBodies,
} from './ship-bodies'
import { SHIP_FOV, shipNear, spawnPose } from './ship-session'
import {
  TERRAIN_FALLBACK_GREY,
  TERRAIN_GREY_MARGIN,
  TERRAIN_MAP_SIZE,
  buildTerrainFloor,
  demGrey,
  setEarthTerrain,
  terrainFloorGrey,
} from './terrain-floor'
import { LIMB_SEGMENTS, disposeLimbSpheres, limbSphere, retainLimbSphere } from './limb-detail'
import { TERRAIN_READ_TEXELS } from '../cloud-layer'
import { boxMips, decodeEarthDem, demLevel } from '../earth-dem'

const shippedDem = (name: string) => decodeEarthDem(readFileSync(new URL(`../assets/${name}`, import.meta.url)))
const [demMax, dem4k] = await Promise.all(['earth-dem-max.bin', 'earth-dem-4k.bin'].map(shippedDem))

const T = Date.UTC(2026, 9, 22, 12)

function byKey(t = T, tier: QualityTier = 'high') {
  const bodies = createShipBodies(tier)
  updateShipBodies(bodies, t)
  return Object.fromEntries(bodies.map((b) => [b.key, b]))
}

describe('ship bodies', () => {
  it('has the Sun, Earth, Moon, every planet and every major moon once', () => {
    expect(createShipBodies().map((b) => b.key)).toEqual([
      'sun',
      'earth',
      'moon',
      ...PLANET_KEYS,
      ...MOON_KEYS,
    ])
  })

  it('places and sizes the major moons as the flight scale draws them', () => {
    const b = byKey()
    for (const key of MOON_KEYS) {
      expect(b[key].radius).toBe(moonRadius(key))
      const [x, y, z] = moonPosition(key, T, 'flight')
      expect(b[key].position.distanceTo(new THREE.Vector3(x, y, z))).toBeLessThan(1e-9)
      // Near its parent, not its system-view distance from the Sun.
      expect(b[key].position.distanceTo(b[MOONS[key].parent].position)).toBeLessThan(40)
    }
  })

  it('sizes them as the scene draws them', () => {
    const b = byKey()
    expect(b.sun.radius).toBeCloseTo(10, 6)
    expect(b.moon.radius).toBeCloseTo(1, 6)
    expect(b.earth.radius).toBeCloseTo(sceneRadius(12742e3), 9)
    expect(b.earth.radius).toBeCloseTo(2.95, 2)
    for (const key of PLANET_KEYS) expect(b[key].radius).toBe(PLANETS[key].radius)
  })

  it('keeps the Sun at the origin and Earth at its true distance at the flight scale', () => {
    const b = byKey()
    expect(b.sun.position.length()).toBe(0)
    const au = HelioVector(Body.Earth, new Date(T)).Length()
    expect(b.earth.position.length() / (FLIGHT_UNITS_PER_AU * au)).toBeCloseTo(1, 9)
  })

  it('puts the Moon about 10 units from Earth', () => {
    for (let day = 0; day < 30; day += 3) {
      const b = byKey(T + day * 86_400_000)
      expect(b.moon.position.distanceTo(b.earth.position)).toBeGreaterThan(9)
      expect(b.moon.position.distanceTo(b.earth.position)).toBeLessThan(11)
    }
  })

  it('places each planet where flightPlanetPosition does', () => {
    const b = byKey()
    for (const key of PLANET_KEYS) {
      const [x, y, z] = flightPlanetPosition(PLANETS[key].body)(T)
      expect(b[key].position.x).toBeCloseTo(x, 9)
      expect(b[key].position.y).toBeCloseTo(y, 9)
      expect(b[key].position.z).toBeCloseTo(z, 9)
    }
  })

  it('gives every body its mass, with the Moon the smallest well and the Sun the biggest', () => {
    const bodies = createShipBodies()
    for (const body of bodies) {
      expect(body.mass).toBe(
        isMoonKey(body.key)
          ? MOONS[body.key].massKg
          : BODY_MASS_KG[body.key as keyof typeof BODY_MASS_KG]
      )
    }
    // Ganymede and Titan, the heaviest moons, still well inside their
    // parents' wells; the small moons floor at the Moon's.
    expect(wellFactor(MOONS.ganymede.massKg)).toBeLessThan(wellFactor(BODY_MASS_KG.jupiter))
    expect(wellFactor(MOONS.phobos.massKg)).toBe(1)
    const factors = bodies.map((b) => wellFactor(b.mass))
    expect(wellFactor(BODY_MASS_KG.moon)).toBeCloseTo(1, 12)
    expect(Math.min(...factors)).toBeCloseTo(1, 12)
    expect(Math.max(...factors)).toBe(wellFactor(BODY_MASS_KG.sun))
  })

  it('moves the same vectors in place', () => {
    const bodies = createShipBodies()
    const vectors = bodies.map((b) => b.position)
    updateShipBodies(bodies, T)
    const earth = bodies[1].position.clone()
    updateShipBodies(bodies, T + 30 * 86_400_000)
    expect(bodies.map((b) => b.position)).toEqual(vectors)
    expect(bodies.every((b, i) => b.position === vectors[i])).toBe(true)
    expect(bodies[1].position.distanceTo(earth)).toBeGreaterThan(20)
  })

  describe('collision radius (tides-3bl.7)', () => {
    it("keeps the ship outside every shell Earth draws, and a near plane's depth beyond, on the low tier", () => {
      const { earth } = byKey(T, 'low')
      expect(earth.minSpeed).toBeUndefined()
      expect(collisionRadius(earth)).toBe(EARTH_COLLISION_RADIUS)
      for (const shell of [
        earth.radius + CLOUD_LAYER_TOP,
        earth.radius * ATMOSPHERE_OUTER,
        earth.radius * AURORA_SHELL_OUTER,
      ]) {
        expect(EARTH_SHELL_RADIUS).toBeGreaterThanOrEqual(shell)
      }
      // From the collision sphere, whatever the near plane is it stays short
      // of the outermost shell (it is measured from the sea-level surface).
      const gap = EARTH_COLLISION_RADIUS - earth.radius
      expect(EARTH_COLLISION_RADIUS - shipNear(gap)).toBeGreaterThanOrEqual(EARTH_SHELL_RADIUS)
      // Close enough that Earth still fills the view: ~1.1 radii.
      expect(EARTH_COLLISION_RADIUS / earth.radius).toBeLessThan(1.15)
    })

    it('drops the hard sphere to the bare ground on the high tier (tides-01v.8.7)', () => {
      const { earth } = byKey()
      expect(collisionRadius(earth)).toBe(EARTH_RADIUS + EARTH_GROUND_CLEARANCE)
      expect(speedFloor(earth)).toBe(EARTH_GROUND_SPEED)
      // Under the cloud base, and far enough up that 0.4 of it stays over
      // shipNear's floor.
      expect(EARTH_GROUND_CLEARANCE).toBeLessThan(CLOUD_CLEARANCE)
      expect(EARTH_GROUND_CLEARANCE).toBeGreaterThanOrEqual(0.0025)
      expect(shipNear(EARTH_GROUND_CLEARANCE)).toBeCloseTo(0.4 * EARTH_GROUND_CLEARANCE, 12)
    })

    it('leaves the Moon and planets (no displaced or shelled surfaces) on the default margin', () => {
      const b = byKey()
      for (const key of ['sun', 'moon', ...PLANET_KEYS]) {
        expect(b[key].collisionRadius).toBeUndefined()
        expect(collisionRadius(b[key])).toBe(b[key].radius * COLLISION_MARGIN)
      }
    })

    it('stops the ship well clear of even the smallest moon', () => {
      const b = byKey()
      for (const key of MOON_KEYS) {
        const { radius } = b[key]
        expect(collisionRadius(b[key])).toBeGreaterThanOrEqual(radius * COLLISION_MARGIN)
        expect(collisionRadius(b[key]) - radius).toBeGreaterThanOrEqual(MOON_COLLISION_CLEARANCE - 1e-12)
      }
    })

    it('spawns outside every collision sphere', () => {
      for (let day = 0; day < 720; day += 15) {
        const bodies = createShipBodies()
        updateShipBodies(bodies, T + day * 86_400_000)
        for (const aspect of [16 / 9, 390 / 844]) {
          const { position } = spawnPose(bodies, aspect)
          for (const body of bodies) {
            expect(position.distanceTo(body.position)).toBeGreaterThan(collisionRadius(body))
          }
        }
      }
    })
  })

  describe('terrain floor (tides-01v.8.3)', () => {
    afterEach(() => setEarthTerrain(null))

    // Earth's mesh transform at `t`: a local direction in world axes.
    function toWorld(local: THREE.Vector3, t: number): THREE.Vector3 {
      const frame = new THREE.Object3D()
      applyBodyTransform(frame, { tiltAt: earthTilt, spinAt: earthSpin }, t)
      return local.clone().applyQuaternion(frame.quaternion)
    }

    it("samples the ground in Earth's tilted, spinning frame at the bodies' time", () => {
      // One white block over Tibet, sea everywhere else.
      const [width, height] = TERRAIN_MAP_SIZE
      const pooled = new Uint8Array(width * height)
      pooled[Math.floor(((90 - 32) / 180) * height) * width + Math.floor(((88 + 180) / 360) * width)] = 255
      setEarthTerrain(buildTerrainFloor(pooled))
      const tibet = latLonToLocal(32, 88)
      const { earth } = byKey()
      const high = EARTH_RADIUS + (TERRAIN_DISPLACEMENT * (255 + TERRAIN_GREY_MARGIN)) / 255
      expect(earth.ground!(toWorld(tibet, T))).toBeCloseTo(high, 9)
      // A quarter day on, Tibet has turned away from that world direction.
      const later = T + 6 * 3_600_000
      updateShipBodies([earth], later)
      expect(earth.ground!(toWorld(tibet, T))).toBeLessThan(EARTH_RADIUS + 0.01)
      expect(earth.ground!(toWorld(tibet, later))).toBeCloseTo(high, 9)
      // Mirrored through the equator or the prime meridian: open sea.
      expect(earth.ground!(toWorld(latLonToLocal(-32, 88), later))).toBeLessThan(EARTH_RADIUS + 0.01)
      expect(earth.ground!(toWorld(latLonToLocal(32, -88), later))).toBeLessThan(EARTH_RADIUS + 0.01)
    })

    const pooledTerrain = () => demGrey(demMax)
    // The ground the cloud march stands its columns on (cloudShaders.ts
    // cloudTerrain()): the 4k map's TERRAIN_READ_TEXELS-wide mip.
    const marchGround = boxMips(demLevel(dem4k)).find(({ width }) => width === TERRAIN_READ_TEXELS)!

    it('keeps the low-tier stop at EARTH_COLLISION_RADIUS everywhere, with the real terrain loaded', () => {
      setEarthTerrain(buildTerrainFloor(pooledTerrain()))
      const { earth } = byKey(T, 'low')
      const direction = new THREE.Vector3()
      let highest = 0
      for (let lat = -89; lat <= 89; lat += 1) {
        for (let lon = -180; lon < 180; lon += 1) {
          direction.copy(toWorld(latLonToLocal(lat, lon), T))
          highest = Math.max(highest, earth.ground!(direction))
          expect(floorRadius(earth, direction)).toBe(EARTH_COLLISION_RADIUS)
        }
      }
      expect(highest).toBeGreaterThan(EARTH_RADIUS + 0.05)
      expect(highest + EARTH_GROUND_CLEARANCE).toBeLessThan(EARTH_COLLISION_RADIUS)
    })

    it('stops the high tier groundClearance above the real terrain, from the sea to the Himalaya', () => {
      setEarthTerrain(buildTerrainFloor(pooledTerrain()))
      const { earth } = byKey()
      const ground = (lat: number, lon: number) => earth.ground!(toWorld(latLonToLocal(lat, lon), T))
      for (let lat = -89; lat <= 89; lat += 1) {
        for (let lon = -180; lon < 180; lon += 1) {
          const direction = toWorld(latLonToLocal(lat, lon), T)
          expect(floorRadius(earth, direction)).toBeCloseTo(earth.ground!(direction) + EARTH_GROUND_CLEARANCE, 12)
        }
      }
      // Mid-Pacific near sea level; Everest near the top of the displacement.
      expect(ground(0, -150) - EARTH_RADIUS).toBeLessThan(0.01)
      expect(ground(27.99, 86.93) - EARTH_RADIUS).toBeGreaterThan(0.05)
    })

    // Where a ray from Earth's centre along `local` meets the limb sphere's
    // displaced triangles, with each vertex at the highest grey it can read:
    // its bilinear sample of the elevation map at u = i / 512, v = j / 256
    // only reaches the pooled blocks either side of that line, plus the
    // half-float margin.
    // THREE.SphereGeometry's quad (i, j) is the faces (a, b, d) and (b, c, d)
    // over a = (i, j), b = (i, j + 1), c = (i + 1, j + 1), d = (i + 1, j).
    function limbMeshTop(pooled: Float32Array, local: THREE.Vector3): number {
      const [width, height] = LIMB_SEGMENTS
      const vertex = (i: number, j: number) => {
        let grey = 0
        for (const y of [j - 1, j]) {
          if (y < 0 || y >= height) continue
          for (const x of [i - 1, i]) grey = Math.max(grey, pooled[y * width + ((x + width) % width)])
        }
        const r = EARTH_RADIUS + (TERRAIN_DISPLACEMENT * (grey + TERRAIN_GREY_MARGIN)) / 255
        const phi = (i / width) * 2 * Math.PI
        const theta = (j / height) * Math.PI
        return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)).multiplyScalar(r)
      }
      const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
      const i = Math.floor((u - Math.floor(u)) * width)
      const j = Math.min(height - 1, Math.floor((0.5 - Math.asin(local.y) / Math.PI) * height))
      const ray = new THREE.Ray(new THREE.Vector3(), local.clone().normalize())
      const hit = new THREE.Vector3()
      let top = 0
      // The quads either side too, for rays a rounding away from an edge.
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const qj = j + dj
          if (qj < 0 || qj >= height) continue
          const qi = i + di
          const [a, b, c, d] = [vertex(qi, qj), vertex(qi, qj + 1), vertex(qi + 1, qj + 1), vertex(qi + 1, qj)]
          for (const [p, q, s] of [[a, b, d], [b, c, d]]) {
            if (ray.intersectTriangle(p, q, s, false, hit)) top = Math.max(top, hit.length())
          }
        }
      }
      return top
    }

    // The ship's stop under the cloud base, over land (where the pooled map's
    // 2 × 2 blocks average over 8 levels): the base on the march's ground at
    // the centres of its texels, which are these blocks' corners. (Until
    // tides-zmw.1 this took the 2 × 2 mean of the pooled maxima for that
    // ground, which overstated the share: 0.80 against 0.55 on the 8-bit
    // map. The 16-bit map gives 0.55, and the proxy 0.78.)
    function underBaseShare(earth: ReturnType<typeof byKey>[string], pooled: Float32Array) {
      const [width, height] = TERRAIN_MAP_SIZE
      let land = 0
      let under = 0
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          const grey = (pooled[y * width + x] + pooled[y * width + x + 1] + pooled[(y + 1) * width + x] + pooled[(y + 1) * width + x + 1]) / 4
          if (grey <= 8) continue
          const lat = 90 - ((y + 1) / height) * 180
          const lon = ((x + 1) / width) * 360 - 180
          const weight = Math.cos(THREE.MathUtils.degToRad(lat))
          const stop = floorRadius(earth, toWorld(latLonToLocal(lat, lon), T)) - EARTH_RADIUS
          land += weight
          const ground = marchGround.data[(y / 2) * marchGround.width + x / 2]
          if (stop < cloudColumn(1, 1.5, ground).base) under += weight
        }
      }
      return under / land
    }

    it("stops on the limb sphere's own floor while Earth's ground holds it, under the cloud base over most land (tides-42p)", () => {
      const pooled = pooledTerrain()
      const coarse = buildTerrainFloor(pooled)
      const fine = buildTerrainFloor(pooled, TERRAIN_MAP_SIZE, LIMB_SEGMENTS)
      setEarthTerrain(coarse, fine)
      const { earth } = byKey()
      // On the 128 × 128 sphere's floor a peak holds the stop up for ~8°.
      expect(underBaseShare(earth, pooled)).toBeLessThan(0.5)
      onTestFinished(disposeLimbSpheres)
      const release = retainLimbSphere(EARTH_RADIUS, limbSphere(EARTH_RADIUS))
      expect(underBaseShare(earth, pooled)).toBeGreaterThan(0.5)
      release()
      expect(underBaseShare(earth, pooled)).toBeLessThan(0.5)
      // The fine floor is the coarse one's own build over finer cells: never
      // above it, so the swap only ever lets the ship lower.
      for (let lat = -89; lat <= 89; lat += 1) {
        for (let lon = -180; lon < 180; lon += 1) {
          const local = latLonToLocal(lat, lon)
          expect(terrainFloorGrey(fine, local)).toBeLessThanOrEqual(terrainFloorGrey(coarse, local) + 1e-9)
        }
      }
    })

    it.each([
      ['128 × 128 sphere', false],
      ['limb sphere (tides-42p)', true],
    ])("keeps the near plane's corners off the ground at the high-tier stop over the %s, on steep slopes and 32:9 screens", (_, limb) => {
      // The ground mesh can stand no higher than the pooled block it reads
      // and its neighbours (terrain-floor.ts), plus the half-float margin. From
      // the stop, every point of that within the near rectangle's reach must
      // be further than the reach, at SHIP_FOV: the FOV kick is nil this low.
      const pooled = pooledTerrain()
      setEarthTerrain(buildTerrainFloor(pooled), buildTerrainFloor(pooled, TERRAIN_MAP_SIZE, LIMB_SEGMENTS))
      const release = limb ? retainLimbSphere(EARTH_RADIUS, limbSphere(EARTH_RADIUS)) : () => {}
      onTestFinished(() => {
        release()
        disposeLimbSpheres()
      })
      const [width, height] = TERRAIN_MAP_SIZE
      const meshTop = (local: THREE.Vector3) => {
        if (limb) return limbMeshTop(pooled, local)
        const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
        const x = Math.floor((u - Math.floor(u)) * width)
        const y = Math.min(height - 1, Math.floor((0.5 - Math.asin(local.y) / Math.PI) * height))
        let grey = 0
        for (let dy = -1; dy <= 1; dy++) {
          if (y + dy < 0 || y + dy >= height) continue
          for (let dx = -1; dx <= 1; dx++) grey = Math.max(grey, pooled[(y + dy) * width + ((x + dx + width) % width)])
        }
        return EARTH_RADIUS + (TERRAIN_DISPLACEMENT * (grey + TERRAIN_GREY_MARGIN)) / 255
      }
      const { earth } = byKey()
      const tan = Math.tan(THREE.MathUtils.degToRad(SHIP_FOV / 2))
      const reach = shipNear(EARTH_GROUND_CLEARANCE) * Math.sqrt(1 + tan * tan * (1 + (32 / 9) ** 2))
      const local = new THREE.Vector3()
      const side = new THREE.Vector3()
      const point = new THREE.Vector3()
      let closest = Infinity
      for (let lat = -88; lat <= 88; lat += 0.5) {
        for (let lon = -180; lon < 180; lon += 0.5) {
          const up = latLonToLocal(lat, lon)
          const eye = up.clone().multiplyScalar(floorRadius(earth, toWorld(up, T)))
          for (let k = 0; k < 8; k++) {
            side.set(Math.cos(k), 0, Math.sin(k)).cross(up).normalize()
            for (const s of [0, 0.001, 0.002, 0.003, 0.004]) {
              local.copy(up).applyAxisAngle(side, s / EARTH_RADIUS)
              closest = Math.min(closest, point.copy(local).multiplyScalar(meshTop(local)).distanceTo(eye))
            }
          }
        }
      }
      expect(closest).toBeGreaterThan(reach)
    })

    it('flies the floor slowly: the cap falls to EARTH_GROUND_SPEED near the ground, with no FOV kick', () => {
      const { earth } = byKey()
      const up = new THREE.Vector3(0, 1, 0)
      const at = (gap: number) =>
        earth.position.clone().addScaledVector(up, earth.ground!(up) + gap)
      const bodies = [earth]
      expect(speedCap(at(EARTH_GROUND_CLEARANCE), bodies)).toBe(EARTH_GROUND_SPEED)
      // Down the well past V_NORMAL, as it would be with the low tier's floor.
      expect(speedCap(at(0.5), bodies)).toBeLessThan(V_NORMAL)
      expect(speedCap(at(0.5), bodies)).toBeGreaterThan(EARTH_GROUND_SPEED)
      expect(speedCap(at(2), bodies)).toBeGreaterThan(V_NORMAL)
      expect(speedCap(at(0.5), [byKey(T, 'low').earth])).toBe(V_NORMAL)
      for (const speed of [EARTH_GROUND_SPEED, OVERSPEED_MAX * EARTH_GROUND_SPEED]) {
        expect(fovKickShare(speed, EARTH_GROUND_SPEED)).toBe(0)
      }
    })

    it('falls back over the highest ground there is until the map loads', () => {
      const { earth } = byKey()
      const fallback = EARTH_RADIUS + (TERRAIN_DISPLACEMENT * TERRAIN_FALLBACK_GREY) / 255
      expect(earth.ground!(new THREE.Vector3(1, 0, 0))).toBe(fallback)
      expect(floorRadius(earth, new THREE.Vector3(0, 1, 0))).toBe(fallback + EARTH_GROUND_CLEARANCE)
      expect(floorRadius(byKey(T, 'low').earth, new THREE.Vector3(0, 1, 0))).toBe(EARTH_COLLISION_RADIUS)
    })

    it('gives no other body a ground', () => {
      for (const body of createShipBodies()) {
        if (body.key !== 'earth') expect(body.ground).toBeUndefined()
      }
    })
  })
})
