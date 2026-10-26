// The Moon's shadow on the streamed tiles (tides-zmw.9.16): the globe's
// GLSL by rename, and the point and rotation it finds.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ECLIPSE_GLSL } from '../eclipseShadow'
import { applySurfaceFrame, ecefToEarthLocal, SURFACE_SCALE, surfaceEcef } from './surface-frame'
import { tileEclipse, TILE_ECLIPSE_GLSL } from './tile-eclipse'
import { createTileComposer, SURFACE_ANCHORS, type TerrainPhongMaterial } from './tile-material'
import { compiled, fakeLink, tileMesh } from './tile-test-fixtures'

describe('the eclipse on the tiles (tides-zmw.9.16)', () => {
  it('takes the globe\'s GLSL, renaming only the point\'s rotation and direction, and its varying out', () => {
    const point = ECLIPSE_GLSL.vertexHead
      .replace('varying vec3 vEclipsePoint;', '')
      .replace('mat3(modelMatrix) * eclipseP / length(modelMatrix[0].xyz)', 'surfaceWorldFromGround() * eclipseP')
    const shading = ECLIPSE_GLSL.fragmentHead.replace('varying vec3 vEclipsePoint;', '')
    expect(TILE_ECLIPSE_GLSL.fragmentHead).toBe(`${point}\n${shading}`)
    expect(TILE_ECLIPSE_GLSL.fragmentLight).toBe(
      ECLIPSE_GLSL.fragmentLight.replace('eclipseSunlight(vEclipsePoint)', 'eclipseSunlight(eclipsePoint(surfaceUp))')
    )
  })

  it('lays the shading per fragment after the lights, on the eclipse\'s uniforms, with no varying', () => {
    const link = fakeLink()
    const mesh = tileMesh()
    const composer = createTileComposer(link, [{ name: 'eclipse', adapter: tileEclipse }])
    expect(composer.key).toBe('surface-tile:surface-base+eclipse-surface')
    composer.prepare(mesh, {})
    const shader = compiled(mesh.material as TerrainPhongMaterial)
    const f = shader.fragmentShader
    expect(f).not.toContain('vEclipsePoint')
    expect(shader.vertexShader).not.toContain('eclipse')
    expect(f.indexOf(SURFACE_ANCHORS.fragmentHead)).toBeLessThan(f.indexOf('surfaceWorldFromGround() * eclipseP'))
    expect(f.indexOf('vec2 eclipseSunlight(vec3 point)')).toBeLessThan(f.indexOf('void main'))
    expect(f.indexOf('surfaceUp = normalize(surfaceGround);')).toBeLessThan(f.indexOf('eclipseSunlight(eclipsePoint(surfaceUp))'))
    expect(f.indexOf('#include <lights_fragment_end>')).toBeLessThan(f.indexOf('reflectedLight.directSpecular *= eclipse.x;'))
    for (const name of Object.keys(link.eclipse)) expect(shader.uniforms[name], name).toBe(link.eclipse[name])
  })

  it('finds the point and the rotation the globe finds for the same ground', () => {
    // eclipsePoint()'s ellipsoid point of a direction in the ground's frame (km).
    const a = 6378.137
    const e2 = 0.00669438
    const ellipsoid = (d: THREE.Vector3) => {
      const n = d.clone().normalize()
      const N = a / Math.sqrt(1 - e2 * n.y * n.y)
      return new THREE.Vector3(n.x, n.y * (1 - e2), n.z).multiplyScalar(N)
    }
    // Earth's group somewhere in the scene, tilted and spun; a camera near
    // the ground; the haze's frame filled as EarthRenderer fills it.
    const earth = new THREE.Object3D()
    earth.position.set(812.4, -3.2, 455.9)
    earth.quaternion.setFromEuler(new THREE.Euler(0.41, 2.3, -0.2))
    const ground = new THREE.Mesh()
    const tiles = new THREE.Group()
    applySurfaceFrame(tiles)
    const tile = new THREE.Mesh()
    const centre = surfaceEcef(36.1, -112.1, 0)
    tile.position.copy(centre) // its bounding-sphere centre, ECEF metres
    earth.add(ground, tiles)
    tiles.add(tile)
    const camera = new THREE.PerspectiveCamera()
    earth.add(camera)
    camera.position.copy(ecefToEarthLocal(surfaceEcef(36.0, -112.0, 9000)))
    camera.lookAt(new THREE.Vector3(5, 2, -1))
    earth.updateMatrixWorld(true)
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    const link = fakeLink()
    link.haze.update(ground, camera)
    const { uGroundHazeViewToLocal: viewToGround, uGroundHazeEyeLocal: eye } = link.haze.frame
    // surfaceWorldFromGround(): transpose(mat3(viewMatrix)) * transpose(uSurfaceViewToGround).
    const worldFromGround = new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse).transpose().multiply(viewToGround.value.clone().transpose())
    const groundRotation = new THREE.Matrix3().setFromMatrix4(ground.matrixWorld)
    for (let i = 0; i < 9; i++) expect(worldFromGround.elements[i]).toBeCloseTo(groundRotation.elements[i], 9)
    for (const [lat, lon, h] of [[36.1, -112.1, 2100], [36.2, -112.3, 800], [35.9, -111.8, 0]]) {
      // A displaced vertex in the tile's frame, and Phong's vViewPosition of it.
      const local = surfaceEcef(lat, lon, h).sub(centre)
      const view = local.clone().applyMatrix4(tile.matrixWorld).applyMatrix4(camera.matrixWorldInverse)
      const surfaceGround = eye.value.clone().add(view.clone().applyMatrix3(viewToGround.value))
      const truth = ecefToEarthLocal(surfaceEcef(lat, lon, h))
      expect(surfaceGround.distanceTo(truth) / SURFACE_SCALE).toBeLessThan(0.01) // metres
      const up = surfaceGround.clone().normalize()
      expect(up.angleTo(ecefToEarthLocal(surfaceEcef(lat, lon, 0)))).toBeLessThan(1e-7) // acos's floor
      // The globe's point for the same ground: its direction through the ground's rotation.
      const globe = ellipsoid(truth).applyMatrix3(groundRotation)
      const onTiles = ellipsoid(up).applyMatrix3(worldFromGround)
      expect(onTiles.distanceTo(globe)).toBeLessThan(1e-3) // km
    }
  })
})
