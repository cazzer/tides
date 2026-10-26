// The Moon's shadow on the streamed tiles (tides-zmw.9.16): the globe's
// eclipse patch (../eclipseShadow.ts ECLIPSE_GLSL) on the tiles' frame, per
// fragment as on the globe, on the same uniforms (the eclipse EarthRenderer
// updates each frame) and off outside an eclipse (uEclipseActive).
//
// The globe finds each vertex's point on the ellipsoid from its direction
// in the ground mesh's frame (position) and turns it into the scene's axes
// by the ground's world rotation, mat3(modelMatrix) over its scale. The
// tiles' direction in that frame is the base's surfaceUp, and the ground's
// world rotation is the base's surfaceWorldFromGround() (a tile's own
// modelMatrix carries the tiles' group's R_x(-90°) and SURFACE_SCALE, and
// isn't in a fragment shader): so the point's line is renamed to them, and
// eclipseSunlight() runs on it in the fragment, where the globe passes the
// point through a varying. The shading is the globe's, after
// lights_fragment_end.
//
// Cost (headless burst, same tiles in one page, 1080p): outside an eclipse
// +0.09 ms at the canyon stop, of which ~0.05 is the base's surfaceUp,
// which the other features read too; during one, +0.4 ms (the shadow's
// trigonometry per tile pixel, as the globe pays per globe pixel). The
// whole shadow per vertex would cost a flat +0.11 to +0.12 ms, eclipse or
// not (a tile has many vertices, and the varying is written per vertex);
// the globe's own way, a varying point, +0.13 ms outside an eclipse.
import { ECLIPSE_GLSL } from '../eclipseShadow'
import { injectAfterChunk, renameInSnippet, surfaceInject, type TileAdapter } from './tile-material'

const WHAT = 'tile eclipse'

// The globe's heads without its varying: eclipsePoint() on the ground's
// world rotation, then the shading's uniforms and functions.
const FRAGMENT_HEAD = `${renameInSnippet(
  renameInSnippet(ECLIPSE_GLSL.vertexHead, 'varying vec3 vEclipsePoint;', '', WHAT),
  'mat3(modelMatrix) * eclipseP / length(modelMatrix[0].xyz)',
  'surfaceWorldFromGround() * eclipseP',
  WHAT
)}
${renameInSnippet(ECLIPSE_GLSL.fragmentHead, 'varying vec3 vEclipsePoint;', '', WHAT)}`

const FRAGMENT_LIGHT = renameInSnippet(
  ECLIPSE_GLSL.fragmentLight,
  'eclipseSunlight(vEclipsePoint)',
  'eclipseSunlight(eclipsePoint(surfaceUp))',
  WHAT
)

/** The adapter's GLSL (the test checks it against the globe's). */
export const TILE_ECLIPSE_GLSL = { fragmentHead: FRAGMENT_HEAD, fragmentLight: FRAGMENT_LIGHT }

export const tileEclipse: TileAdapter = (link) => ({
  patch: {
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, link.eclipse)
      shader.fragmentShader = injectAfterChunk(
        surfaceInject(shader.fragmentShader, 'fragmentHead', FRAGMENT_HEAD),
        'lights_fragment_end',
        FRAGMENT_LIGHT,
        WHAT
      )
    },
    customProgramCacheKey: () => 'eclipse-surface',
  },
})
