import * as THREE from 'three'
import {
  EARTH_ORBIT_RADIUS,
  earthPosition,
  earthSpin,
  earthTilt,
  type Vec3,
} from './ephemeris'
import { applyBodyTransform } from './body-transform'
import { calculateLocationAndRotationForLatLng } from './utils'
import type { SkyLook } from './sky-look'
import {
  SKY_SCALE,
  eclipseMoonDirection,
  eclipseSkyAt,
  eclipseSkyScale,
  matchedSkyDistance,
  type EclipseSky,
} from './eclipse-sky'

const DEG = Math.PI / 180

// "View from Earth" stands here until the user sets a location.
export const DEFAULT_SURFACE_LOCATION = { lat: -30, lon: 0 }

// The sky Sun and Moon keep the renderers' scene sizes and are drawn at the
// distance where that size looks k times their true angular radius (~0.27°),
// which would otherwise be a few pixels (eclipse-sky.ts). Everyday, k is
// SKY_SCALE: the Sun ~270 units out, the Moon ~26, the Sun's upper limb
// clearing the horizon (k − 1) × 0.27° before the real one, and the discs
// overlapping exactly when the real ones do. The solar eclipse demo's sky Sun
// keeps its scene radius here instead, ~11.5°, so its k is ~43.
export const ECLIPSE_SUN_SKY_DISTANCE = EARTH_ORBIT_RADIUS

// The surface camera's vertical field of view, in degrees.
export const SURFACE_FOV = 90

// Where the horizon crosses the panel, as a fraction of its height from the
// top: low, leaving a sliver of ground under the sky (tides-c7d).
export const HORIZON_ROW = 0.9

// Face the equator, tilted up so the horizon sits at HORIZON_ROW whatever the
// panel's shape (the FOV is vertical). Degrees; azimuth from north through east.
export function surfaceView(lat: number) {
  const halfFov = (SURFACE_FOV / 2) * DEG
  return {
    azimuth: lat < 0 ? 0 : 180,
    altitude: Math.atan((2 * HORIZON_ROW - 1) * Math.tan(halfFov)) / DEG,
  }
}

// Below the horizon: a dome around the observer, inside the sky Sun's and
// Moon's distances (all but the demo's k ≈ 43 Moon, about as far out as it),
// so whatever has set is hidden.
export const GROUND_RADIUS = 5

// Hills on the horizon, at most this high (degrees): enough to read as a
// landscape, low enough that rising and setting stay close to the true times.
export const HILL_HEIGHT = 1.5
const GROUND_NEAR = new THREE.Color(0.014, 0.017, 0.016)
const GROUND_FAR = new THREE.Color(0.003, 0.004, 0.003)

// A seamless, fixed ridgeline around the observer, 0..HILL_HEIGHT degrees.
export function hillAltitude(azimuth: number) {
  const ridge =
    0.5 +
    0.28 * Math.sin(3 * azimuth + 1) +
    0.14 * Math.sin(7 * azimuth + 2.3) +
    0.08 * Math.sin(19 * azimuth + 4.1)
  return HILL_HEIGHT * THREE.MathUtils.clamp(ridge, 0, 1)
}

// The ground as a bowl of the observer's sky (+Y the zenith) rising to the
// hills, coloured per vertex: hazy toward the horizon, dark underfoot. Drawn a
// little inside the horizon glow so the hills cover it.
export function groundGeometry(radius: number) {
  const columns = 256
  const rows = [0, -1, -3, -8, -20, -45, -90]
  const positions: number[] = []
  const colors: number[] = []
  const color = new THREE.Color()
  for (let i = 0; i <= columns; i += 1) {
    const azimuth = (i / columns) * Math.PI * 2
    for (const [row, below] of rows.entries()) {
      const altitude = (row === 0 ? hillAltitude(azimuth) : below) * DEG
      positions.push(
        radius * Math.cos(altitude) * Math.sin(azimuth),
        radius * Math.sin(altitude),
        -radius * Math.cos(altitude) * Math.cos(azimuth)
      )
      const depth = Math.min(1, Math.abs(Math.min(below, 0)) / 20)
      color.copy(GROUND_NEAR).lerp(GROUND_FAR, depth).toArray(colors, colors.length)
    }
  }
  const index: number[] = []
  for (let i = 0; i < columns; i += 1) {
    for (let j = 0; j < rows.length - 1; j += 1) {
      const a = i * rows.length + j
      const b = a + rows.length
      index.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(index)
  return geometry
}

// Airglow and scattered light brighten the sky toward the horizon; without it
// the ground met the stars on a hard, featureless edge. Added over the sky, so
// a linear colour at the horizon, falling off by e every HORIZON_GLOW_HEIGHT
// degrees and gone by HORIZON_GLOW_TOP.
export const HORIZON_GLOW = new THREE.Color(0.032, 0.04, 0.06)
export const HORIZON_GLOW_HEIGHT = 6
const HORIZON_GLOW_TOP = 30

// The glow as a band of the observer's sky (+Y the zenith), BackSide-facing,
// coloured per vertex by altitude.
export function horizonGlowGeometry(radius: number) {
  const top = HORIZON_GLOW_TOP * DEG
  const geometry = new THREE.SphereGeometry(radius, 64, 30, 0, Math.PI * 2, Math.PI / 2 - top, top)
  const position = geometry.getAttribute('position')
  const colors = new Float32Array(position.count * 3)
  const color = new THREE.Color()
  for (let i = 0; i < position.count; i += 1) {
    const altitude = Math.asin(THREE.MathUtils.clamp(position.getY(i) / radius, -1, 1)) / DEG
    const fade = altitude >= HORIZON_GLOW_TOP - 1e-6 ? 0 : Math.exp(-altitude / HORIZON_GLOW_HEIGHT)
    color.copy(HORIZON_GLOW).multiplyScalar(fade).toArray(colors, i * 3)
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

const zenith = new THREE.Vector3()
const north = new THREE.Vector3()
const east = new THREE.Vector3()
const ahead = new THREE.Vector3()
const right = new THREE.Vector3()
const basis = new THREE.Matrix4()

// Stands `observer` (in the Earth's frame) at lat/lon on the surface, level
// with the horizon: +Y is the zenith and −Z faces surfaceView(lat).azimuth,
// so the ground it carries stays put while the view turns. `camera`, its
// child, turns to `look` (by default surfaceView(lat)): heading about the
// zenith, then pitch about its own right axis, and roll only in compass mode,
// so the horizon otherwise stays level on screen.
export function placeSurfaceCamera(
  observer: THREE.Object3D,
  camera: THREE.Object3D,
  lat: number,
  lon: number,
  radius: number,
  look: SkyLook = surfaceView(lat)
) {
  const { position } = calculateLocationAndRotationForLatLng(lat, lon, radius)
  observer.position.set(position.x, position.y, position.z)

  // Same lat/lon convention: lon 0 on +X, east toward −Z.
  const phi = lat * DEG
  const lambda = -lon * DEG
  zenith.set(
    Math.cos(phi) * Math.cos(lambda),
    Math.sin(phi),
    Math.cos(phi) * Math.sin(lambda)
  )
  north.set(
    -Math.sin(phi) * Math.cos(lambda),
    Math.cos(phi),
    -Math.sin(phi) * Math.sin(lambda)
  )
  east.crossVectors(north, zenith)

  const a = surfaceView(lat).azimuth * DEG
  ahead.copy(north).multiplyScalar(Math.cos(a)).addScaledVector(east, Math.sin(a))
  right.crossVectors(ahead, zenith)
  basis.makeBasis(right, zenith, ahead.negate())
  observer.quaternion.setFromRotationMatrix(basis)

  camera.position.set(0, 0, 0)
  camera.rotation.set(look.altitude * DEG, a - look.azimuth * DEG, (look.roll ?? 0) * DEG, 'YXZ')
}

const eye = new THREE.Vector3()
const forward = new THREE.Vector3()
const outward = new THREE.Vector3()
const toCenter = new THREE.Vector3()

// A sphere θ off a perspective camera's axis projects as an ellipse stretched
// away from the centre of view by about 1/cos θ: 1.4x at the side of the 90°
// surface view (tides-39l). Squashing the body by cos θ along that direction,
// about its centre, keeps the disc round (within 2% to 70° off axis, even for
// the demo Sun's ~11°) and on its true direction. Writes the world-space squash into
// `target`.
export function roundDiscMatrix(
  target: THREE.Matrix4,
  center: THREE.Vector3,
  camera: THREE.Object3D
) {
  camera.getWorldPosition(eye)
  camera.getWorldDirection(forward)
  toCenter.subVectors(center, eye).normalize()
  const cos = toCenter.dot(forward)
  outward.copy(toCenter).multiplyScalar(cos).sub(forward)
  if (cos <= 0 || outward.lengthSq() < 1e-12) return target.identity()
  outward.normalize()

  const s = cos - 1
  const { x, y, z } = outward
  const along = outward.dot(center) * s
  return target.set(
    1 + s * x * x, s * x * y, s * x * z, -along * x,
    s * y * x, 1 + s * y * y, s * y * z, -along * y,
    s * z * x, s * z * y, 1 + s * z * z, -along * z,
    0, 0, 0, 1
  )
}

const earth = new THREE.Object3D()
const observerWorld = new THREE.Vector3()

// The observer's scene position at t, into observerWorld: their place on the
// scene Earth under its transform, as OrbitingBody applies it.
function observerWorldAt(t: number, position: { x: number; y: number; z: number }) {
  applyBodyTransform(
    earth,
    { tiltAt: earthTilt, spinAt: earthSpin, positionAt: earthPosition },
    t
  )
  earth.updateMatrix()
  return observerWorld.set(position.x, position.y, position.z).applyMatrix4(earth.matrix)
}

/** The observer's scene position at t, for lat/lon on a scene Earth of radius. */
export function skyObserverAt(lat: number, lon: number, radius: number): (t: number) => Vec3 {
  const { position } = calculateLocationAndRotationForLatLng(lat, lon, radius)
  return (t) => {
    const { x, y, z } = observerWorldAt(t, position)
    return [x, y, z]
  }
}

/** How many times their true size the sky Sun and Moon are drawn, given the sky. */
export type SkyScale = (e: EclipseSky) => number

export const everydaySkyScale: SkyScale = () => SKY_SCALE

/** The solar eclipse demo's k (≈ 43): its sky Sun at ECLIPSE_SUN_SKY_DISTANCE. */
export function eclipseDemoSkyScale(sunSceneRadius: number): SkyScale {
  return (e) => eclipseSkyScale(e, sunSceneRadius, ECLIPSE_SUN_SKY_DISTANCE)
}

// The sky Sun and Moon for an observer at lat/lon on the scene Earth (radius
// in scene units), both at scaleAt's k times their true angular size: each at
// the distance where its scene radius looks that size, the Sun along its true
// topocentric direction and the Moon turned from it by the scaled offset
// (eclipse-sky.ts). The scene's own Sun and Moon are at compressed distances,
// so their directions from the surface would be off by up to ~16°.
export function skyDiscPositionsAt(
  lat: number,
  lon: number,
  radius: number,
  sceneRadius: { sun: number; moon: number },
  scaleAt: SkyScale
): { sun: (t: number) => Vec3; moon: (t: number) => Vec3 } {
  const { position } = calculateLocationAndRotationForLatLng(lat, lon, radius)
  const eye = new THREE.Vector3()
  const place = new THREE.Vector3()
  // Both bodies are placed once a frame at the same t: one observer for both.
  let eyeT = NaN
  const eyeAt = (t: number) => {
    if (t !== eyeT) {
      eye.copy(observerWorldAt(t, position))
      eyeT = t
    }
    return eye
  }
  return {
    sun: (t) => {
      const e = eclipseSkyAt(t, lat, lon)
      const k = scaleAt(e)
      place
        .copy(e.sun)
        .multiplyScalar(matchedSkyDistance(sceneRadius.sun, k, e.sunRadius))
        .add(eyeAt(t))
      return [place.x, place.y, place.z]
    },
    moon: (t) => {
      const e = eclipseSkyAt(t, lat, lon)
      const k = scaleAt(e)
      eclipseMoonDirection(e, k, place)
        .multiplyScalar(matchedSkyDistance(sceneRadius.moon, k, e.moonRadius))
        .add(eyeAt(t))
      return [place.x, place.y, place.z]
    },
  }
}
