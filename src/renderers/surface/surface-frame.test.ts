import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Ellipsoid } from '3d-tiles-renderer/three'
import { EARTH_RADIUS } from '../../ship/ship-bodies'
import { calculateLocationAndRotationForLatLng } from '../../utils'
import {
  applySurfaceFrame,
  ecefToEarthLocal,
  SURFACE_ELLIPSOID_RADIUS,
  SURFACE_FRAME_PRIORITY,
  SURFACE_SCALE,
  surfaceEcef,
} from './surface-frame'

const PLACES: [string, number, number][] = [
  ['Grand Canyon', 36.1, -112.1],
  ['Null Island', 0, 0],
  ['Everest', 27.988, 86.925],
  ['Cape Horn', -55.98, -67.27],
  ['near the north pole', 89.5, 140],
  ['dateline', -12, 179.9],
]

describe('surface frame (tides-zmw.9.1)', () => {
  it('scales the tileset from metres to scene units at the globe radius', () => {
    expect(SURFACE_SCALE).toBeCloseTo(EARTH_RADIUS / 6371000, 15)
    expect(SURFACE_SCALE * SURFACE_ELLIPSOID_RADIUS).toBeCloseTo(EARTH_RADIUS, 12)
    expect(SURFACE_SCALE).toBeCloseTo(4.632e-7, 9)
  })

  it('turns the tileset ECEF frame to Earth-local Y north', () => {
    const group = new THREE.Group()
    applySurfaceFrame(group)
    expect(group.rotation.x).toBeCloseTo(-Math.PI / 2, 15)
    expect(group.scale.x).toBe(SURFACE_SCALE)
    // ECEF +Z (north pole) -> local +Y; ECEF +Y (lon 90E) -> local -Z
    const north = new THREE.Vector3(0, 0, 1).applyMatrix4(group.matrix).normalize()
    const east90 = new THREE.Vector3(0, 1, 0).applyMatrix4(group.matrix).normalize()
    expect(north.y).toBeCloseTo(1, 12)
    expect(east90.z).toBeCloseTo(-1, 12)
  })

  it('puts a lat/lon where the globe puts it, to 1e-9 scene units', () => {
    const group = new THREE.Group()
    applySurfaceFrame(group)
    const ellipsoid = new Ellipsoid(SURFACE_ELLIPSOID_RADIUS, SURFACE_ELLIPSOID_RADIUS, SURFACE_ELLIPSOID_RADIUS)
    const D = Math.PI / 180
    for (const [name, lat, lon] of PLACES) {
      const globe = calculateLocationAndRotationForLatLng(lat, lon, EARTH_RADIUS).position
      const want = new THREE.Vector3(globe.x, globe.y, globe.z)
      const viaGroup = surfaceEcef(lat, lon, 0).applyMatrix4(group.matrix)
      const viaLibrary = ellipsoid.getCartographicToPosition(lat * D, lon * D, 0, new THREE.Vector3()).applyMatrix4(group.matrix)
      const viaHelper = ecefToEarthLocal(surfaceEcef(lat, lon, 0))
      expect(viaGroup.distanceTo(want), name).toBeLessThan(1e-9)
      expect(viaLibrary.distanceTo(want), name).toBeLessThan(1e-9)
      expect(viaHelper.distanceTo(want), name).toBeLessThan(1e-9)
    }
  })

  it('updates after the camera and spin (0) and before the View renders (1)', () => {
    expect(SURFACE_FRAME_PRIORITY).toBeGreaterThan(0)
    expect(SURFACE_FRAME_PRIORITY).toBeLessThan(1)
  })
})
