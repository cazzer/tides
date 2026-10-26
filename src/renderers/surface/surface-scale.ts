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
// Bounds. The library's region for a tile spans its lowest to highest
// ground times heightScale. At RELIEF that is no bound for the ground drawn
// at a lower scale: over high ground the region's floor floats above it, km
// up over the canyon at 31 km (2x), and the library culled tiles plainly in
// view, leaving holes the globe filled; the eye inside the tall regions also
// took twice the tiles. So the regions follow the live scale after all,
// lazily and stepwise (fitSurfaceBounds()): each spans the ground at every
// scale across a band of SURFACE_FIT_SLACK steps of SURFACE_FIT_STEP under
// the fit, refitted when the traversal next visits a tile after the band
// moves, which a descent from 12x to 1x does about six times, level flight
// never.
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
//
// Holes as windows: any tile fragment marks the stencil, so a far tile seen
// through a near hole would take the pixel from the nearer globe. The tiles'
// skirts close nearly all of that: a ray that passes under the hole's globe
// surface into a neighbouring tile meets that tile's skirt, which hangs
// below its lowest ground (geometricError + range x scale under its edge).
// Only where the globe stands above a tile's edge (its smoothed valleys) can
// a ray slip over the edge and under the globe: a sliver at the hole's far
// side no deeper than the DEM mismatch. Headless (a near z11 tile failed at
// pitch -30, and on the south rim looking into the canyon), with the globe
// hidden the hole stays black: no far tile shows through.
import * as THREE from 'three'
import type { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { surfaceOpacityUniform, TERRAIN_SCALE_UNIFORM_GLSL, terrainScaleUniform } from '../../terrain-scale'
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

// First thing in main(), unlike the fade plugin's (after dithering): the
// GLSL ES 3.00 rule leaves the bump's screen derivatives undefined in quads
// a discard splits, but GPUs run discarded fragments on as helpers, and the
// band's headless frames show no seams; the late discard cost +0.43 ms a
// scene render at half opacity (960x600, 1.59 vs 1.16 ms), and one after
// normal_fragment_maps saved nothing. Only within the band: at full opacity
// nothing is discarded.
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
    TERRAIN_SCALE_UNIFORM_GLSL + 'uniform float uSkirtRange;\n' + shader.vertexShader,
    '#include <displacementmap_vertex>',
    DISPLACEMENT_VERTEX + skirtLift(relief),
    'vertex'
  )
  // Declared first: the bump chunk reads it, well before main().
  let fragment = TERRAIN_SCALE_UNIFORM_GLSL + shader.fragmentShader
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
  // Bound to the material by hand: the fade plugin's wrapper
  // (wrapFadeMaterial.js) calls the onBeforeCompile it wraps unbound, and
  // without the renderer.
  const own = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    own.call(m, shader, renderer)
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

/** The fit steps down only once the live scale is this many steps under it
 * (hysteresis: level flight across a step boundary refits nothing). */
export const SURFACE_FIT_SLACK = 2

/**
 * The scale the tiles' bounding regions are fitted up to for a live `scale`:
 * the next power of SURFACE_FIT_STEP up (so at least the drawn scale), at
 * most `relief`, at least 1.
 */
export function surfaceFitScale(scale: number, relief: number = RELIEF): number {
  if (!(scale > 1)) return 1
  const step = SURFACE_FIT_STEP ** Math.ceil(Math.log(scale) / Math.log(SURFACE_FIT_STEP) - 1e-9)
  return Math.min(relief, Math.max(step, scale))
}

/**
 * The next fit for a live `scale` from the current `fit`: up at once when
 * the scale passes it, down only when the scale falls SURFACE_FIT_SLACK
 * steps under it, or one step where that would be under 1x, which the live
 * scale never is (else a fit near the ground, 1.5625 after a climb to
 * ~20 km, could never come down). The regions cover every scale in
 * [surfaceFitFloor(fit), fit].
 */
export function nextSurfaceFit(fit: number, scale: number, relief: number = RELIEF): number {
  const slack = fit / SURFACE_FIT_STEP ** SURFACE_FIT_SLACK
  const down = slack > 1 ? slack : fit / SURFACE_FIT_STEP
  if (scale > fit || scale < down) return surfaceFitScale(scale, relief)
  return fit
}

/** The lowest scale the regions fitted at `fit` cover. */
export function surfaceFitFloor(fit: number): number {
  return Math.max(1, fit / SURFACE_FIT_STEP ** SURFACE_FIT_SLACK)
}

/** The terrain plugin's internals fitSurfaceBounds() drives (0.5.3, pinned). */
interface BoundsPluginInternals {
  _heightScale: number
  _updateBoundingVolume(tile: object): void
  tiles: { ellipsoid: unknown } | null
}

/** A tile's region and engine volume, as the plugin writes them. */
interface RegionTile {
  boundingVolume: { region?: number[] }
  engineData?: { boundingVolume?: { setRegionData(ellipsoid: unknown, ...region: number[]): void } }
}

/** The renderer's per-tile view error, run on every tile it traverses. */
interface ViewErrorInternals {
  calculateTileViewError(tile: object, target: object): unknown
}

const FITTED = Symbol('surface fit scale')

export interface SurfaceBounds {
  /** Before tiles.update(): takes this frame's fit from the live scale. */
  update(): void
  /** The scale the regions are fitted up to now. */
  readonly fit: number
  /** Tiles refitted so far (the headless checks read it). */
  readonly refits: number
}

/**
 * Fits the tiles' bounding regions to the live scale (scale()) instead of
 * the plugin's heightScale (RELIEF), which stays for the skirts. A region
 * at one scale doesn't hold the ground at another: its floor is the tile's
 * lowest ground times the scale, so at RELIEF it floated over the ground
 * drawn at ~2x (km up, over the canyon at 31 km), and the library culled
 * tiles in view, leaving holes. So each region spans the ground at every
 * scale from surfaceFitFloor(fit) to fit (the plugin's region written at
 * both ends, merged), every region the plugin writes is written that way,
 * and a tile written at an older fit is refitted when the traversal next
 * reaches it, before its view error, which also culls it.
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
  const writeAt = (tile: object, at: number) => {
    const full = plugin._heightScale
    plugin._heightScale = at
    try {
      write.call(plugin, tile)
    } finally {
      plugin._heightScale = full
    }
  }
  const refit = (tile: object) => {
    const { boundingVolume, engineData } = tile as RegionTile
    const region = boundingVolume?.region
    const floor = surfaceFitFloor(fit)
    // The band covers region tiles (the ellipsoid projection's, all of
    // them here); a box tile would be written at the fit alone.
    if (region && floor < fit) {
      writeAt(tile, floor)
      const [low, high] = [region[4], region[5]]
      writeAt(tile, fit)
      if (low < region[4] || high > region[5]) {
        region[4] = Math.min(low, region[4])
        region[5] = Math.max(high, region[5])
        const [w, s, e, n, min, max] = region
        engineData?.boundingVolume?.setRegionData(plugin.tiles?.ellipsoid, w, s, e, n, min, max)
      }
    } else {
      writeAt(tile, fit)
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
      fit = nextSurfaceFit(fit, scale())
    },
    get fit() {
      return fit
    },
    get refits() {
      return refits
    },
  }
}
