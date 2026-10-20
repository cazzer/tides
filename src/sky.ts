import * as THREE from 'three'
import {
  Body,
  Equator,
  MakeTime,
  Observer,
  RotateVector,
  Rotation_EQD_ECT,
} from 'astronomy-engine'
import {
  EARTH_AXIAL_TILT,
  EARTH_ORBIT_RADIUS,
  earthPosition,
  earthSpin,
  eclipticToScene,
  type Vec3,
} from './ephemeris'
import { applyBodyTransform } from './body-transform'
import { calculateLocationAndRotationForLatLng } from './utils'

const DEG = Math.PI / 180

// "View from Earth" stands here until the user sets a location.
export const DEFAULT_SURFACE_LOCATION = { lat: -30, lon: 0 }

// The sky Sun and Moon keep the renderers' scene sizes at these distances, so
// they appear ~11° and ~6° in radius. The real ones are ~0.27° and would be a
// few pixels; the sizes are exaggerated for visibility, the directions are not.
// Side effects of the size: the Sun's upper limb clears the horizon while its
// centre is still ~11° below (about an hour before sunrise), and the discs
// overlap whenever the Moon is within ~17° of the Sun, near every new moon.
export const SUN_SKY_DISTANCE = EARTH_ORBIT_RADIUS
export const MOON_SKY_DISTANCE = 10

// The surface camera's vertical field of view, in degrees.
export const SURFACE_FOV = 90

// Face the equator, tilted halfway up to where the celestial equator crosses
// the meridian (at most 30°), so the horizon stays in view below the Sun's and
// Moon's daily arcs. Degrees; azimuth from north through east.
export function surfaceView(lat: number) {
  return {
    azimuth: lat < 0 ? 0 : 180,
    altitude: Math.min(30, (90 - Math.abs(lat)) / 2),
  }
}

// Below the horizon: a dome around the observer, inside the sky Moon's
// distance, so whatever has set is hidden.
export const GROUND_RADIUS = 5

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
// with the horizon: +Y is the zenith and −Z faces surfaceView(lat).azimuth.
// `camera`, its child, is pitched up to surfaceView(lat).altitude, so its up
// axis leans toward the zenith and the horizon stays level on screen.
export function placeSurfaceCamera(
  observer: THREE.Object3D,
  camera: THREE.Object3D,
  lat: number,
  lon: number,
  radius: number
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

  const { azimuth, altitude } = surfaceView(lat)
  const a = azimuth * DEG
  ahead.copy(north).multiplyScalar(Math.cos(a)).addScaledVector(east, Math.sin(a))
  right.crossVectors(ahead, zenith)
  basis.makeBasis(right, zenith, ahead.negate())
  observer.quaternion.setFromRotationMatrix(basis)

  camera.position.set(0, 0, 0)
  camera.rotation.set(altitude * DEG, 0, 0)
}

const earth = new THREE.Object3D()
const observerWorld = new THREE.Vector3()
const direction = new THREE.Vector3()

// Scene position of a sky body for an observer at lat/lon on the scene Earth
// (radius in scene units): the observer plus `distance` along the body's true
// topocentric direction. The scene's own Sun and Moon are at compressed
// distances, so their directions from the surface are off by up to ~16°.
export function skyPositionAt(
  body: Body,
  distance: number,
  lat: number,
  lon: number,
  radius: number
): (t: number) => Vec3 {
  const site = new Observer(lat, lon, 0)
  const { position } = calculateLocationAndRotationForLatLng(lat, lon, radius)
  return (t) => {
    // The Earth's transform, as OrbitingBody applies it.
    applyBodyTransform(
      earth,
      { axialTilt: EARTH_AXIAL_TILT, spinAt: earthSpin, positionAt: earthPosition },
      t
    )
    earth.updateMatrix()
    observerWorld.set(position.x, position.y, position.z).applyMatrix4(earth.matrix)

    const time = MakeTime(new Date(t))
    const { vec } = Equator(body, time, site, true, true)
    eclipticToScene(RotateVector(Rotation_EQD_ECT(time), vec), direction)
    direction.normalize().multiplyScalar(distance).add(observerWorld)
    return [direction.x, direction.y, direction.z]
  }
}
