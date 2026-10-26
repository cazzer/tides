// The streamed tiles' material composer (tides-zmw.9.16), checked on the
// library's own tile material and geometry and the globe's own patches.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { TerrainLambertMaterial } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/TerrainLambertMaterial.js'
import { SkirtedPlaneGeometry } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/SkirtedPlaneGeometry.js'
import { wrapFadeMaterial } from '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js'
import { RELIEF } from '../../relief'
import { terrainScaleUniform } from '../../terrain-scale'
import { createEclipseShadow, ECLIPSE_GLSL } from '../eclipseShadow'
import { createGroundHaze } from '../groundHaze'
import { applySurfaceFrame, ecefToEarthLocal, SURFACE_SCALE, surfaceEcef } from './surface-frame'
import type { GlobeLink } from './surface-link'
import { SURFACE_STENCIL_REF, SURFACE_VERTEX_COUNT } from './surface-scale'
import { TILE_ECLIPSE_GLSL } from './tile-eclipse'
import { TILE_FEATURES } from './tile-features'
import {
  createTileComposer,
  createTileMaterialPlugin,
  GLOBE_SHININESS,
  GLOBE_SPECULAR,
  SURFACE_ANCHORS,
  SURFACE_GROUND_FROM_ECEF,
  surfaceGlobeUv,
  surfaceInject,
  TerrainPhongMaterial,
  type TileAdapter,
} from './tile-material'

/** What three hands onBeforeCompile for a Phong material (chunks unresolved). */
function phongShader(): THREE.WebGLProgramParametersWithUniforms {
  return {
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
  } as unknown as THREE.WebGLProgramParametersWithUniforms
}

const renderer = {} as THREE.WebGLRenderer

function compiled(material: THREE.Material) {
  const shader = phongShader()
  material.onBeforeCompile(shader, renderer)
  return shader
}

/** A link with the globe's real haze and eclipse; the rest placeholders. */
function fakeLink(): GlobeLink {
  const sunDir = { value: new THREE.Vector3(1, 0, 0) }
  const texture = new THREE.Texture()
  return {
    haze: createGroundHaze(sunDir, 2.95, false),
    sunDir,
    clouds: { uniforms: {} as GlobeLink['clouds']['uniforms'], flat: false },
    eclipse: createEclipseShadow('earth').uniforms,
    nightFlight: null,
    gibs: { onBeforeCompile() {}, customProgramCacheKey: () => '' },
    gibsNight: { onBeforeCompile() {}, customProgramCacheKey: () => '' },
    maps: { day: texture, specular: texture, night: texture },
    horizon: { map: { value: new THREE.DataArrayTexture() }, code: { value: new THREE.Vector2() } },
    seaLevel: 2.95,
  }
}

function tileMesh(geometry: THREE.BufferGeometry = new THREE.BufferGeometry()) {
  const lambert = new TerrainLambertMaterial()
  const grid = new THREE.DataTexture(new Float32Array(4), 2, 2, THREE.RedFormat, THREE.FloatType)
  lambert.map = new THREE.Texture()
  lambert.displacementMap = grid
  lambert.bumpMap = grid
  lambert.displacementScale = RELIEF
  lambert.bumpScale = RELIEF
  return new THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>(geometry, lambert)
}

describe('the tiles\' frame (tides-zmw.9.16)', () => {
  it('turns ECEF into the ground mesh\'s frame as the tiles\' group does', () => {
    const group = new THREE.Object3D()
    applySurfaceFrame(group)
    const rotation = new THREE.Matrix3().setFromMatrix4(group.matrix).multiplyScalar(1 / SURFACE_SCALE)
    for (let i = 0; i < 9; i++) expect(rotation.elements[i]).toBeCloseTo(SURFACE_GROUND_FROM_ECEF.elements[i], 12)
    // North up, lon 0 at +X, east towards -Z.
    expect(new THREE.Vector3(0, 0, 1).applyMatrix3(SURFACE_GROUND_FROM_ECEF).distanceTo(new THREE.Vector3(0, 1, 0))).toBe(0)
    expect(new THREE.Vector3(0, 1, 0).applyMatrix3(SURFACE_GROUND_FROM_ECEF).distanceTo(new THREE.Vector3(0, 0, -1))).toBe(0)
  })

  it('reads the globe map per fragment at SphereGeometry\'s uvs', () => {
    const sphere = new THREE.SphereGeometry(1, 72, 36)
    const position = sphere.getAttribute('position')
    const uv = sphere.getAttribute('uv')
    const p = new THREE.Vector3()
    const at = new THREE.Vector2()
    let checked = 0
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i)
      if (Math.abs(p.y) > 1 - 1e-9) continue // the poles: any u
      surfaceGlobeUv(p, at)
      // The seam's u = 0 column is u = 1 per fragment.
      const du = at.x - uv.getX(i)
      expect(du - Math.round(du)).toBeCloseTo(0, 6)
      expect(at.y).toBeCloseTo(uv.getY(i), 6)
      checked++
    }
    expect(checked).toBeGreaterThan(2000)
    // The GLSL is the same formula.
    const shader = compiled(composerMaterial())
    expect(shader.fragmentShader).toContain(
      'return vec2(0.5 + atan(-up.z, up.x) * RECIPROCAL_PI2, 0.5 + asin(clamp(up.y, -1.0, 1.0)) * RECIPROCAL_PI);'
    )
  })
})

function composerMaterial(link: GlobeLink | null = fakeLink()) {
  const mesh = tileMesh()
  createTileComposer(link, TILE_FEATURES).prepare(mesh, {})
  return mesh.material as TerrainPhongMaterial
}

describe('the Phong swap (tides-zmw.9.16)', () => {
  it('carries the library material\'s maps and bump chunk, with no specular', () => {
    const mesh = tileMesh()
    const lambert = mesh.material as THREE.MeshLambertMaterial
    const disposed = vi.fn()
    lambert.addEventListener('dispose', disposed)
    createTileComposer(null).prepare(mesh, {}, 0)
    const phong = mesh.material as TerrainPhongMaterial
    expect(phong).toBeInstanceOf(TerrainPhongMaterial)
    expect(phong.isMeshPhongMaterial).toBe(true)
    expect(phong.type).toBe('MeshPhongMaterial')
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(phong.map).toBe(lambert.map)
    expect(phong.displacementMap).toBe(lambert.displacementMap)
    expect(phong.bumpMap).toBe(lambert.bumpMap)
    // prepareSurfaceMaterial: metres and scene units, the stencil mark.
    expect(phong.displacementScale).toBe(1)
    expect(phong.bumpScale).toBe(SURFACE_SCALE)
    expect(phong.stencilRef).toBe(SURFACE_STENCIL_REF)
    expect(phong.specular.getHex()).toBe(GLOBE_SPECULAR)
    expect(phong.shininess).toBe(GLOBE_SHININESS)
    expect(phong.emissive.getHex()).toBe(0)
    const shader = compiled(phong)
    // The library's bump chunk, on the live scale.
    expect(shader.fragmentShader).toContain('DEGENERATE_DET_EPSILON')
    expect(shader.fragmentShader).toContain('float dBx = bumpScale * uTerrainScale * ( gradU * dSTdx.x + gradV * dSTdx.y );')
    expect(shader.fragmentShader).not.toContain('#include <bumpmap_pars_fragment>')
    // No specular after three's chunk sets its strength.
    expect(shader.fragmentShader).toContain('#include <specularmap_fragment>\n\nspecularStrength = 0.0;\n' + SURFACE_ANCHORS.specular)
    expect(shader.uniforms.uTerrainScale).toBe(terrainScaleUniform)
  })
})

describe('the composer (tides-zmw.9.16)', () => {
  it('lists the features in the globe\'s composePatches order', () => {
    expect(TILE_FEATURES.map((s) => s.name)).toEqual(['eclipse', 'clouds', 'night', 'colour', 'shadow', 'glint', 'haze'])
  })

  it('applies the base, then the features in order, skipping nulls, under one key', () => {
    const order: string[] = []
    const feature = (name: string): TileAdapter => () => ({
      patch: {
        onBeforeCompile(shader) {
          order.push(name)
          // Every anchor is there, after the base's code.
          shader.fragmentShader = surfaceInject(shader.fragmentShader, 'fragmentBody', `// feature ${name}`)
        },
        customProgramCacheKey: () => name,
      },
    })
    const composer = createTileComposer(fakeLink(), [
      { name: 'a', adapter: feature('a') },
      { name: 'b', adapter: () => null },
      { name: 'c', adapter: feature('c') },
    ])
    expect(composer.features).toEqual(['a', 'c'])
    expect(composer.key).toBe('surface-tile:surface-base+a+c')
    const mesh = tileMesh()
    composer.prepare(mesh, {})
    const material = mesh.material as THREE.Material
    const shader = compiled(material)
    expect(order).toEqual(['a', 'c'])
    expect(material.customProgramCacheKey()).toBe(composer.key)
    // As three's includes on the globe: the later injection first.
    const f = shader.fragmentShader
    expect(f.indexOf('surfaceGlobeUv = surfaceGlobeUvAt(surfaceUp);')).toBeLessThan(f.indexOf(SURFACE_ANCHORS.fragmentBody))
    expect(f.indexOf(SURFACE_ANCHORS.fragmentBody)).toBeLessThan(f.indexOf('// feature c'))
    expect(f.indexOf('// feature c')).toBeLessThan(f.indexOf('// feature a'))
  })

  it('lays the eclipse and the haze on the real link, the rest stubs', () => {
    const composer = createTileComposer(fakeLink(), TILE_FEATURES)
    expect(composer.features).toEqual(['eclipse', 'haze'])
    expect(composer.key).toBe('surface-tile:surface-base+eclipse-surface+ground-haze-surface')
    expect(createTileComposer(null, TILE_FEATURES).key).toBe('surface-tile:surface-base')
  })

  it('declares each base anchor once and every name before its first use', () => {
    const shader = compiled(composerMaterial())
    for (const [stage, anchors] of [
      [shader.vertexShader, ['vertexHead', 'vertexBody']],
      [shader.fragmentShader, ['fragmentHead', 'fragmentBody', 'specular']],
    ] as const) {
      for (const a of anchors) expect(stage.split(SURFACE_ANCHORS[a]), a).toHaveLength(2)
    }
    const v = shader.vertexShader
    expect(v.indexOf('#include <project_vertex>')).toBeLessThan(v.indexOf('surfaceUp = SURFACE_GROUND_FROM_ECEF * objectNormal;'))
    // The base adds no varyings (each costs a write per vertex).
    expect(v.replace(THREE.ShaderLib.phong.vertexShader, '')).not.toMatch(/varying vec[234] (vSurface|vEclipse)/)
    const f = shader.fragmentShader
    expect(f).not.toContain('vEclipsePoint')
    expect(f.indexOf('surfaceRay = uSurfaceViewToGround * -vViewPosition;')).toBeLessThan(f.indexOf('surfaceUp = normalize(surfaceGround);'))
    expect(f.indexOf('mat3 surfaceWorldFromGround()')).toBeLessThan(f.indexOf('surfaceWorldFromGround() * eclipseP'))
    expect(f.indexOf('vec2 eclipseSunlight(vec3 point)')).toBeLessThan(f.indexOf('void main'))
    expect(f.indexOf('uniform float uEclipseActive;')).toBeLessThan(f.indexOf('void main'))
    expect(f.indexOf('surfaceUp = normalize(surfaceGround);')).toBeLessThan(f.indexOf('eclipseSunlight(eclipsePoint(surfaceUp))'))
    expect(f.indexOf('#include <lights_fragment_end>')).toBeLessThan(f.indexOf('reflectedLight.directSpecular *= eclipse.x;'))
    expect(f.indexOf('#include <normal_fragment_begin>\n\nsurfaceGeomNormal = normal;')).toBeGreaterThan(0)
    // The haze's text as tides-zmw.9.7 laid it, on the same frame uniforms.
    expect(f).toContain('vec4 haze = groundHaze(vGroundHazeEye, vGroundHazeRay, cover);')
    expect(v).toContain('vGroundHazeRay = uGroundHazeViewToLocal * mvPosition.xyz;')
    expect(shader.uniforms.uSurfaceViewToGround).toBe(shader.uniforms.uGroundHazeViewToLocal)
    expect(shader.uniforms.uEclipseActive).toBeDefined()
    expect(shader.uniforms.uSurfaceEyeGround).toBe(shader.uniforms.uGroundHazeEyeLocal)
  })

  it('binds per-tile uniforms through onTile, the shared ones for every tile', () => {
    const shared = { value: 1 }
    const composer = createTileComposer(fakeLink(), [
      {
        name: 'grid',
        adapter: () => ({
          patch: {
            onBeforeCompile(shader) {
              shader.uniforms.uShared = shared
            },
            customProgramCacheKey: () => 'grid',
          },
          onTile: (material, mesh, tile) => ({ uGrid: { value: (tile as { id: number }).id }, uSame: { value: mesh.material === material } }),
        }),
      },
    ])
    const [a, b] = [tileMesh(), tileMesh()]
    composer.prepare(a, { id: 1 })
    composer.prepare(b, { id: 2 })
    const [sa, sb] = [compiled(a.material as THREE.Material), compiled(b.material as THREE.Material)]
    expect(sa.uniforms.uGrid.value).toBe(1)
    expect(sb.uniforms.uGrid.value).toBe(2)
    expect(sa.uniforms.uSame.value).toBe(true)
    expect(sa.uniforms.uShared).toBe(shared)
    expect(sb.uniforms.uShared).toBe(shared)
    expect(sa.uniforms.uSkirtRange).not.toBe(sb.uniforms.uSkirtRange)
  })

  it('survives the fade wrapper (unbound, no renderer), keeping its key', () => {
    const material = composerMaterial()
    const params = wrapFadeMaterial(material, material.onBeforeCompile)
    const shader = phongShader()
    const run = material.onBeforeCompile
    expect(() => run(shader, undefined as unknown as THREE.WebGLRenderer)).not.toThrow()
    expect(shader.uniforms.fadeIn).toBe(params.fadeIn)
    expect(shader.fragmentShader).toContain('if ( dither >= fadeIn )')
    expect(shader.fragmentShader).toContain('reflectedLight.directDiffuse *= vec3(eclipse.x) + glow;')
    expect(material.customProgramCacheKey()).toMatch(/^surface-tile:/)
  })
})

describe('the tile material plugin (tides-zmw.9.16)', () => {
  it('builds every mesh of a parsed tile in processTileModel', () => {
    const plugin = createTileMaterialPlugin(createTileComposer(null))
    const [a, b] = [tileMesh(), tileMesh()]
    plugin.processTileModel(new THREE.Group().add(a, new THREE.Group().add(b)), {})
    for (const m of [a, b]) {
      expect(m.material).toBeInstanceOf(TerrainPhongMaterial)
      expect((m.material as THREE.MeshPhongMaterial).displacementScale).toBe(1)
      expect((m.material as THREE.MeshPhongMaterial).stencilRef).toBe(SURFACE_STENCIL_REF)
    }
  })

  it('lifts the skirts from the full relief\'s depth to the live scale\'s, each tile by its own range', () => {
    // A tile's geometry as the plugin leaves it: surface on the sphere, skirt
    // vertices dropped geometricError + range x RELIEF along the normal.
    const geometry = new SkirtedPlaneGeometry(1, 1, 32, 32)
    const position = geometry.getAttribute('position')
    const geometricError = 150
    const range = 1800
    for (let k = 0; k < geometry.skirtSourceIndices.length; k++) {
      const src = geometry.skirtSourceIndices[k]
      position.setXYZ(geometry.surfaceVertexCount + k, position.getX(src), position.getY(src), position.getZ(src) - (geometricError + range * RELIEF))
    }
    const composer = createTileComposer(null)
    const [a, b] = [tileMesh(geometry), tileMesh()]
    createTileMaterialPlugin(composer).processTileModel(new THREE.Group().add(a), { geometricError })
    composer.prepare(b, {})
    const sa = compiled(a.material as THREE.Material)
    const sb = compiled(b.material as THREE.Material)
    expect(sa.uniforms.uSkirtRange.value).toBeCloseTo(range, 2)
    expect(sb.uniforms.uSkirtRange.value).toBe(0)
    expect(sa.vertexShader).toContain(
      `if ( gl_VertexID >= ${SURFACE_VERTEX_COUNT} ) transformed += normalize( objectNormal ) * uSkirtRange * ( ${RELIEF.toFixed(6)} - uTerrainScale );`
    )
  })
})

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
