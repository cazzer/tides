// The streamed tiles at the page's relief, and their handover from the
// globe (tides-zmw.9.7).
//
// Scale. 3d-tiles-renderer 0.5.3's terrain plugin doesn't bake height into
// the tiles' vertices: every surface vertex sits on the ellipsoid at height
// 0 (with the sphere's normal), and the GPU displaces it by the material's
// displacementMap (the elevation grid, metres) times displacementScale (the
// plugin's heightScale); the bump shading reads the same grid. The plugin
// is built at the page's RELIEF (../../relief.ts, a constant, the globe's
// too: true scale by default), so its skirts and bounding regions are the
// ground as drawn. Each tile material (prepareSurfaceMaterial, from the
// tile-material composer's processTileModel plugin, tile-material.ts,
// before the fade plugin wraps it at load-model) keeps displacementScale
// at RELIEF (metres) and takes bumpScale SURFACE_SCALE times RELIEF (metres
// to scene units, see surface-frame.ts). Until tides-zmw.21 the tiles
// followed the globe's live terrain scale (an altitude blend), through a
// uniform, refitted regions and lifted skirts; at a constant scale none of
// that is needed.
//
// Handover, by stencil. The tiles draw first (their group's renderOrder -1)
// and mark every pixel they draw (stencil ref 1); the globe, when the tiles
// are mounted, draws only where the stencil isn't 1 (globeStencil()). So each
// pixel is tile or globe, never both: no z-fighting at any scale or DEM
// mismatch, and the globe still draws wherever no tile landed (not loaded
// yet, failed, or above the handover). Over the handover's last 40 km
// (../../surface-handover.ts) the tiles dissolve out on an 8x8 Bayer
// screen-door (surfaceOpacityUniform); a discarded fragment writes no
// stencil, so the globe fills it. Not the fade
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
// below its lowest ground (geometricError + range x RELIEF under its edge).
// Only where the globe stands above a tile's edge (its smoothed valleys) can
// a ray slip over the edge and under the globe: a sliver at the hole's far
// side no deeper than the DEM mismatch. Headless (a near z11 tile failed at
// pitch -30, and on the south rim looking into the canyon), with the globe
// hidden the hole stays black: no far tile shows through.
import * as THREE from 'three'
import type { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { surfaceOpacityUniform } from '../../surface-handover'
import type { MaterialPatch } from '../eclipseShadow'
import { RELIEF } from '../../relief'
import { SURFACE_SCALE } from './surface-frame'

/** The stencil value a tile fragment leaves, which hides the globe there. */
export const SURFACE_STENCIL_REF = 1

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
 * onBeforeCompile: the dissolve. Throws when its anchor is missing (a three
 * bump).
 */
export function patchSurfaceShader(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uSurfaceOpacity = surfaceOpacityUniform
  shader.fragmentShader = replaceOnce(shader.fragmentShader, 'void main() {', `${DISSOLVE_HEAD}\nvoid main() {\n${DISSOLVE_BODY}`, 'fragment')
}

/**
 * Puts a loaded tile material at `relief` (the page's) and on the handover:
 * metres times the relief for the displacement and scene units times it for
 * the bump, the stencil mark, and `extra` patches (the tile-material
 * composer's base and features, tides-zmw.9.16) after the dissolve's. The
 * program cache key is the caller's (the composer sets one per tileset).
 *
 * Why the bump takes SURFACE_SCALE: the terrain material shades with the
 * elevation map's gradient in metres against the surface's screen
 * derivatives in view space, which the group's scale has shrunk to scene
 * units; left in metres, every slope shades ~2e6 times too steep. The
 * displacement stays in metres: it moves vertices in object space, before
 * the group's scale.
 */
export function prepareSurfaceMaterial(material: THREE.Material, extra: readonly MaterialPatch[] = [], relief: number = RELIEF): void {
  const m = material as THREE.MeshLambertMaterial
  m.displacementScale = relief
  m.bumpScale = SURFACE_SCALE * relief
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
    patchSurfaceShader(shader)
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
 * The true elevation (metres above the sphere) at (lat, lon) radians from
 * the finest loaded grid, or null: the plugin's sample is times its
 * heightScale, RELIEF here (tides-zmw.9.8 reads this).
 */
export function surfaceElevationMetres(terrain: TerrariumMeshPlugin, lat: number, lon: number): number | null {
  const sample = terrain.sampleCartographicElevation(lat, lon)
  return sample === null ? null : sample / terrain.heightScale
}
