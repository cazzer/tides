// The streamed tiles on the globe's live terrain scale, and their handover
// from the globe (tides-zmw.9.7).
//
// Scale. 3d-tiles-renderer 0.5.3's terrain plugin doesn't bake height into
// the tiles' vertices: every surface vertex sits on the ellipsoid at height
// 0 (with the sphere's normal), and the GPU displaces it by the material's
// displacementMap (the elevation grid, metres) times displacementScale (the
// plugin's heightScale); the bump shading reads the same grid. Its
// heightScale setter (~6.7 ms) visits every loaded material and refits every
// tile's bounding volume, so it is never called after construction. Instead
// the plugin is built at the page's RELIEF, which sizes the skirts for the
// largest scale the blend reaches (the bounds: below), and each tile material
// is patched (SurfaceScalePlugin, at processTileModel, before the fade
// plugin wraps it at load-model) to read terrainScaleUniform, the uniform
// object the globe's displacement reads: displacementScale becomes 1 (metres)
// times uTerrainScale, bumpScale SURFACE_SCALE (metres to scene units, see
// surface-frame.ts) times uTerrainScale. A scale change is one uniform write:
// no per-tile work and no recompiles.
//
// Bounds. Sized for RELIEF everywhere, a tile's bounding region stood up to
// 12x its true relief over the ground, so near the ground the eye sat inside
// the regions of the tiles around it, whose error the library then takes as
// infinite: twice the tiles at the stop over the canyon, and tile-sized
// holes near the eye (the globe filled them), both gone with the regions
// fitted to the live scale (headless, tides-zmw.9.7). So the regions follow the live scale after all, but lazily and stepwise
// (fitSurfaceBounds()): fitted to the scale rounded up to a power of
// SURFACE_FIT_STEP (never under the drawn ground), each tile refitted the
// next time the traversal visits it after the step changes; ~11 steps from
// 12x to 1x, not one per frame, and never the setter's whole-tree walk.
//
// Handover, by stencil. The tiles draw first (their group's renderOrder -1)
// and mark every pixel they draw (stencil ref 1); the globe, when the tiles
// are mounted, draws only where the stencil isn't 1 (globeStencil()). So each
// pixel is tile or globe, never both: no z-fighting at any scale or DEM
// mismatch, and the globe still draws wherever no tile landed (not loaded
// yet, failed, or above the handover). Over the top of the blend the tiles
// dissolve out on an 8x8 Bayer screen-door (surfaceOpacityUniform); a
// discarded fragment writes no stencil, so the globe fills it. Not the fade
// plugin's 4x4: its 16 levels switched a sixteenth of the screen at once,
// a ~3/255 luma step every few frames of a descent while the tiles' colour
// differs from the globe's (headless, tides-zmw.9.7); 64 levels quarter it.
// The 8x8's thresholds nest in the 4x4's, so with a tile's own fade the two
// still keep about the smaller share.
import * as THREE from 'three'
import type { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { surfaceOpacityUniform, terrainScaleUniform } from '../../terrain-scale'
import type { MaterialPatch } from '../eclipseShadow'
import { RELIEF } from '../../relief'
import { SURFACE_SCALE } from './surface-frame'

/** The stencil value a tile fragment leaves, which hides the globe there. */
export const SURFACE_STENCIL_REF = 1

/**
 * The library's SkirtedPlaneGeometry(1, 1, 32, 32) surface vertex count
 * (33²): the vertices from here on are the skirts' (a test pins it).
 */
export const SURFACE_VERTEX_COUNT = 33 * 33

// three r180's displacementmap_vertex, displacementScale times the live
// scale (the test pins the chunk it stands in for). objectNormal is the
// sphere's normal, so the height above the sphere scales radially.
export const DISPLACEMENT_VERTEX = /* glsl */ `
#ifdef USE_DISPLACEMENTMAP
  transformed += normalize( objectNormal ) * ( texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale * uTerrainScale + displacementBias );
#endif
`

// TerrainLambertMaterial's dHdxy_fwd() (the library's bump chunk), its
// height gradient times the live scale.
const BUMP_X = 'float dBx = bumpScale *'
const BUMP_Y = 'float dBy = bumpScale *'

// The skirts: the plugin drops each tile's edge vertices (from
// SURFACE_VERTEX_COUNT on) geometricError + range x RELIEF along the normal,
// enough to close cracks at the largest scale; at the live scale they need
// only range x uTerrainScale of it, and beside a hole (tiles not loaded, the
// globe showing) the rest stood as a curtain. Lift them by the difference.
const skirtLift = (relief: number) => /* glsl */ `
if ( gl_VertexID >= ${SURFACE_VERTEX_COUNT} ) transformed += normalize( objectNormal ) * uSkirtRange * ( ${relief.toFixed(6)} - uTerrainScale );
`

// The fade plugin's 4x4 pattern (wrapFadeMaterial.js) refined to 8x8: each
// 4x4 level split in four by the 2x2 block it falls in.
const DISSOLVE_HEAD = /* glsl */ `
uniform float uSurfaceOpacity;
float surfaceBayer2(vec2 v) { return mod(3.0 * v.y + 2.0 * v.x, 4.0); }
float surfaceBayer4(vec2 v) { return 4.0 * surfaceBayer2(mod(v, 2.0)) + surfaceBayer2(floor(0.5 * mod(v, 4.0))); }
float surfaceBayer8(vec2 v) { return 4.0 * surfaceBayer4(mod(v, 4.0)) + surfaceBayer2(floor(0.25 * mod(v, 8.0))); }
`

const DISSOLVE_BODY = /* glsl */ `
  if ((0.5 + surfaceBayer8(floor(mod(gl_FragCoord.xy, 8.0)))) / 64.0 >= uSurfaceOpacity) discard;
`

function replaceOnce(source: string, from: string, to: string, what: string): string {
  if (!source.includes(from)) throw new Error(`surface scale: ${what} shader has no ${from}`)
  return source.replace(from, to)
}

/**
 * The tile shaders' patch, run after the terrain material's own
 * onBeforeCompile: height and bump on the live scale, and the dissolve.
 * Throws when an anchor is missing (a three or library bump).
 */
export function patchSurfaceShader(
  shader: THREE.WebGLProgramParametersWithUniforms,
  skirtRange: THREE.IUniform<number> = { value: 0 },
  relief: number = RELIEF
): void {
  shader.uniforms.uTerrainScale = terrainScaleUniform
  shader.uniforms.uSurfaceOpacity = surfaceOpacityUniform
  shader.uniforms.uSkirtRange = skirtRange
  shader.vertexShader = replaceOnce(
    'uniform float uTerrainScale;\nuniform float uSkirtRange;\n' + shader.vertexShader,
    '#include <displacementmap_vertex>',
    DISPLACEMENT_VERTEX + skirtLift(relief),
    'vertex'
  )
  // Declared first: the bump chunk reads it, well before main().
  let fragment = 'uniform float uTerrainScale;\n' + shader.fragmentShader
  fragment = replaceOnce(fragment, BUMP_X, `${BUMP_X} uTerrainScale *`, 'fragment')
  fragment = replaceOnce(fragment, BUMP_Y, `${BUMP_Y} uTerrainScale *`, 'fragment')
  fragment = replaceOnce(fragment, 'void main() {', `${DISSOLVE_HEAD}\nvoid main() {\n${DISSOLVE_BODY}`, 'fragment')
  shader.fragmentShader = fragment
}

/**
 * Puts a loaded tile material on the live scale and the handover: metres for
 * the displacement and scene units for the bump (both times uTerrainScale in
 * the shader), the stencil mark, and `extra` patches (the ground haze's
 * surface variant) after the scale's. three's default program cache key
 * (the onBeforeCompile source) stays, so the fade plugin's wrapper keeps its.
 *
 * Why the bump takes SURFACE_SCALE: the terrain material shades with the
 * elevation map's gradient in metres against the surface's screen
 * derivatives in view space, which the group's scale has shrunk to scene
 * units; left in metres, every slope shades ~2e6 times too steep. The
 * displacement stays in metres: it moves vertices in object space, before
 * the group's scale.
 */
export function prepareSurfaceMaterial(
  material: THREE.Material,
  extra: readonly MaterialPatch[] = [],
  skirtRangeMetres: number = 0
): void {
  const m = material as THREE.MeshLambertMaterial
  // Its own uniform: three runs onBeforeCompile per material.
  const skirtRange = { value: skirtRangeMetres }
  m.displacementScale = 1
  m.bumpScale = SURFACE_SCALE
  m.stencilWrite = true
  m.stencilFunc = THREE.AlwaysStencilFunc
  m.stencilRef = SURFACE_STENCIL_REF
  m.stencilZPass = THREE.ReplaceStencilOp
  const own = m.onBeforeCompile
  m.onBeforeCompile = function (shader, renderer) {
    own.call(this, shader, renderer)
    patchSurfaceShader(shader, skirtRange)
    for (const patch of extra) patch.onBeforeCompile(shader, renderer)
  }
}

/**
 * The globe's side of the handover: with the tiles mounted (`on`), it draws
 * only where no tile fragment left SURFACE_STENCIL_REF, writing nothing.
 * Off, the material is left as three made it (production).
 */
export function globeStencil(material: THREE.Material, on: boolean): void {
  if (!on) return
  material.stencilWrite = true
  material.stencilFunc = THREE.NotEqualStencilFunc
  material.stencilRef = SURFACE_STENCIL_REF
  material.stencilWriteMask = 0
}

/**
 * A 3d-tiles-renderer plugin that prepares each tile's materials as the
 * tile parses (processTileModel runs in parseTile, before the load-model
 * event the fade plugin wraps materials at). `extra()` is read per tile.
 */
export function createSurfaceScalePlugin(extra: () => readonly MaterialPatch[] = () => [], relief: number = RELIEF) {
  return {
    name: 'SURFACE_SCALE',
    processTileModel(scene: THREE.Object3D, tile: { geometricError?: number }) {
      const patches = extra()
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.isMesh && mesh.material) {
          const range = surfaceSkirtRange(mesh.geometry, tile?.geometricError ?? 0, relief)
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            prepareSurfaceMaterial(material, patches, range)
          }
        }
      })
    },
  }
}

/** The library's skirted tile geometry, as surfaceSkirtRange() reads it. */
interface SkirtedGeometry {
  surfaceVertexCount?: number
  skirtSourceIndices?: ArrayLike<number>
}

/**
 * A tile's elevation range in metres, recovered from its skirt: the plugin
 * drops each skirt vertex geometricError + range x `relief` below the edge
 * vertex it copies (both on the sphere, height 0). 0 for any other geometry.
 */
export function surfaceSkirtRange(geometry: THREE.BufferGeometry, geometricError: number, relief: number = RELIEF): number {
  const { surfaceVertexCount, skirtSourceIndices } = geometry as THREE.BufferGeometry & SkirtedGeometry
  const position = geometry.getAttribute('position')
  if (!position || !surfaceVertexCount || !skirtSourceIndices?.length) return 0
  const src = skirtSourceIndices[0]
  const dst = surfaceVertexCount
  const depth = Math.hypot(
    position.getX(dst) - position.getX(src),
    position.getY(dst) - position.getY(src),
    position.getZ(dst) - position.getZ(src)
  )
  return Math.max(0, (depth - geometricError) / relief)
}

/**
 * The true elevation (metres above the sphere) at (lat, lon) radians from
 * the finest loaded grid, or null: the plugin's sample is times its
 * heightScale, RELIEF here, not the drawn scale (tides-zmw.9.8 reads this).
 */
export function surfaceElevationMetres(terrain: TerrariumMeshPlugin, lat: number, lon: number): number | null {
  const sample = terrain.sampleCartographicElevation(lat, lon)
  return sample === null ? null : sample / terrain.heightScale
}

/** The ratio between the scales the bounding regions are fitted to. */
export const SURFACE_FIT_STEP = 1.25

/**
 * The scale the tiles' bounding regions are fitted to for a live `scale`:
 * the next power of SURFACE_FIT_STEP up (so at least the drawn scale), at
 * most `relief`, at least 1.
 */
export function surfaceFitScale(scale: number, relief: number = RELIEF): number {
  if (!(scale > 1)) return 1
  const step = SURFACE_FIT_STEP ** Math.ceil(Math.log(scale) / Math.log(SURFACE_FIT_STEP) - 1e-9)
  return Math.min(relief, Math.max(step, scale))
}

/** The terrain plugin's internals fitSurfaceBounds() drives (0.5.3, pinned). */
interface BoundsPluginInternals {
  _heightScale: number
  _updateBoundingVolume(tile: object): void
}

/** The renderer's per-tile view error, run on every tile it traverses. */
interface ViewErrorInternals {
  calculateTileViewError(tile: object, target: object): unknown
}

const FITTED = Symbol('surface fit scale')

export interface SurfaceBounds {
  /** Before tiles.update(): takes this frame's fit from the live scale. */
  update(): void
  /** The scale the regions are fitted to now. */
  readonly fit: number
  /** Tiles refitted so far (the headless checks read it). */
  readonly refits: number
}

/**
 * Fits the tiles' bounding regions to surfaceFitScale(scale()) instead of
 * the plugin's heightScale (RELIEF), which stays for the skirts: every
 * region the plugin writes is written at the fit, and a tile whose region
 * was written at an older fit is refitted when the traversal next reaches it
 * (before its view error, which also culls it).
 */
export function fitSurfaceBounds(tiles: object, terrain: object, scale: () => number): SurfaceBounds {
  const plugin = terrain as BoundsPluginInternals
  const renderer = tiles as ViewErrorInternals
  const write = plugin._updateBoundingVolume
  const view = renderer.calculateTileViewError
  if (typeof write !== 'function' || typeof view !== 'function') {
    throw new Error('surface scale: not the 0.5.3 terrain plugin and renderer')
  }
  let fit = surfaceFitScale(scale())
  let refits = 0
  const refit = (tile: object) => {
    const full = plugin._heightScale
    plugin._heightScale = fit
    try {
      write.call(plugin, tile)
    } finally {
      plugin._heightScale = full
    }
    ;(tile as { [FITTED]?: number })[FITTED] = fit
    refits++
  }
  plugin._updateBoundingVolume = refit
  renderer.calculateTileViewError = function (tile, target) {
    if ((tile as { [FITTED]?: number })[FITTED] !== fit) refit(tile)
    return view.call(this, tile, target)
  }
  return {
    update() {
      fit = surfaceFitScale(scale())
    },
    get fit() {
      return fit
    },
    get refits() {
      return refits
    },
  }
}

