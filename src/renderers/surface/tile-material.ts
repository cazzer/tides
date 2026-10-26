// The streamed tiles' material composer (tides-zmw.9.16): one place where
// each tile's material is built and every globe feature is laid on it, so
// the tiles take the globe's own GLSL (eclipse, cloud shadows, night, terrain
// shadows, colour, glint, haze) the way the globe composes it.
//
// Per tile, in processTileModel (createTileMaterialPlugin, before the fade
// plugin wraps the material at load-model), in this order:
// 1. Phong. The library's TerrainLambertMaterial becomes a
//    TerrainPhongMaterial carrying its maps and scales and the library's own
//    bump chunk (its onBeforeCompile), with the globe's specular colour and
//    shininess and specularStrength 0: in three r180 Lambert's diffuse is
//    Phong's (the same BRDF_Lambert, per fragment), so with no specular the
//    output is the same (headless: within 1/255), and the features that
//    multiply reflectedLight.directSpecular (eclipse, clouds, shadow) or set
//    the strength (the glint) mean on the tiles what they mean on the globe.
//    TilesRenderer gathers the materials and textures it disposes after
//    processTileModel, so the swapped-in one is disposed with the tile; the
//    Lambert, never drawn, is disposed here.
// 2. The live scale, the skirts, the stencil mark and the dissolve
//    (surface-scale.ts prepareSurfaceMaterial, unchanged).
// 3. The base GLSL every feature may read (basePatch()):
//    vertex   surfaceUp      the sphere's up in the ground mesh's frame
//                            (objectNormal, ECEF, through the constant
//                            SURFACE_GROUND_FROM_ECEF), after project_vertex
//    fragment surfaceRay     eye to fragment in the ground's frame, from
//                            Phong's own vViewPosition (view space, from
//                            modelViewMatrix, formed in double) through the
//                            frame's rotation
//             surfaceGround  the point from the ground's centre, scene
//                            units (the eye from the CPU in double, plus
//                            the ray: ~0.5 m)
//             surfaceUp      its direction (the displacement is radial)
//             surfaceGlobeUv the globe's map coordinate, per fragment, so no
//                            interpolation across the antimeridian
//                            (surfaceGlobeUv() mirrors it; the test pins it
//                            to SphereGeometry's uvs), and
//                            surfaceGlobeTex(map, uv), textureGrad with the
//                            wrapped derivatives, as gibsPatch.ts
//             surfaceWorldFromGround()  the ground mesh's world rotation
//             surfaceGeomNormal  view space, before the bump
//             specularStrength 0, and the dissolve's uSurfaceOpacity
//                            (declared just before main())
//    No varyings of its own: a tile has many vertices, and each varying is
//    written per vertex (an up and a ray as varyings cost +0.08 ms at 1080p
//    headless once read; from vViewPosition, +0.05). Whatever no feature
//    reads compiles away (the base alone: +0.00 to +0.02 ms). The frame
//    uniforms are the ground haze's (GroundHaze.frame), filled per camera
//    before anything draws.
// 4. The features (tile-features.ts): a fixed list in EarthRenderer's
//    composePatches order, one module each, composed with composePatches
//    so the injected text lands in the globe's order. Each adapter takes
//    the GlobeLink (surface-link.ts) and returns its patch, or null for
//    none. A feature is switched by uniforms, never by defines: every tile
//    of a tileset compiles one program (the fade plugin's FEATURE_FADE 0/1
//    the only variant), under the composer's cache key.
//
// Rules for a feature: reuse the globe's exported GLSL, renaming its
// identifiers in the snippet text only (vMapUv -> surfaceGlobeUv,
// vCloudGround -> surfaceGround, ...), so globe shaders and production stay
// as they are. No gl_FragDepth and no discard (the dissolve's aside): early
// depth and stencil keep the globe from shading tile pixels. Anything that
// ever reconstructs depth takes depth.glsl (reversed-Z).
//
// Injection: a feature injects after the base's anchors (surfaceInject) or
// after three's chunks (injectAfterChunk). Like three's includes on the
// globe, a later injection at the same anchor lands before an earlier one;
// the base's own code sits above each anchor, so every feature reads it set.
import * as THREE from 'three'
import { composePatches, type MaterialPatch } from '../eclipseShadow'
import { RELIEF } from '../../relief'
import type { GlobeLink } from './surface-link'
import { prepareSurfaceMaterial, surfaceSkirtRange } from './surface-scale'

/** What a feature lays on every tile of a tileset. */
export interface TileFeature {
  /** Shared by every tile (one program): its GLSL and its shared uniforms. */
  patch: MaterialPatch
  /**
   * Per tile, after its material is prepared: uniforms only this tile's
   * material binds (merged over the patch's at compile, which three runs
   * once per material), e.g. a texture per elevation grid. The GLSL that
   * reads them is the patch's, the same for every tile. Keep the returned
   * objects to change their values later.
   */
  onTile?(material: TerrainPhongMaterial, mesh: THREE.Mesh, tile: object): Record<string, THREE.IUniform> | void
}

/** A feature's adapter: its patch on the tiles from the globe's link, or
 * null to lay nothing. */
export type TileAdapter = (link: GlobeLink) => TileFeature | null

/** A slot in the feature list (tile-features.ts). */
export interface TileFeatureSlot {
  name: string
  adapter: TileAdapter
}

/** The globe ground's Phong specular colour (three's default) and
 * shininess (EarthRenderer), for the glint. */
export const GLOBE_SPECULAR = 0x111111
export const GLOBE_SHININESS = 100

/**
 * The tileset's ECEF (Z through the north pole, X through lon 0, Y through
 * lon 90E) to the ground mesh's frame (Y north, lon 0 at +X, east towards
 * -Z): the rotation of applySurfaceFrame (surface-frame.ts; the test pins
 * the two together).
 */
export const SURFACE_GROUND_FROM_ECEF = new THREE.Matrix3().set(1, 0, 0, 0, 0, 1, 0, -1, 0)

const glslMat3 = (m: THREE.Matrix3) => `mat3(${m.elements.map((v) => v.toFixed(1)).join(', ')})`

/** The base's anchors: a feature's code injected after one runs (or is
 * declared) after the base's. */
export const SURFACE_ANCHORS = {
  /** Vertex globals: after three's common and the base's declarations. */
  vertexHead: '// surface-tile: vertex head',
  /** Vertex main: after project_vertex and the base's surfaceUp. */
  vertexBody: '// surface-tile: vertex body',
  /** Fragment globals: after three's common and the base's declarations. */
  fragmentHead: '// surface-tile: fragment head',
  /** Fragment main, early: surfaceRay, surfaceGround, surfaceUp and
   * surfaceGlobeUv set. */
  fragmentBody: '// surface-tile: fragment body',
  /** After specularmap_fragment and the base's specularStrength = 0. */
  specular: '// surface-tile: specular',
} as const

export type SurfaceAnchor = keyof typeof SURFACE_ANCHORS

/** Inserts `code` on the line after the base's `anchor`. */
export function surfaceInject(source: string, anchor: SurfaceAnchor, code: string): string {
  const mark = SURFACE_ANCHORS[anchor]
  if (!source.includes(mark)) throw new Error(`tile material: shader has no ${mark}`)
  return source.replace(mark, `${mark}\n${code}`)
}

/** Inserts `code` after three's `#include <chunk>`, as the globe's patches do. */
export function injectAfterChunk(source: string, chunk: string, code: string, what = 'tile material'): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) throw new Error(`${what}: shader has no ${include}`)
  return source.replace(include, `${include}\n${code}`)
}

/** Replaces `from` (once) in a globe snippet, throwing when it's gone (the
 * globe's GLSL changed under the adapter). */
export function renameInSnippet(snippet: string, from: string, to: string, what = 'tile material'): string {
  if (!snippet.includes(from)) throw new Error(`${what}: snippet has no ${from}`)
  return snippet.replace(from, to)
}

/**
 * The globe map's coordinate (SphereGeometry's uv) of a direction `up` in
 * the ground's frame, as the base GLSL's surfaceGlobeUvAt() takes it.
 */
export function surfaceGlobeUv(up: THREE.Vector3, target = new THREE.Vector2()): THREE.Vector2 {
  const n = up.clone().normalize()
  return target.set(
    0.5 + Math.atan2(-n.z, n.x) / (2 * Math.PI),
    0.5 + Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)) / Math.PI
  )
}

const BASE_VERTEX_HEAD = /* glsl */ `
vec3 surfaceUp;
const mat3 SURFACE_GROUND_FROM_ECEF = ${glslMat3(SURFACE_GROUND_FROM_ECEF)};
const mat3 SURFACE_ECEF_FROM_GROUND = ${glslMat3(SURFACE_GROUND_FROM_ECEF.clone().transpose())};
${SURFACE_ANCHORS.vertexHead}
`

// After project_vertex: objectNormal is the sphere's up (the skirts copy
// it). For a feature's vertex code; unread, it compiles away.
const BASE_VERTEX_BODY = /* glsl */ `
surfaceUp = SURFACE_GROUND_FROM_ECEF * objectNormal;
${SURFACE_ANCHORS.vertexBody}
`

const BASE_FRAGMENT_HEAD = /* glsl */ `
uniform mat3 uSurfaceViewToGround;
uniform vec3 uSurfaceEyeGround;
const mat3 SURFACE_GROUND_FROM_ECEF = ${glslMat3(SURFACE_GROUND_FROM_ECEF)};
const mat3 SURFACE_ECEF_FROM_GROUND = ${glslMat3(SURFACE_GROUND_FROM_ECEF.clone().transpose())};
vec3 surfaceUp;
vec3 surfaceRay;
vec3 surfaceGround;
vec2 surfaceGlobeUv;
vec2 surfaceGlobeDx;
vec2 surfaceGlobeDy;
vec3 surfaceGeomNormal;
// The ground mesh's world rotation (the camera's and the frame's: neither
// Earth's group nor the camera carries a scale).
mat3 surfaceWorldFromGround() {
  return transpose(mat3(viewMatrix)) * transpose(uSurfaceViewToGround);
}
// The globe map's coordinate of a direction in the ground's frame
// (SphereGeometry's uv; surfaceGlobeUv() mirrors it).
vec2 surfaceGlobeUvAt(vec3 up) {
  return vec2(0.5 + atan(-up.z, up.x) * RECIPROCAL_PI2, 0.5 + asin(clamp(up.y, -1.0, 1.0)) * RECIPROCAL_PI);
}
// A globe map at uv (surfaceGlobeUv, or anything with its derivatives),
// filtered for the pixel's footprint without the antimeridian's jump.
vec4 surfaceGlobeTex(sampler2D map, vec2 uv) {
  return textureGrad(map, uv, surfaceGlobeDx, surfaceGlobeDy);
}
${SURFACE_ANCHORS.fragmentHead}
`

// Early in main (after clipping), in uniform control flow for the
// derivatives; unread values compile away.
const BASE_FRAGMENT_BODY = /* glsl */ `
surfaceRay = uSurfaceViewToGround * -vViewPosition;
surfaceGround = uSurfaceEyeGround + surfaceRay;
surfaceUp = normalize(surfaceGround);
surfaceGlobeUv = surfaceGlobeUvAt(surfaceUp);
surfaceGlobeDx = dFdx(surfaceGlobeUv);
surfaceGlobeDy = dFdy(surfaceGlobeUv);
surfaceGlobeDx.x -= floor(surfaceGlobeDx.x + 0.5);
surfaceGlobeDy.x -= floor(surfaceGlobeDy.x + 0.5);
${SURFACE_ANCHORS.fragmentBody}
`

const BASE_NORMAL = /* glsl */ `
surfaceGeomNormal = normal;
`

// No specular unless a feature (the glint) sets it below the anchor.
const BASE_SPECULAR = /* glsl */ `
specularStrength = 0.0;
${SURFACE_ANCHORS.specular}
`

/** The base GLSL (header, step 3) on `frame`'s uniforms (the haze's). */
export function basePatch(frame: GlobeLink['haze']['frame'] | null): MaterialPatch {
  const uniforms = {
    uSurfaceViewToGround: frame?.uGroundHazeViewToLocal ?? { value: new THREE.Matrix3() },
    uSurfaceEyeGround: frame?.uGroundHazeEyeLocal ?? { value: new THREE.Vector3() },
  }
  return {
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = injectAfterChunk(
        injectAfterChunk(shader.vertexShader, 'common', BASE_VERTEX_HEAD),
        'project_vertex',
        BASE_VERTEX_BODY
      )
      let fragment = injectAfterChunk(shader.fragmentShader, 'common', BASE_FRAGMENT_HEAD)
      fragment = injectAfterChunk(fragment, 'clipping_planes_fragment', BASE_FRAGMENT_BODY)
      fragment = injectAfterChunk(fragment, 'normal_fragment_begin', BASE_NORMAL)
      fragment = injectAfterChunk(fragment, 'specularmap_fragment', BASE_SPECULAR)
      shader.fragmentShader = fragment
    },
    customProgramCacheKey: () => 'surface-base',
  }
}

/**
 * The library's tile material as Phong (header, step 1): its maps, scales
 * and bump chunk, the globe's specular colour and shininess, no emissive.
 */
export class TerrainPhongMaterial extends THREE.MeshPhongMaterial {
  readonly isTerrainPhongMaterial = true

  constructor(terrain: THREE.MeshLambertMaterial) {
    // type stays MeshPhongMaterial: three picks the shader by it.
    super()
    this.color.copy(terrain.color)
    this.map = terrain.map
    this.displacementMap = terrain.displacementMap
    this.displacementScale = terrain.displacementScale
    this.displacementBias = terrain.displacementBias
    this.bumpMap = terrain.bumpMap
    this.bumpScale = terrain.bumpScale
    this.side = terrain.side
    this.emissive.setScalar(0)
    this.specular.setHex(GLOBE_SPECULAR)
    this.shininess = GLOBE_SHININESS
    // The library's bump chunk (TerrainLambertMaterial's onBeforeCompile, a
    // string replace that reads nothing of its material).
    const bumpChunk = terrain.onBeforeCompile
    this.onBeforeCompile = (shader, renderer) => bumpChunk.call(this, shader, renderer)
  }
}

export interface TileComposer {
  /** The program cache key every tile of the tileset compiles under. */
  readonly key: string
  /** The features laid on, by slot name, in order. */
  readonly features: readonly string[]
  /** The base and the features, composed (after the scale's patch). */
  readonly patch: MaterialPatch
  /**
   * Builds `mesh`'s material (header, steps 1 to 4) for its `tile`, whose
   * elevation range (the skirt lift's) is `skirtRangeMetres`.
   */
  prepare(mesh: THREE.Mesh, tile: object, skirtRangeMetres?: number): void
}

/** The tiles' composer on `link` with the features in `slots` (tile-features.ts
 * TILE_FEATURES); with no link, the base alone. */
export function createTileComposer(link: GlobeLink | null, slots: readonly TileFeatureSlot[] = []): TileComposer {
  const active: { name: string; feature: TileFeature }[] = []
  if (link) {
    for (const { name, adapter } of slots) {
      const feature = adapter(link)
      if (feature) active.push({ name, feature })
    }
  }
  const patch = composePatches(basePatch(link?.haze.frame ?? null), ...active.map(({ feature }) => feature.patch))
  const key = `surface-tile:${patch.customProgramCacheKey()}`
  const hooks = active.flatMap(({ feature }) => (feature.onTile ? [feature] : []))
  return {
    key,
    features: active.map(({ name }) => name),
    patch,
    prepare(mesh, tile, skirtRangeMetres = 0) {
      const built: { material: TerrainPhongMaterial; own: Record<string, THREE.IUniform> }[] = []
      const swap = (old: THREE.Material) => {
        const material = new TerrainPhongMaterial(old as THREE.MeshLambertMaterial)
        old.dispose()
        // Filled by the hooks below; read when three compiles the tile.
        const own: Record<string, THREE.IUniform> = {}
        const tileUniforms: MaterialPatch = {
          onBeforeCompile(shader) {
            Object.assign(shader.uniforms, own)
          },
          customProgramCacheKey: () => '',
        }
        prepareSurfaceMaterial(material, hooks.length ? [patch, tileUniforms] : [patch], skirtRangeMetres)
        material.customProgramCacheKey = () => key
        built.push({ material, own })
        return material
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material)
      // With the mesh drawing its new material.
      for (const { material, own } of built) {
        for (const feature of hooks) Object.assign(own, feature.onTile!(material, mesh, tile) ?? {})
      }
    },
  }
}

/**
 * A 3d-tiles-renderer plugin that builds each tile's materials as the tile
 * parses (processTileModel runs in parseTile, before the load-model event
 * the fade plugin wraps materials at).
 */
export function createTileMaterialPlugin(composer: TileComposer, relief: number = RELIEF) {
  return {
    name: 'SURFACE_SCALE',
    processTileModel(scene: THREE.Object3D, tile: { geometricError?: number }) {
      const meshes: THREE.Mesh[] = []
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.isMesh && mesh.material) meshes.push(mesh)
      })
      for (const mesh of meshes) {
        composer.prepare(mesh, tile ?? {}, surfaceSkirtRange(mesh.geometry, tile?.geometricError ?? 0, relief))
      }
    },
  }
}
