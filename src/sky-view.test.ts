import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { sceneRadius } from './planets'
import {
  GROUND_RADIUS,
  HILL_HEIGHT,
  HORIZON_ROW,
  ECLIPSE_SUN_SKY_DISTANCE,
  SURFACE_FOV,
  groundGeometry,
  hillAltitude,
  placeSurfaceCamera,
  roundDiscMatrix,
  surfaceView,
} from './sky'
import { SKY_SCALE, matchedSkyDistance } from './eclipse-sky'

const DEG = Math.PI / 180

// The panel shapes: desktop single, phone single, phone triple (bottom left).
const panels = [
  { name: '1280 single', width: 1280, height: 800 },
  { name: '390 single', width: 390, height: 844 },
  { name: '390 triple', width: 195, height: 200 },
]

function panelCamera(width: number, height: number) {
  const camera = new THREE.PerspectiveCamera(SURFACE_FOV, width / height, 0.01, 1000)
  camera.rotation.set(0.3, 0.2, 0)
  camera.updateMatrixWorld()
  return camera
}

// The disc a sphere draws, in pixels: its extent along the line from the
// centre of view (radial) and across it.
function discExtents(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  center: THREE.Vector3,
  radius: number,
  squash: THREE.Matrix4
) {
  const toPixels = (v: THREE.Vector3) => {
    v.project(camera)
    return new THREE.Vector2((v.x * width) / 2, (v.y * height) / 2)
  }
  const middle = toPixels(center.clone())
  const radial = middle.lengthSq() > 1e-9 ? middle.clone().normalize() : new THREE.Vector2(1, 0)
  const across = new THREE.Vector2(-radial.y, radial.x)
  const sphere = new THREE.SphereGeometry(radius, 256, 128)
  const position = sphere.getAttribute('position')
  const range = { radial: [Infinity, -Infinity], across: [Infinity, -Infinity] }
  const v = new THREE.Vector3()
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i).add(center).applyMatrix4(squash)
    const p = toPixels(v)
    const r = p.dot(radial)
    const a = p.dot(across)
    range.radial = [Math.min(range.radial[0], r), Math.max(range.radial[1], r)]
    range.across = [Math.min(range.across[0], a), Math.max(range.across[1], a)]
  }
  sphere.dispose()
  return {
    radial: range.radial[1] - range.radial[0],
    across: range.across[1] - range.across[0],
  }
}

// At the everyday SKY_SCALE and at the solar eclipse demo's k ≈ 43, for mean
// true radii (eclipse-sky.ts).
const SUN_SCENE = sceneRadius(1392700000)
const MOON_SCENE = sceneRadius(3474800)
const SUN_TRUE = 0.2666 * DEG
const MOON_TRUE = 0.259 * DEG
const DEMO_SCALE = Math.asin(SUN_SCENE / ECLIPSE_SUN_SKY_DISTANCE) / SUN_TRUE
const bodies = [
  { name: 'Sun', radius: SUN_SCENE, distance: matchedSkyDistance(SUN_SCENE, SKY_SCALE, SUN_TRUE) },
  { name: 'Moon', radius: MOON_SCENE, distance: matchedSkyDistance(MOON_SCENE, SKY_SCALE, MOON_TRUE) },
  { name: 'demo Sun', radius: SUN_SCENE, distance: ECLIPSE_SUN_SKY_DISTANCE },
  { name: 'demo Moon', radius: MOON_SCENE, distance: matchedSkyDistance(MOON_SCENE, DEMO_SCALE, MOON_TRUE) },
]
// Where on the panel the disc's centre sits, in NDC; corners included.
const spots = [-0.85, 0, 0.85].flatMap((x) => [-0.85, 0, 0.85].map((y) => [x, y]))

describe('Sun and Moon discs in View from Earth (tides-39l)', () => {
  for (const panel of panels) {
    for (const body of bodies) {
      it(`stay round in the ${panel.name} panel: ${body.name}`, () => {
        const camera = panelCamera(panel.width, panel.height)
        const eye = camera.getWorldPosition(new THREE.Vector3())
        let worstBefore = 1
        for (const [x, y] of spots) {
          const center = new THREE.Vector3(x, y, 0.5)
            .unproject(camera)
            .sub(eye)
            .setLength(body.distance)
            .add(eye)
          const squash = roundDiscMatrix(new THREE.Matrix4(), center, camera)
          // The squash is about the body's centre, so its direction is kept.
          expect(center.clone().applyMatrix4(squash).distanceTo(center)).toBeLessThan(1e-9)

          const after = discExtents(camera, panel.width, panel.height, center, body.radius, squash)
          expect(Math.abs(after.radial / after.across - 1)).toBeLessThan(0.02)

          const before = discExtents(
            camera, panel.width, panel.height, center, body.radius, new THREE.Matrix4()
          )
          worstBefore = Math.max(worstBefore, before.radial / before.across)
        }
        // Unsquashed, the 90° view stretches discs toward its edges.
        expect(worstBefore).toBeGreaterThan(1.2)
      })
    }
  }
})

describe('Sun and Moon discs while looking around (tides-2dp)', () => {
  const looks = [
    { azimuth: 0, altitude: 0 },
    { azimuth: 75, altitude: 25 },
    { azimuth: 200, altitude: 60 },
    { azimuth: 300, altitude: -5 },
    { azimuth: 120, altitude: 90 },
  ]
  for (const body of bodies) {
    it(`stay round at any heading and pitch, up to the zenith: ${body.name}`, () => {
      const { width, height } = panels[0]
      for (const look of looks) {
        const earth = new THREE.Object3D()
        const observer = new THREE.Object3D()
        const camera = new THREE.PerspectiveCamera(SURFACE_FOV, width / height, 0.01, 1000)
        earth.add(observer)
        observer.add(camera)
        placeSurfaceCamera(observer, camera, 51.5, 20, 2.95, look)
        earth.updateMatrixWorld()

        const eye = camera.getWorldPosition(new THREE.Vector3())
        // The zenith itself, plus spots across the panel.
        const zenith = observer.localToWorld(new THREE.Vector3(0, body.distance, 0))
        const centers = [
          zenith,
          ...spots.map(([x, y]) =>
            new THREE.Vector3(x, y, 0.5).unproject(camera).sub(eye).setLength(body.distance).add(eye)
          ),
        ]
        for (const center of centers) {
          const toward = center.clone().sub(eye).normalize()
          if (toward.dot(camera.getWorldDirection(new THREE.Vector3())) < 0.3) continue
          const squash = roundDiscMatrix(new THREE.Matrix4(), center, camera)
          const after = discExtents(camera, width, height, center, body.radius, squash)
          expect(Math.abs(after.radial / after.across - 1)).toBeLessThan(0.02)
        }
      }
    })
  }
})

describe('the horizon in View from Earth (tides-c7d)', () => {
  it(`crosses every panel level, ${HORIZON_ROW * 100}% of the way down`, () => {
    for (const lat of [-89.9, -30, 0, 51.5, 89.9]) {
      for (const panel of panels) {
        const earth = new THREE.Object3D()
        const observer = new THREE.Object3D()
        const camera = new THREE.PerspectiveCamera(SURFACE_FOV, panel.width / panel.height)
        earth.add(observer)
        observer.add(camera)
        placeSurfaceCamera(observer, camera, lat, 20, 2.95)
        earth.updateMatrixWorld()

        // Horizon points across the view's width: alt 0 in the observer's
        // frame (+Y the zenith, −Z the view's azimuth).
        const halfWidth = Math.atan(Math.tan((SURFACE_FOV / 2) * DEG) * camera.aspect)
        for (const az of [-0.8, -0.4, 0, 0.4, 0.8].map((f) => f * halfWidth)) {
          const point = observer.localToWorld(
            new THREE.Vector3(Math.sin(az), 0, -Math.cos(az)).multiplyScalar(5)
          )
          point.project(camera)
          const row = (1 - point.y) / 2
          expect(row).toBeCloseTo(HORIZON_ROW, 6)
        }
      }
      expect(surfaceView(lat).altitude).toBeGreaterThan(30)
    }
  })

  it('stands the ground on hills no higher than HILL_HEIGHT', () => {
    const samples = Array.from({ length: 720 }, (_, i) => hillAltitude((i / 720) * Math.PI * 2))
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...samples)).toBeLessThanOrEqual(HILL_HEIGHT)
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(HILL_HEIGHT / 2)
    expect(hillAltitude(0)).toBeCloseTo(hillAltitude(Math.PI * 2), 9)

    const radius = GROUND_RADIUS * 0.98
    const geometry = groundGeometry(radius)
    const position = geometry.getAttribute('position')
    for (let i = 0; i < position.count; i += 1) {
      const altitude = Math.asin(THREE.MathUtils.clamp(position.getY(i) / radius, -1, 1)) / DEG
      expect(altitude).toBeLessThanOrEqual(HILL_HEIGHT + 1e-6)
    }
    geometry.dispose()
  })
})
